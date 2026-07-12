import os
import json
import re
import secrets
import subprocess
import time
import webbrowser
from pathlib import Path

from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build
from flask import Flask, render_template, request, jsonify, abort, redirect

load_dotenv()

app = Flask(__name__)

# ── Config ──────────────────────────────────────────────────────────────
SERVER_TOKEN = os.environ.get('TOKEN') or secrets.token_urlsafe(32)
DRIVE_FOLDER_ID = os.environ.get('DRIVE_FOLDER_ID', '')
DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
MIN_SIZE_MB = 50
MIN_SIZE_BYTES = MIN_SIZE_MB * 1024 * 1024

# ── Token Auth ──────────────────────────────────────────────────────────
@app.before_request
def _check_token():
    if not request.path.startswith('/api/'):
        return
    token = request.headers.get('X-API-Token') or request.args.get('token', '')
    if token != SERVER_TOKEN:
        return jsonify({'error': 'Unauthorized'}), 403

# ── VLC Detection ───────────────────────────────────────────────────────
VLC_PATH = None
for candidate in [
    r'C:\Program Files\VideoLAN\VLC\vlc.exe',
    r'C:\Program Files (x86)\VideoLAN\VLC\vlc.exe',
]:
    if os.path.isfile(candidate):
        VLC_PATH = candidate
        break

if not VLC_PATH:
    try:
        result = subprocess.run(['where', 'vlc'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            VLC_PATH = result.stdout.strip().split('\n')[0]
    except Exception:
        pass

# ── Drive API ───────────────────────────────────────────────────────────
_drive_service = None


def _get_drive():
    global _drive_service
    if _drive_service is not None:
        return _drive_service  # may be False if not configured

    email = os.environ.get('GOOGLE_SA_EMAIL', '')
    key = os.environ.get('GOOGLE_SA_KEY', '')
    if not email or not key or 'xxx' in email or 'replace-me' in key:
        _drive_service = False
        return False

    key_raw = os.environ.get('GOOGLE_SA_KEY', '')
    if '\\n' in key_raw:
        key_raw = key_raw.replace('\\n', '\n')

    info = {
        'type': 'service_account',
        'project_id': os.environ.get('GOOGLE_PROJECT_ID', 'yoga-worker'),
        'private_key_id': '',
        'private_key': key_raw,
        'client_email': os.environ.get('GOOGLE_SA_EMAIL', ''),
        'client_id': '',
        'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
        'token_uri': 'https://oauth2.googleapis.com/token',
        'auth_provider_x509_cert_url': 'https://www.googleapis.com/oauth2/v1/certs',
        'client_x509_cert_url':
            f"https://www.googleapis.com/robot/v1/metadata/x509/{os.environ.get('GOOGLE_SA_EMAIL', '')}",
    }
    creds = service_account.Credentials.from_service_account_info(info, scopes=DRIVE_SCOPES)
    _drive_service = build('drive', 'v3', credentials=creds)
    return _drive_service


def _fmt_size(size_bytes):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024:
            return f'{size_bytes:.1f} {unit}'
        size_bytes /= 1024
    return f'{size_bytes:.1f} PB'


# ── Category Detection ──────────────────────────────────────────────────
JAV_PTN = re.compile(r'^[A-Z]+-\d{3,4}$')
SERIES_PTN = re.compile(r'[Ss]\d{2}[Ee]\d{2}')


def _category(filename, folder):
    if folder and JAV_PTN.match(folder):
        return 'jav'
    if SERIES_PTN.search(filename):
        return 'series'
    return 'movie'


# ── File Listing ────────────────────────────────────────────────────────
def _list_folder(service, parent_id, folder_name):
    """List non-folder files inside a Drive subfolder."""
    videos = []
    page_token = None
    while True:
        q = f"'{parent_id}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'"
        resp = service.files().list(
            q=q, fields='files(id,name,size,createdTime),nextPageToken',
            pageSize=1000, pageToken=page_token,
        ).execute()
        for f in resp.get('files', []):
            size_bytes = int(f.get('size', 0))
            if size_bytes < MIN_SIZE_BYTES:
                continue
            file_id = f['id']
            name = f['name']
            stem = Path(name).stem
            ext = Path(name).suffix.lstrip('.').upper() or '?'
            videos.append({
                'name': stem,
                'filename': name,
                'file_id': file_id,
                'folder': folder_name,
                'size': _fmt_size(size_bytes),
                'size_bytes': size_bytes,
                'duration': None,
                'duration_seconds': None,
                'has_thumbnail': True,
                'ext': ext,
                'mtime': 0,
                'category': _category(name, folder_name),
            })
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
    return videos


def scan_videos():
    """List all video files from Google Drive recursively."""
    global _video_cache
    now = time.time()
    if _video_cache['data'] is not None and (now - _video_cache['timestamp']) < CACHE_TTL:
        return _video_cache['data']

    if not DRIVE_FOLDER_ID:
        _video_cache = {'data': [], 'timestamp': now}
        return []

    service = _get_drive()
    if not service:
        _video_cache = {'data': [], 'timestamp': now}
        return []
    videos = []
    page_token = None

    while True:
        q = f"'{DRIVE_FOLDER_ID}' in parents and trashed=false"
        resp = service.files().list(
            q=q, fields='files(id,name,size,mimeType,createdTime),nextPageToken',
            pageSize=1000, pageToken=page_token, orderBy='name',
        ).execute()

        for f in resp.get('files', []):
            if f['mimeType'] == 'application/vnd.google-apps.folder':
                videos.extend(_list_folder(service, f['id'], f['name']))
            else:
                size_bytes = int(f.get('size', 0))
                if size_bytes < MIN_SIZE_BYTES:
                    continue
                file_id = f['id']
                name = f['name']
                stem = Path(name).stem
                ext = Path(name).suffix.lstrip('.').upper() or '?'
                videos.append({
                    'name': stem,
                    'filename': name,
                    'file_id': file_id,
                    'folder': '',
                    'size': _fmt_size(size_bytes),
                    'size_bytes': size_bytes,
                    'duration': None,
                    'duration_seconds': None,
                    'has_thumbnail': True,
                    'ext': ext,
                    'mtime': 0,
                    'category': _category(name, ''),
                })

        page_token = resp.get('nextPageToken')
        if not page_token:
            break

    _video_cache = {'data': videos, 'timestamp': now}
    return videos


_video_cache = {'data': None, 'timestamp': 0}
CACHE_TTL = 60

# ── Routes ──────────────────────────────────────────────────────────────


@app.route('/')
def index():
    return render_template('index.html', token=SERVER_TOKEN)


@app.route('/api/videos')
def api_videos():
    videos = scan_videos()
    counts = {'total': len(videos), 'movie': 0, 'series': 0, 'jav': 0}
    for v in videos:
        counts[v['category']] = counts.get(v['category'], 0) + 1
    return jsonify({'videos': videos, 'count': len(videos), 'counts': counts, 'vlc_found': bool(VLC_PATH)})


@app.route('/api/video')
def api_video():
    file_id = request.args.get('id', '')
    if not file_id:
        abort(400)
    return redirect(f'https://drive.google.com/uc?export=download&confirm=t&id={file_id}')


@app.route('/api/thumbnail')
def api_thumbnail():
    file_id = request.args.get('id', '')
    if not file_id:
        abort(400)
    return redirect(f'https://drive.google.com/thumbnail?id={file_id}&sz=w800')


@app.route('/api/play', methods=['POST'])
def api_play():
    if not VLC_PATH:
        return jsonify({'error': 'VLC not found'}), 500

    data = request.get_json(silent=True) or {}
    file_id = data.get('id', '')
    if not file_id:
        return jsonify({'error': 'No file id'}), 400

    vlc_url = f'https://drive.google.com/uc?export=download&id={file_id}'

    try:
        subprocess.Popen([VLC_PATH, vlc_url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return jsonify({'success': True, 'name': data.get('name', file_id)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/refresh', methods=['POST'])
def api_refresh():
    global _video_cache
    _video_cache = {'data': None, 'timestamp': 0}
    videos = scan_videos()
    counts = {'total': len(videos), 'movie': 0, 'series': 0, 'jav': 0}
    for v in videos:
        counts[v['category']] = counts.get(v['category'], 0) + 1
    return jsonify({'videos': videos, 'count': len(videos), 'counts': counts, 'vlc_found': bool(VLC_PATH)})


# ── Main ────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    port = 5000
    print(f'\n  Torrent Video Browser')
    print(f'  Drive  : {"OK" if DRIVE_FOLDER_ID else "NOT SET"}')
    print(f'  VLC    : {VLC_PATH or "NOT FOUND"}')
    print(f'  http://localhost:{port}\n')

    webbrowser.open(f'http://localhost:{port}')
    app.run(host='0.0.0.0', port=port, debug=False)
