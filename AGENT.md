# AGENT.md — Torrent Video Browser

## Project Overview

A local web-based video catalog for browsing and playing torrent-downloaded videos via VLC. Users double-click `start.bat`, a Flask server launches and opens the browser, showing all videos with thumbnails, categories, and search. Clicking a card opens the video in VLC.

---

## Architecture

```
Torrent/
├── server.py            # Flask backend — scan, thumbnail, play, serve
├── start.bat            # Click to launch
├── AGENT.md             # This file
├── templates/
│   └── index.html       # SPA frontend — catalog UI + JS logic
├── .cache/
│   └── thumbnails/      # ffmpeg-generated thumbnails (cached once)
```

- **Backend**: Python 3 + Flask (single `server.py`, ~260 lines)
- **Frontend**: Single HTML file with embedded CSS + vanilla JS (~200 lines)
- **No dependencies** beyond Python 3 and Flask (`pip install flask`)
- **VLC** must be installed for video playback

---

## API Reference (Flask Routes)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves `templates/index.html` |
| `GET` | `/api/videos` | Returns JSON: `{videos[], count, counts{total,movie,series,jav}, vlc_found}` |
| `POST` | `/api/play` | Body `{path: "relative/path/to/file.mp4"}` → Launches VLC with abs path |
| `GET` | `/api/thumbnail?path=...` | Returns JPEG thumbnail (generated on first request, cached) |
| `POST` | `/api/refresh` | Invalidates scan cache, rescans, returns same as `/api/videos` |

### Video Object Shape

```json
{
  "name": "hhd800.com@CAWD-997",
  "filename": "hhd800.com@CAWD-997.mp4",
  "path": "CAWD-997\\hhd800.com@CAWD-997.mp4",
  "folder": "CAWD-997",
  "size": "4.0 GB",
  "size_bytes": 4270527319,
  "duration": "01:58:27",
  "duration_seconds": 7107.4,
  "has_thumbnail": true,
  "ext": "MP4",
  "mtime": 1780066270.67,
  "category": "jav"
}
```

---

## Category Detection (server.py)

```python
JAV_PATTERN = re.compile(r'^[A-Z]+-\d{3,4}$')       # CAWD-997, ADN-787, FNS-205
SERIES_PATTERN = re.compile(r'[Ss]\d{2}[Ee]\d{2}')  # S03E02, S03E01

def _detect_category(filename, folder):
    if folder and JAV_PATTERN.match(folder):     return 'jav'
    if SERIES_PATTERN.search(filename):           return 'series'
    return 'movie'
```

### Filters
- **Size filter**: `MIN_SIZE_MB = 50` — files under 50MB are considered spam/skipped
- **Extensions**: `.mp4 .mkv .avi .webm .mov .wmv .flv .m4v .ts .m2ts`
- **Hidden files/folders**: Any starting with `.` are skipped

---

## Design System — opencode.ai

### Identity
**Developer-minimalist video catalog.** Inspired by opencode.ai — functional, flat, high-contrast, no decorative effects. Terminal-tool aesthetic in a GUI shell.

### Color

#### Light Mode (`:root`, default)

| Token | Hex |
|-------|-----|
| `--bg` | `#ffffff` |
| `--surface` | `#f5f5f7` |
| `--elevated` | `#ffffff` |
| `--border` | `#d2d2d7` |
| `--text` | `#1d1d1f` |
| `--text-secondary` | `#424245` |
| `--text-muted` | `#6e6e73` |
| `--accent` | `#007aff` |
| `--accent-hover` | `#0056b3` |
| `--danger` | `#ff3b30` |
| `--success` | `#30d158` |

#### Dark Mode (`@media (prefers-color-scheme: dark)`)

| Token | Hex |
|-------|-----|
| `--bg` | `#0c0c0e` |
| `--surface` | `#161618` |
| `--elevated` | `#1c1c1f` |
| `--border` | `#38383a` |
| `--text` | `#ffffff` |
| `--danger` | `#ff453a` |

accent, success unchanged between themes.

### Typography

```css
--font: 'IBM Plex Mono', 'Cascadia Code', 'Fira Code', ui-monospace, monospace;
```
Used universally — headings, body, buttons, labels, all UI. Google Fonts import: `IBM+Plex+Mono:wght@400;500;600;700`.

**Font scale**: 11px (badges/labels), 12px (meta), 13px (card title/buttons/tabs), 15px (body/search), 16px (logo).

### Spacing & Radius
- **Base**: 4px unit
- **Radius**: `3px` (badges), `5px` (buttons/inputs/tabs), `8px` (cards)
- **Gaps**: 4-6-8-12-16-24px
- **Grid**: `repeat(auto-fill, minmax(280px, 1fr))`, gap 16px

### Effects — Strictly None
- No `backdrop-filter` / `blur()` / glassmorphism
- No `linear-gradient` / `radial-gradient`
- No `box-shadow` on surfaces (except `:focus-visible` rings)
- No `transform: scale()` on hover
- No glow / shimmer / animated decorations

Only allowed effect: `box-shadow: 0 0 0 2px var(--accent)` for `:focus-visible`.

### Interaction
| Action | Effect |
|--------|--------|
| Hover | `border-color` → `var(--accent)` only (150ms) |
| Active | `opacity: 0.8` |
| Focus | 2px `box-shadow` accent ring |
| Card hover | Subtle border highlight + play button fades in (200ms) |
| Play button | Flat `#007aff` circle, 48×48px, no gradient |

---

## Component Specs

### Header
- Sticky, 56px, `border-bottom: 1px solid var(--border)`
- Background: `var(--bg)` (solid, no blur)

### Search
- `border-radius: 5px`, `border: 1px solid var(--border)`
- Focus: `border-color: var(--accent)`
- Width: `max-width: 400px`

### Tabs / Sort Buttons
- `border-radius: 5px`, `border: 1px solid var(--border)`
- Active: `background: rgba(0,122,255,0.1)`, `border-color: var(--accent)`, `color: var(--accent)`
- Font: 13px, weight 500

### Video Card
- `border-radius: 8px`, `border: 1px solid var(--border)`
- Background: `var(--surface)`, no shadow
- Thumbnail: 16/9 aspect, dark fallback `#1a1a2e`

### Category Badge (top-left overlay)
- `border-radius: 3px`, font 11px, weight 600
- **MOVIE**: `background: rgba(0,122,255,0.18)`, color `#007aff`
- **SERIES**: `background: rgba(175,82,222,0.18)`, color `#af52de`
- **JAV**: `background: rgba(255,55,95,0.18)`, color `#ff375f`

### Toast
- `border-radius: 5px`, `box-shadow: 0 2px 8px rgba(0,0,0,0.12)` (only shadow in the app)
- Slide-in from right, auto-dismiss 2.5s

### Empty / Loading
- Centered text, simple CSS spinner (no skeleton/shimmer)

---

## File-by-File Notes

### server.py
- **Config constants**: `BASE_DIR`, `CACHE_DIR`, `VIDEO_EXTENSIONS`, `VLC_PATH`, `MIN_SIZE_MB`, `CACHE_TTL`
- **VLC detection**: checks `C:\Program Files\VideoLAN\VLC\vlc.exe`, fallback to `where vlc`
- **Cache**: `_video_cache` dict with TTL (30s), invalidated by `/api/refresh`
- **Thumbnails**: `_gen_thumbnail()` uses `ffmpeg -ss 5 or 10% -vframes 1 -q:v 2`, hashed by md5 of relative path
- **Duration probe**: `ffprobe -v error -show_entries format=duration`
- **Path security**: All requests validate `abs_path.relative_to(BASE_DIR)` to prevent traversal

### templates/index.html
- Single file, no external CSS/JS dependencies (except Google Fonts)
- Vanilla JS — no framework
- Logic: `fetchVideos → applyFilters (search + category + sort) → renderGrid`
- `esc()` escapes HTML entities for attribute insertion
- Cards use `data-path` / `data-name` attributes + event delegation (no inline onclick)

### start.bat
```bat
@echo off
cd /d "%~dp0"
python server.py
pause
```

---

## Thumbnail Pipeline
1. `/api/videos` returns `has_thumbnail: false` initially
2. Frontend renders `<img src="/api/thumbnail?path=...">` for every video
3. Backend generates JPEG on first request, caches to `.cache/thumbnails/<md5>.jpg`
4. `onerror` on `<img>` falls back to a dark placeholder
5. Once cached, subsequent requests are instant `send_file`

## Anti-Patterns (Do Not Break)
- No gradients on buttons or backgrounds
- No `backdrop-filter` / glassmorphism
- No rounded-full pills (`border-radius: 999px`)
- No emoji as UI icons
- No scale or glow on hover
- No shimmer / skeleton loading
- No purple/pink accent colors
- Keep UI text in English (Thai font rendering breaks with monospace)

---

## Potential Next Features
- [ ] Manual thumbnail regeneration per file
- [ ] VLC path config via `.env` or UI
- [ ] Folder view / grouping by directory
- [ ] Batch renaming patterns (e.g. strip `hhd800.com@` prefix)
- [ ] Bookmark/favorite videos
- [ ] Play count tracking
- [ ] Minimal player (depends: can user's browser handle HEVC?)
- [ ] Mobile layout refinement (current is adequate)
- [ ] Daemon mode — start minimized in system tray
- [ ] Configurable `MIN_SIZE_MB` from start.bat or env var
