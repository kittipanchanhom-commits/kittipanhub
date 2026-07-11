#!/usr/bin/env python
"""Live upload GUI — shows progress with queue, uploads to Google Drive."""

import os, json, re, threading, time, sys
from pathlib import Path

from googleapiclient.errors import HttpError
from datetime import datetime

from dotenv import load_dotenv
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from flask import Flask, render_template, jsonify

load_dotenv()

app = Flask(__name__)

DRIVE_FOLDER_ID = os.environ['DRIVE_FOLDER_ID']
SCOPES = ['https://www.googleapis.com/auth/drive.file']
VIDEO_EXT = {'.mp4','.mkv','.avi','.webm','.mov','.wmv','.flv','.m4v','.ts','.m2ts'}
MIN_SIZE = 50 * 1024 * 1024
WATCH_DIR = Path(__file__).parent.resolve()
CACHE_FILE = WATCH_DIR / '.upload_cache.json'
STATUS_FILE = WATCH_DIR / '.upload_status.json'

# ── State ──
state = {
    'running': False,
    'queue': [],
    'current': None,       # {name, size_mb, progress_pct, speed_mbps, elapsed_s}
    'completed': [],       # [{name, file_id, size_mb}]
    'failed': [],          # [{name, error}]
    'started': None,
    'total_mb': 0,
    'uploaded_mb': 0,
}
_state_lock = threading.Lock()


def save_state():
    with _state_lock:
        s = dict(state)
        s.pop('_cond', None)
        STATUS_FILE.write_text(json.dumps(s, default=str, indent=2))


# ── Drive ──
def _get_drive():
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


# ── Upload Worker ──
def upload_worker():
    service = _get_drive()
    cache = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}

    with _state_lock:
        state['running'] = True
        state['started'] = datetime.now().isoformat()

    for item in state['queue']:
        if not state['running']:
            break

        abs_path = str(WATCH_DIR / item['rel_path'])
        if not os.path.isfile(abs_path):
            item['status'] = 'failed'
            item['error'] = 'File not found'
            continue

        item['status'] = 'uploading'
        with _state_lock:
            state['current'] = item

        try:
            folder_name = Path(abs_path).parent.name
            if Path(abs_path).parent.resolve() == WATCH_DIR:
                folder_name = ''
            target = DRIVE_FOLDER_ID
            if folder_name:
                target = find_or_create_folder(service, folder_name, DRIVE_FOLDER_ID)

            file_size = os.path.getsize(abs_path)
            media = MediaFileUpload(abs_path, mimetype='application/octet-stream', resumable=True, chunksize=10*1024*1024)
            meta = {'name': os.path.basename(abs_path), 'parents': [target]}
            request = service.files().create(body=meta, media_body=media, fields='id')

            response = None
            last_pct = 0
            t0 = time.time()

            while response is None and state['running']:
                result = request.next_chunk(num_retries=3)
                if isinstance(result, tuple) and len(result) == 2:
                    status, resp = result
                    if status and hasattr(status, 'resumable_progress'):
                        pct = int(status.resumable_progress / file_size * 100)
                        elapsed = time.time() - t0
                        speed = (status.resumable_progress / (1024*1024)) / elapsed if elapsed > 0 else 0
                        with _state_lock:
                            s = state['current']
                            if s:
                                s['progress_pct'] = pct
                                s['speed_mbps'] = round(speed, 1)
                                s['elapsed_s'] = int(elapsed)
                                s['uploaded_mb'] = round(status.resumable_progress / (1024*1024), 1)
                    if resp:
                        response = resp
                elif result is not None:
                    response = result

            if not state['running']:
                item['status'] = 'paused'
                save_state()
                return

            file_id = response['id']
            drive_execute(service.permissions().create(fileId=file_id, body={'type': 'anyone', 'role': 'reader'}, fields='id'))

            cache[item['rel_path']] = file_id
            CACHE_FILE.write_text(json.dumps(cache, indent=2))

            item['status'] = 'done'
            item['file_id'] = file_id
            with _state_lock:
                state['completed'].append({
                    'name': item['name'], 'file_id': file_id,
                    'size_mb': item['size_mb'],
                })
                state['uploaded_mb'] += item['size_mb']
                state['current'] = None
            save_state()

        except Exception as e:
            item['status'] = 'failed'
            item['error'] = str(e)
            with _state_lock:
                state['failed'].append({'name': item['name'], 'error': str(e)})
                state['current'] = None
            save_state()

    with _state_lock:
        state['running'] = False
        state['current'] = None
    save_state()


def scan_videos():
    videos = []
    for entry in sorted(WATCH_DIR.iterdir(), key=lambda e: e.name.lower()):
        if entry.name.startswith('.'):
            continue
        if entry.is_file() and entry.suffix.lower() in VIDEO_EXT and entry.stat().st_size >= MIN_SIZE:
            videos.append((entry, ''))
        elif entry.is_dir():
            for sub in sorted(entry.iterdir(), key=lambda e: e.name.lower()):
                if sub.is_file() and sub.suffix.lower() in VIDEO_EXT and sub.stat().st_size >= MIN_SIZE:
                    videos.append((sub, entry.name))
    return videos


# ── Routes ──

@app.route('/')
def index():
    return render_template('upload_gui.html')


@app.route('/api/status')
def api_status():
    with _state_lock:
        s = dict(state)
        s.pop('_cond', None)
    return jsonify(s)


@app.route('/api/start', methods=['POST'])
def api_start():
    if state['running']:
        return jsonify({'ok': False, 'msg': 'Already running'})

    cache = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}
    videos = scan_videos()
    queue = []

    for entry, folder_name in videos:
        rel = str(entry.relative_to(WATCH_DIR))
        if rel in cache:
            continue
        queue.append({
            'rel_path': rel,
            'name': entry.name,
            'folder': folder_name,
            'size_mb': round(entry.stat().st_size / (1024*1024)),
            'status': 'pending',
        })

    with _state_lock:
        state['queue'] = queue
        state['completed'] = []
        state['failed'] = []
        state['total_mb'] = sum(q['size_mb'] for q in queue)

    threading.Thread(target=upload_worker, daemon=True).start()
    return jsonify({'ok': True, 'count': len(queue)})


@app.route('/api/stop', methods=['POST'])
def api_stop():
    with _state_lock:
        state['running'] = False
    return jsonify({'ok': True})


if __name__ == '__main__':
    port = 5001
    print(f'\n  Upload GUI → http://localhost:{port}')
    app.run(host='127.0.0.1', port=port, debug=False)
