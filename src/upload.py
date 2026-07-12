#!/usr/bin/env python
"""Upload torrent videos to Google Drive with resumable upload + progress."""

import os, json, argparse, time
from pathlib import Path

from googleapiclient.errors import HttpError

from dotenv import load_dotenv
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from tqdm import tqdm

load_dotenv()

DRIVE_FOLDER_ID = os.environ['DRIVE_FOLDER_ID']
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.flv', '.m4v', '.ts', '.m2ts'}
MIN_SIZE_MB = 50
MIN_SIZE_BYTES = MIN_SIZE_MB * 1024 * 1024


def get_drive_service():
    """Build authenticated Google Drive service from OAuth refresh token."""
    from google.oauth2.credentials import Credentials
    creds = Credentials(
        None,
        refresh_token=os.environ['GOOGLE_REFRESH_TOKEN'],
        token_uri='https://oauth2.googleapis.com/token',
        client_id=os.environ['GOOGLE_CLIENT_ID'],
        client_secret=os.environ['GOOGLE_CLIENT_SECRET'],
    )
    return build('drive', 'v3', credentials=creds)


def drive_execute(request, max_retries=3):
    """Execute Drive API request with exponential backoff on rate limits."""
    for attempt in range(max_retries + 1):
        try:
            return request.execute()
        except HttpError as e:
            if e.resp.status == 429 and attempt < max_retries:
                wait = min(2 ** attempt, 8)
                print(f'  Rate limited, retry in {wait}s...')
                time.sleep(wait)
                continue
            raise


def find_or_create_folder(service, name, parent_id):
    escaped = name.replace("'", "\\'")
    q = f"'{parent_id}' in parents and name='{escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    resp = drive_execute(service.files().list(q=q, fields='files(id)', pageSize=1))
    if resp.get('files'):
        return resp['files'][0]['id']
    meta = {'name': name, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent_id]}
    return drive_execute(service.files().create(body=meta, fields='id'))['id']


def file_exists_in_drive(service, name, parent_id):
    escaped = name.replace("'", "\\'")
    q = f"'{parent_id}' in parents and name='{escaped}' and trashed=false"
    resp = drive_execute(service.files().list(q=q, fields='files(id,size)', pageSize=1))
    files = resp.get('files', [])
    return files[0] if files else None


def upload_file(service, file_path, parent_id):
    """Upload a single video file to Drive with resumable upload + progress."""
    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    media = MediaFileUpload(
        file_path,
        mimetype='application/octet-stream',
        resumable=True,
        chunksize=5 * 1024 * 1024,  # 5 MB chunks
    )

    meta = {'name': file_name, 'parents': [parent_id]}
    request = service.files().create(body=meta, media_body=media, fields='id')

    response = None
    last_progress = 0

    with tqdm(total=file_size, unit='B', unit_scale=True, desc=file_name[:55]) as pbar:
        while response is None:
            result = request.next_chunk(num_retries=5)

            # next_chunk() returns (status, response) — undocumented variation:
            #   status = MediaUploadProgress  or None
            #   response = file metadata dict or None
            if isinstance(result, tuple) and len(result) == 2:
                status, resp = result
                if status and hasattr(status, 'resumable_progress'):
                    delta = status.resumable_progress - last_progress
                    if delta > 0:
                        pbar.update(delta)
                        last_progress = status.resumable_progress
                if resp:
                    response = resp
            elif result is not None:
                # Single value returned — upload complete
                response = result

    file_id = response['id']

    # Make file publicly accessible for direct browser / VLC streaming
    drive_execute(service.permissions().create(
        fileId=file_id,
        body={'type': 'anyone', 'role': 'reader'},
        fields='id',
    ))

    return file_id


def main():
    parser = argparse.ArgumentParser(description='Upload torrent videos to Google Drive')
    parser.add_argument(
        '--folder', default=os.path.dirname(__file__) or '.',
        help='Root torrent folder to scan (default: script directory)',
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='List files that would be uploaded, then exit',
    )
    parser.add_argument(
        '--min-size', type=int, default=MIN_SIZE_MB,
        help=f'Minimum file size in MB (default: {MIN_SIZE_MB})',
    )
    args = parser.parse_args()

    base_dir = Path(args.folder).resolve()
    min_bytes = args.min_size * 1024 * 1024
    cache_file = base_dir / '.upload_cache.json'

    print(f'Root folder : {base_dir}')
    print(f'Drive target: {DRIVE_FOLDER_ID}')
    print(f'Min size    : {args.min_size} MB')
    print()

    # Load cache (maps relative path → Drive file id)
    cache = {}
    if cache_file.exists():
        cache = json.loads(cache_file.read_text())
        print(f'Cache loaded: {len(cache)} entries')

    service = get_drive_service()

    # Collect video files
    videos = []
    for entry in sorted(base_dir.iterdir(), key=lambda e: e.name.lower()):
        if entry.name.startswith('.'):
            continue
        if entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
            if entry.stat().st_size >= min_bytes:
                videos.append((entry, ''))
        elif entry.is_dir():
            for sub in sorted(entry.iterdir(), key=lambda e: e.name.lower()):
                if sub.is_file() and sub.suffix.lower() in VIDEO_EXTENSIONS and sub.stat().st_size >= min_bytes:
                    videos.append((sub, entry.name))

    print(f'Videos found: {len(videos)}')
    total_size = sum(f.stat().st_size for f, _ in videos)
    print(f'Total size  : {total_size / (1024**3):.1f} GB')
    print()

    if args.dry_run:
        for f, folder in videos:
            print(f'  {folder + "/" if folder else ""}{f.name}  ({f.stat().st_size / (1024**2):.0f} MB)')
        return

    # Upload
    for i, (file_path, folder_name) in enumerate(videos):
        cache_key = str(file_path.relative_to(base_dir))

        # 1) Check local cache
        if cache_key in cache:
            cached_id = cache[cache_key]
            try:
                drive_execute(service.files().get(fileId=cached_id, fields='id'))
                print(f'[{i+1}/{len(videos)}] SKIP (cached) {file_path.name}')
                continue
            except Exception:
                del cache[cache_key]

        # 2) Find/create target Drive subfolder
        target_folder = DRIVE_FOLDER_ID
        if folder_name:
            target_folder = find_or_create_folder(service, folder_name, DRIVE_FOLDER_ID)

        # 3) Check if file already in Drive by name
        existing = file_exists_in_drive(service, file_path.name, target_folder)
        if existing:
            cache[cache_key] = existing['id']
            cache_file.write_text(json.dumps(cache, indent=2))
            print(f'[{i+1}/{len(videos)}] SKIP (Drive) {file_path.name}')
            continue

        # 4) Upload
        size_mb = file_path.stat().st_size / (1024 * 1024)
        msg = f'[{i+1}/{len(videos)}] UPLOAD {file_path.name} ({size_mb:.0f} MB)'
        print(msg)
        print('-' * min(len(msg), 80))

        try:
            file_id = upload_file(service, str(file_path), target_folder)
            cache[cache_key] = file_id
            cache_file.write_text(json.dumps(cache, indent=2))
            print()
        except KeyboardInterrupt:
            print('\nInterrupted. Progress saved.')
            break
        except Exception as e:
            print(f'\n  ERROR: {e}')
            print('  Skipping this file. Continue? (press Ctrl+C to stop)')

    print(f'\nDone! {len(cache)} files tracked in {cache_file.name}')


if __name__ == '__main__':
    main()
