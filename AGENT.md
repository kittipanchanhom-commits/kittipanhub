# AGENT.md — KittipanHub

## Quick Start

| Action | How |
|--------|-----|
| **View catalog** | `https://kittipanhub-worker.yogajourney.workers.dev` (24/7) |
| **Upload videos** | `start.bat` → `[2]` → `http://127.0.0.1:5001` |
| **Auto-upload new** | `python auto_upload.py` |
| **Deploy Worker** | `deploy.bat` |
| **Source** | `https://github.com/kittipanchanhom-commits/kittipanhub` |

## Architecture

```
auto_upload.py → watch local folder → new files → OAuth upload → Google Drive
                                                                ↑ SA reads
                                                         KittipanHub Worker
                                                         (Cloudflare Workers)
                                                              │
                                           https://kittipanhub-worker.yogajourney.workers.dev
                                              ├── /              → catalog UI
                                              ├── /api/videos    → list Drive files (JSON)
                                              ├── /api/video?id= → redirect Drive CDN
                                              └── /api/thumbnail?id= → redirect Drive thumb
```

## Files

| File | Role |
|------|------|
| `worker/index.js` | Cloudflare Worker — API + UI (always online) |
| `wrangler.toml` | Worker config + KV binding |
| `upload.py` | Bulk upload script |
| `upload_gui.py` | Upload GUI with live progress + queue |
| `auto_upload.py` | Watchdog — auto-upload new files |
| `server.py` | *(legacy)* Flask server for local-only use |
| `start.bat` | Launcher menu |
| `deploy.bat` | Deploy Worker to Cloudflare |
| `.env.example` | SA + OAuth credentials template |

## API Routes (Worker)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Catalog UI HTML |
| `GET` | `/api/videos?token=` | List Drive files (category counts) |
| `GET` | `/api/video?id=&token=` | 302 → Google Drive CDN stream |
| `GET` | `/api/thumbnail?id=&token=` | 302 → Google Drive thumbnail |
| `GET` | `/api/test` | SA auth check (token prefix) |
| `POST` | `/api/refresh` | Clear KV cache + re-list |
| `OPTIONS` | `*` | CORS preflight |

## Auth

| Purpose | Method | Scope |
|---------|--------|-------|
| Worker reads files | SA JWT → OAuth2 | `drive.readonly` |
| Upload writes files | OAuth Refresh Token (kittipanchanhom@gmail.com) | `drive.file` |

## Rate Limit Protection

| Layer | Mechanism |
|-------|----------|
| Worker | `driveFetch()` — retry on 429: 1s → 2s → 4s, KV cache TTL 5 min |
| upload_gui.py | `drive_execute()` — retry on 429: 1s → 2s → 4s |
| upload.py | Same `drive_execute()` wrapper |
| auto_upload.py | Same `drive_execute()` wrapper |

## Environment Variables

### `.env` (local upload scripts)

```env
GOOGLE_SA_EMAIL=rockdomain@rock-domain.iam.gserviceaccount.com
GOOGLE_SA_KEY=-----BEGIN PRIVATE KEY-----\n...
DRIVE_FOLDER_ID=1X4uZI_vzrqTJdBrj_p1FPgQscui7ZkNK
GOOGLE_CLIENT_ID=400085547781-xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REFRESH_TOKEN=1//04...
```

### Worker Secrets (`npx wrangler secret put`)

| Name | Value |
|------|-------|
| `API_TOKEN` | hub-torrent-2026 |
| `GOOGLE_SA_EMAIL` | rockdomain@rock-domain.iam.gserviceaccount.com |
| `GOOGLE_SA_KEY` | full PEM key |

## Design System

openai.ai inspired — flat, monospace (IBM Plex Mono), Apple blue (#007aff), auto dark/light mode, no effects. See `worker/index.js` for the embedded UI HTML.

## Category Detection

```javascript
JAV:    folder name matches /^[A-Z]+-\d{3,4}$/
SERIES: filename contains /[Ss]\d{2}[Ee]\d{2}/
MOVIE:  everything else
```

Min file size: 50 MB (filters spam).
