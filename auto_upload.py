#!/usr/bin/env python
"""Watch torrent folder for new video files and auto-upload to Google Drive."""

import os
import json
import time
import sys
from pathlib import Path

from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

load_dotenv()

DRIVE_FOLDER_ID = os.environ['DRIVE_FOLDER_ID']
SCOPES = ['https://www.googleapis.com/auth/drive.file']
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.avi', '.webm', '.mov', '.wmv', '.flv', '.m4v', '.ts', '.m2ts'}
MIN_SIZE_MB = 50
MIN_SIZE_BYTES = MIN_SIZE_MB * 1024 * 1024
CHUNK_SIZE = 10 * 1024 * 1024  # 10 MB
WATCH_DIR = str(Path(__file__).parent.resolve())


def _get_drive():
    key_raw = os.environ['GOOGLE_SA_KEY']
    if '\\n' in key_raw:
        key_raw = key_raw.replace('\\n', '\n')

    info = {
        'type': 'service_account',
        'project_id': os.environ.get('GOOGLE_PROJECT_ID', 'yoga-worker'),
        'private_key_id': '',
        'private_key': key_raw,
        'client_email': os.environ['GOOGLE_SA_EMAIL'],
        'client_id': '',
        'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
        'token_uri': 'https://oauth2.googleapis.com/token',
        'auth_provider_x509_cert_url': 'https://www.googleapis.com/oauth2/v1/certs',
        'client_x509_cert_url': f"https://www.googleapis.com/robot/v1/metadata/x509/{os.environ['GOOGLE_SA_EMAIL']}",
    }
    creds = service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    return build('drive', 'v3', credentials=creds)


def find_or_create_folder(service, name, parent_id):
    escaped = name.replace("'", "\\'")
    q = f"'{parent_id}' in parents and name='{escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    resp = service.files().list(q=q, fields='files(id)', pageSize=1).execute()
    files = resp.get('files', [])
    if files:
        return files[0]['id']

    meta = {'name': name, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent_id]}
    folder = service.files().create(body=meta, fields='id').execute()
    return folder['id']


def upload_file(service, file_path, parent_id):
    """Upload a single file to Drive with resumable upload."""
    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    media = MediaFileUpload(
        file_path,
        mimetype='application/octet-stream',
        resumable=True,
        chunksize=CHUNK_SIZE,
    )

    meta = {'name': file_name, 'parents': [parent_id]}
    request = service.files().create(body=meta, media_body=media, fields='id')

    response = None
    last_progress = 0
    print(f'      Uploading {file_name} ({file_size / (1024*1024):.0f} MB)...')

    while response is None:
        result = request.next_chunk(num_retries=5)
        if isinstance(result, tuple) and len(result) == 2:
            status, resp = result
            if status and hasattr(status, 'resumable_progress'):
                pct = int(status.resumable_progress / file_size * 100)
                if pct > last_progress + 9:
                    print(f'      {pct}%...')
                    last_progress = pct
            if resp:
                response = resp
        elif result is not None:
            response = result

    file_id = response['id']

    # Make publicly accessible
    service.permissions().create(
        fileId=file_id,
        body={'type': 'anyone', 'role': 'reader'},
        fields='id',
    ).execute()

    print(f'      Done! file_id={file_id}')
    return file_id


class TorrentWatcher(FileSystemEventHandler):
    def __init__(self, base_dir, cache_file, service, drive_root):
        self.base_dir = Path(base_dir)
        self.cache_file = cache_file
        self.service = service
        self.drive_root = drive_root

        # Load upload cache
        self.cache = {}
        if cache_file.exists():
            self.cache = json.loads(cache_file.read_text())

        # Track uploaded files to avoid duplicate uploads
        self.uploaded = set(self.cache.keys())
        # Also track files being uploaded (to avoid double-triggering)
        self.uploading = set()

    def _is_video(self, file_path):
        p = Path(file_path)
        return (p.suffix.lower() in VIDEO_EXTENSIONS and
                not p.name.startswith('.') and
                p.stat().st_size >= MIN_SIZE_BYTES)

    def _save_cache(self):
        self.cache_file.write_text(json.dumps(self.cache, indent=2))

    def on_created(self, event):
        if event.is_directory:
            return

        file_path = event.src_path
        file_key = str(Path(file_path).relative_to(self.base_dir))

        if not self._is_video(file_path):
            return
        if file_key in self.uploaded or file_key in self.uploading:
            return

        # Wait for file to stabilize (e.g., still downloading from torrent)
        self._wait_for_stable(file_path)

        # Check again after waiting
        if file_key in self.uploaded:
            return
        if not os.path.isfile(file_path) or os.path.getsize(file_path) < MIN_SIZE_BYTES:
            return

        self.uploading.add(file_key)

        try:
            folder_name = Path(file_path).parent.name
            if Path(file_path).parent.resolve() == self.base_dir:
                folder_name = ''

            target = self.drive_root
            if folder_name:
                target = find_or_create_folder(self.service, folder_name, self.drive_root)

            file_id = upload_file(self.service, file_path, target)
            self.cache[file_key] = file_id
            self.uploaded.add(file_key)
            self._save_cache()

            print(f'  [{time.strftime("%H:%M:%S")}] Uploaded: {file_key}')
        except Exception as e:
            print(f'  ERROR: {file_key}: {e}')
        finally:
            self.uploading.discard(file_key)

    def _wait_for_stable(self, file_path, stable_secs=3):
        """Wait for file size to remain unchanged for <stable_secs> seconds."""
        last_size = -1
        while True:
            try:
                current_size = os.path.getsize(file_path)
                if current_size == last_size and current_size > 0:
                    time.sleep(stable_secs)
                    # Verify once more
                    if os.path.getsize(file_path) == current_size:
                        return
                last_size = current_size
                time.sleep(2)
            except OSError:
                time.sleep(2)


def main():
    print(f'KittipanHub Auto Upload v1.0')
    print(f'Watching: {WATCH_DIR}')
    print(f'Drive    : {DRIVE_FOLDER_ID}')
    print(f'Min size : {MIN_SIZE_MB} MB')
    print()

    cache_file = Path(WATCH_DIR) / '.upload_cache.json'
    service = _get_drive()

    handler = TorrentWatcher(WATCH_DIR, cache_file, service, DRIVE_FOLDER_ID)
    observer = Observer()
    observer.schedule(handler, WATCH_DIR, recursive=True)
    observer.start()

    print('Watching for new files... (Ctrl+C to stop)')
    print()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print('\nStopped.')
        observer.stop()

    observer.join()


if __name__ == '__main__':
    main()
