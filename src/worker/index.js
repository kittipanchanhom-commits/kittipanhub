const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const MIN_SIZE = 50 * 1024 * 1024;
const CACHE_TTL = 600; // 10 min
const CACHE_VERSION = 'v3'; // bump to invalidate old caches on deploy
const MAX_RETRIES = 3;

// ── Helpers ──

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function driveFetch(url, token, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 429) {
      const wait = Math.min(1000 * Math.pow(2, i), 8000); // 1s, 2s, 4s, 8s max
      console.warn(`Drive rate limited, waiting ${wait}ms (retry ${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok && res.status >= 500 && i < retries) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    return res;
  }
  throw new Error('Drive API unavailable after retries');
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fmtSize(bytes) {
  for (const u of ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (bytes < 1024) return `${bytes.toFixed(1)} ${u}`;
    bytes /= 1024;
  }
  return `${bytes.toFixed(1)} PB`;
}

// ── SA Auth ──

async function getAccessToken(env) {
  const cached = await env.TORRENT_CACHE.get('sa_token');
  if (cached) return cached;

  const email = env.GOOGLE_SA_EMAIL;
  const key = env.GOOGLE_SA_KEY.replace(/\\n/g, '\n');
  const pem = key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: email, scope: DRIVE_SCOPE, aud: TOKEN_URL,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };

  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = enc(header) + '.' + enc(payload);

  const keyBuf = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBuf, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt = signingInput + '.' + b64url(new Uint8Array(sig));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('SA auth failed: ' + JSON.stringify(data));

  await env.TORRENT_CACHE.put('sa_token', data.access_token, { expirationTtl: 3300 });
  return data.access_token;
}

// ── Category Detection ──

function detectCat(name, folder) {
  if (folder && /^[A-Z]+-\d{3,4}$/.test(folder)) return 'jav';
  if (/^beejin/i.test(name)) return 'jav';
  if (/^ssni/i.test(name)) return 'jav';
  if (/[Ss]\d{2}[Ee]\d{2}/.test(name)) return 'series';
  return 'movie';
}

// ── Drive Listing ──

async function listAll(token, rootId, opts = {}) {
  const isIG = opts.isIG || false;
  const videos = [];
  const subFolders = [];
  let pageToken = null;

  function buildEntry(f, folderName) {
    const sz = parseInt(f.size || '0', 10);
    if (!isIG && sz < MIN_SIZE) return null;
    const ext = (f.name || '').split('.').pop().toUpperCase() || '?';
    const mime = f.mimeType || '';
    const mediaType = isIG
      ? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file')
      : 'video';
    return {
      name: (f.name || '').replace(/\.[^.]+$/, ''),
      filename: f.name, file_id: f.id, folder: folderName,
      size: fmtSize(sz), size_bytes: sz, has_thumbnail: true,
      ext, category: isIG ? 'ig' : detectCat(f.name, folderName),
      mediaType, mimeType: mime,
    };
  }

  // 1. List root — get folders + root-level files
  while (true) {
    const q = `'${rootId}' in parents and trashed=false`;
    const params = new URLSearchParams({ q, fields: 'files(id,name,size,mimeType),nextPageToken', pageSize: '1000', orderBy: 'name' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await driveFetch(`${DRIVE_API}?${params}`, token);
    const data = await res.json();
    for (const f of (data.files || [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        subFolders.push({ id: f.id, name: f.name });
      } else {
        const entry = buildEntry(f, '');
        if (entry) videos.push(entry);
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  // 2. Batch-query all subfolder contents in PARALLEL — ~15 folders per batch
  const BATCH = 15;
  const batches = [];
  for (let i = 0; i < subFolders.length; i += BATCH) {
    batches.push(subFolders.slice(i, i + BATCH));
  }

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const conditions = batch.map(f => `'${f.id}' in parents`).join(' or ');
      const q = `(${conditions}) and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
      const folderMap = {}; batch.forEach(f => { folderMap[f.id] = f.name; });
      const fileList = [];
      let bpToken = null;

      while (true) {
        const bp = new URLSearchParams({ q, fields: 'files(id,name,size,mimeType,parents),nextPageToken', pageSize: '1000' });
        if (bpToken) bp.set('pageToken', bpToken);
        const r = await driveFetch(`${DRIVE_API}?${bp}`, token);
        const d = await r.json();
        for (const f of (d.files || [])) {
          const parentId = (f.parents && f.parents[0]) || '';
          const folderName = folderMap[parentId] || '';
          const entry = buildEntry(f, folderName);
          if (entry) fileList.push(entry);
        }
        bpToken = d.nextPageToken;
        if (!bpToken) break;
      }
      return fileList;
    })
  );

  for (const files of batchResults) videos.push(...files);

  return videos;
}

async function getVideos(env) {
  const ck = 'video_list_' + CACHE_VERSION;
  const cached = await env.TORRENT_CACHE.get(ck);
  if (cached) return JSON.parse(cached);
  const token = await getAccessToken(env);

  const torrentVids = await listAll(token, env.DRIVE_FOLDER_ID);
  let igVids = [];
  if (env.IG_FOLDER_ID) {
    igVids = await listAll(token, env.IG_FOLDER_ID, { isIG: true });
  }

  const videos = [...torrentVids, ...igVids];
  await env.TORRENT_CACHE.put('video_list_' + CACHE_VERSION, JSON.stringify(videos), { expirationTtl: CACHE_TTL });
  return videos;
}

// ── UI HTML ──

const HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="api-token" content="__API_TOKEN__">
<title>KittipanHub — Movies</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600;14..32,700&family=JetBrains+Mono:wght@400;500;600&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&display=swap" rel="stylesheet">
<style>*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root,[data-theme=dark]{--bg:#060606;--surface:#0f0f0f;--border:rgba(255,255,255,.06);--text:#e4e4e7;--text-secondary:rgba(255,255,255,.5);--text-muted:rgba(255,255,255,.25);--accent:#C5A374;--accent-bright:#d4b68c;--accent-dim:rgba(197,163,116,.12);--danger:#ff453a;--success:#30d158;--font:'Inter',ui-sans-serif,system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;--serif:'Playfair Display',Georgia,serif;--grid-cols:4;--radius:8px}
[data-theme=light]{--bg:#f5f3ef;--surface:#fff;--border:rgba(0,0,0,.08);--text:#1a1a1a;--text-secondary:rgba(0,0,0,.45);--text-muted:rgba(0,0,0,.28);--accent:#9c7538;--accent-bright:#b88d4e;--accent-dim:rgba(156,117,56,.08);--danger:#c62828;--success:#2e7d32}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased;min-height:100vh;transition:background .3s,color .3s}
body::before{content:'';position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(ellipse 50% 50% at 20% 10%,rgba(197,163,116,.04),transparent 70%),radial-gradient(ellipse 40% 60% at 80% 80%,rgba(197,163,116,.03),transparent 70%)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.skip-link{position:absolute;top:-100px;left:8px;z-index:999;padding:8px 16px;background:var(--accent);color:#000;font-weight:600;font-size:14px;text-decoration:none;border-radius:var(--radius)}
.skip-link:focus{top:8px}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(197,163,116,.2);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--accent)}
header{position:sticky;top:0;z-index:100;background:rgba(6,6,6,.88);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border-bottom:1px solid var(--border);transition:background .3s}
.header-inner{max-width:1440px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:64px;padding:0 32px;gap:20px}
.header-left{display:flex;align-items:center;gap:16px}
.logo{font-size:18px;font-weight:900;letter-spacing:-.02em;color:var(--text);font-family:var(--serif);text-transform:none}
.logo em{font-style:italic;font-weight:400;color:var(--accent)}
.header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
.icon-btn{background:none;border:none;color:var(--text-secondary);cursor:pointer;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;font-size:17px;font-family:var(--mono);line-height:1;border-radius:var(--radius);transition:all .15s}
.icon-btn:hover{background:var(--accent-dim);color:var(--accent-bright)}
.icon-btn:active{opacity:.7}
.video-count{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;font-family:var(--mono);white-space:nowrap}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;font-size:11px;font-weight:600;cursor:pointer;border:1.5px solid var(--border);background:transparent;color:var(--text-secondary);border-radius:var(--radius);transition:all .15s;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;line-height:1.2;min-height:40px}
.btn:hover{border-color:var(--accent);color:var(--text);background:var(--accent-dim)}
.btn:active{opacity:.8;transform:scale(.98)}
.btn.accent{background:var(--accent);border-color:var(--accent);color:#0a0a0a;font-weight:700}
.btn.accent:hover{opacity:.85}
main{position:relative;z-index:1;max-width:1440px;margin:0 auto;padding:32px 32px 120px}
.hero-strip{text-align:center;padding:20px 0 32px}
.hero-strip h1{font-family:var(--serif);font-size:40px;font-weight:900;letter-spacing:-.02em;line-height:1.1;color:var(--text);margin-bottom:4px}
.hero-strip h1 em{font-style:italic;font-weight:400;color:var(--accent)}
.hero-strip p{font-size:13px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.15em;font-family:var(--mono)}
.search-wrap{margin-bottom:20px}
.search-input-wrapper{position:relative;max-width:560px}
.search-icon{position:absolute;left:0;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:17px;pointer-events:none;line-height:0}
.search-bar{width:100%;padding:0 0 12px 32px;font-size:16px;font-family:var(--font);font-weight:400;background:transparent;border:none;border-bottom:1.5px solid var(--border);color:var(--text);outline:none;transition:border-color .2s}
.search-bar::placeholder{color:var(--text-muted);font-style:italic}
.search-bar:focus{border-bottom-color:var(--accent)}
.search-clear{position:absolute;right:0;bottom:10px;font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);cursor:pointer;font-family:var(--mono);background:none;border:none;display:none;padding:2px 6px;border-radius:var(--radius)}
.search-clear:hover{color:var(--accent);background:var(--accent-dim)}
.search-bar:valid~.search-clear{display:block}
.tool-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:14px;border-bottom:1.5px solid var(--border);padding-bottom:14px}
.tabs{display:flex;gap:0;align-items:flex-end}
.sort-group{display:flex;align-items:center;gap:6px}
.tool-actions{display:flex;align-items:center;gap:6px}
.tab{padding:8px 0 12px;margin-right:32px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:12px;font-family:var(--mono);font-weight:500;text-transform:uppercase;letter-spacing:.12em;transition:all .15s;line-height:1;position:relative;top:2px;min-height:36px}
.tab:hover{color:var(--text)}
.tab.active{border-bottom-color:var(--accent);color:var(--accent-bright)}
.sort-btn,.grid-btn{padding:6px 12px;border:1.5px solid var(--border);background:transparent;color:var(--text-muted);cursor:pointer;font-size:10px;font-family:var(--mono);font-weight:500;text-transform:uppercase;letter-spacing:.08em;transition:all .15s;line-height:1.2;border-radius:var(--radius);min-height:34px}
.sort-btn:hover,.grid-btn:hover{border-color:var(--accent);color:var(--text)}
.sort-btn.active,.grid-btn.active{background:var(--accent-dim);border-color:var(--accent);color:var(--accent-bright)}
.sort-label{font-size:10px;color:var(--text-muted);text-transform:uppercase;font-family:var(--mono);margin-right:4px}
.folder-bar{padding:0 0 20px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;max-height:80px;overflow-y:auto;transition:max-height .25s,padding .25s;position:relative;z-index:10}
.folder-bar.collapsed{max-height:0;padding:0;overflow:hidden}
.folder-chip{padding:5px 12px;border:1.5px solid var(--border);font-size:10px;font-family:var(--mono);cursor:pointer;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;transition:all .15s;white-space:nowrap;border-radius:999px;min-height:32px;display:inline-flex;align-items:center;gap:4px;background:var(--surface)}
.folder-chip:hover{border-color:var(--accent);color:var(--text);background:var(--accent-dim)}
.folder-chip.active{background:var(--accent);border-color:var(--accent);color:#0a0a0a;font-weight:600}
.folder-chip .count{opacity:.6;font-size:9px;font-weight:400}
.stats-bar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;padding:0 0 18px;font-size:10px;font-family:var(--mono);color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;line-height:1.4}
.stats-bar span{color:var(--accent-bright);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(var(--grid-cols,4),1fr);gap:28px}
.card{position:relative;cursor:pointer;outline:none;transition:transform .2s ease,box-shadow .2s ease;animation:fadeUp .4s ease backwards}
.card:hover{transform:translateY(-6px)}
.card:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:var(--radius)}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.card-thumb{width:100%;aspect-ratio:2/3;position:relative;overflow:hidden;border-radius:var(--radius);background:#141414;box-shadow:0 2px 12px rgba(0,0,0,.3)}
.card-thumb img{width:100%;height:100%;object-fit:cover;transition:transform .4s ease}
.card:hover .card-thumb img{transform:scale(1.06)}
.card-thumb::after{content:'';position:absolute;inset:0;background:linear-gradient(to top,rgba(6,6,6,.95) 0%,rgba(6,6,6,.3) 40%,transparent 70%);pointer-events:none;transition:opacity .3s}
.card:hover .card-thumb::after{background:linear-gradient(to top,rgba(6,6,6,.98) 0%,rgba(6,6,6,.5) 50%,transparent 75%)}
.card-gloss{position:absolute;inset:0;pointer-events:none;background:linear-gradient(135deg,rgba(255,255,255,.04) 0%,transparent 50%,rgba(255,255,255,.01) 100%);opacity:0;transition:opacity .3s}
.card:hover .card-gloss{opacity:1}
.play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:2;transition:opacity .25s}
.play-overlay::before{content:'';position:absolute;inset:0;background:rgba(0,0,0,.15);opacity:0;transition:opacity .25s}
.card:hover .play-overlay::before{opacity:1}
.play-btn{width:52px;height:52px;border-radius:50%;border:2px solid rgba(255,255,255,.8);background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;opacity:0;transform:scale(.85);transition:all .25s cubic-bezier(.4,0,.2,1);position:relative;z-index:3}
.card:hover .play-btn{opacity:1;transform:scale(1)}
.queue-btn{position:absolute;top:10px;right:10px;z-index:5;width:30px;height:30px;border-radius:50%;border:1.5px solid rgba(255,255,255,.3);background:rgba(0,0,0,.6);color:rgba(255,255,255,.6);display:inline-flex;align-items:center;justify-content:center;font-size:13px;cursor:pointer;transition:all .15s;opacity:0;backdrop-filter:blur(4px)}
.card:hover .queue-btn{opacity:1}
.queue-btn:hover{border-color:var(--accent);color:var(--accent-bright);background:rgba(0,0,0,.85);transform:scale(1.1)}
.queue-btn.in-queue{opacity:1;border-color:var(--accent);color:var(--accent);background:var(--accent-dim)}
.card-info{position:absolute;bottom:0;left:0;right:0;z-index:1;padding:14px 12px 12px;pointer-events:none}
.card-title{font-size:14px;font-weight:600;line-height:1.25;color:#fff;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-shadow:0 1px 4px rgba(0,0,0,.5)}
.card-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.meta-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:500;color:rgba(255,255,255,.65);text-transform:uppercase;letter-spacing:.05em;font-family:var(--mono)}
.meta-ext{color:var(--accent-bright);font-weight:600}
.meta-dot{color:rgba(255,255,255,.25);font-size:6px}
.card-folder{font-size:10px;color:rgba(255,255,255,.4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);text-transform:uppercase}
.card-cat{position:absolute;top:10px;left:10px;z-index:5;padding:3px 8px;font-size:8px;font-weight:700;letter-spacing:.12em;pointer-events:none;text-transform:uppercase;font-family:var(--mono);border-radius:3px;backdrop-filter:blur(8px)}
.cat-movie{background:rgba(197,163,116,.2);color:var(--accent-bright);border:1px solid rgba(197,163,116,.3)}
.cat-series{background:rgba(175,82,222,.2);color:#c084fc;border:1px solid rgba(175,82,222,.3)}
.cat-jav{background:rgba(255,55,95,.2);color:#fb7185;border:1px solid rgba(255,55,95,.3)}
.cat-ig{background:rgba(232,121,249,.2);color:#f0abfc;border:1px solid rgba(232,121,249,.3)}
.loading,.empty{display:flex;align-items:center;justify-content:center;padding:120px 0;flex-direction:column;gap:20px;color:var(--text-muted)}
.empty .icon{width:56px;height:56px;border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:22px;margin-bottom:8px;border-radius:var(--radius)}
.empty p{font-size:15px;color:var(--text-secondary);font-family:var(--serif);font-style:italic}
.spinner{width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
.toast-container{position:fixed;bottom:24px;right:24px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.toast{padding:12px 18px;background:var(--surface);border:1.5px solid var(--accent-dim);font-size:11px;color:var(--text);animation:slideUp .25s ease;max-width:360px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em;box-shadow:0 8px 32px rgba(0,0,0,.5);border-radius:var(--radius)}
.toast.success{border-color:rgba(197,163,116,.5);color:var(--accent-bright)}
.toast.error{border-color:rgba(255,59,48,.4);color:var(--danger)}
.toast.fade-out{animation:slideDown .2s ease forwards}
@keyframes slideUp{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes slideDown{to{transform:translateY(12px);opacity:0}}
.player-overlay{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.97);display:flex;align-items:center;justify-content:center;padding:24px;animation:fadeIn .2s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.player-modal{background:var(--surface);border:1px solid var(--border);max-width:1024px;width:100%;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 32px 96px rgba(0,0,0,.7);border-radius:12px}
.player-header{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);background:var(--bg)}
.player-header-left{display:flex;align-items:center;gap:12px;min-width:0}
.player-tag{font-size:9px;font-weight:700;padding:3px 10px;letter-spacing:.1em;text-transform:uppercase;font-family:var(--mono);color:var(--accent-bright);background:var(--accent-dim);border:1px solid rgba(197,163,116,.3);white-space:nowrap;border-radius:3px}
.player-tag.jav-tag{color:#fb7185;background:rgba(255,55,95,.12);border-color:rgba(255,55,95,.3)}
.player-tag.series-tag{color:#c084fc;background:rgba(175,82,222,.12);border-color:rgba(175,82,222,.3)}
.player-tag.ig-tag{color:#f0abfc;background:rgba(232,121,249,.12);border-color:rgba(232,121,249,.3)}
.player-title{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-family:var(--font)}
.player-header-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
.player-rotate{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;font-family:var(--mono);width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;transition:all .15s;line-height:1;border-radius:var(--radius)}
.player-rotate:hover{color:var(--accent);background:var(--accent-dim)}
.player-rotate.active{color:var(--accent-bright)}
.player-close{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:22px;width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;transition:all .15s;line-height:1;border-radius:var(--radius)}
.player-close:hover{color:var(--text);background:rgba(255,255,255,.05)}
.player-video-wrap{position:relative;display:flex;align-items:center;justify-content:center;background:#000}
.player-video-wrap.rot90 video{transform:rotate(90deg)}
.player-video-wrap.rot180 video{transform:rotate(180deg)}
.player-video-wrap.rot270 video{transform:rotate(270deg)}
.player-video-wrap video{width:100%;max-height:72vh;display:block;transition:transform .25s ease}
#playerImage{width:100%;max-height:72vh;object-fit:contain;display:none}
.player-footer{padding:12px 20px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--border);font-size:11px;font-family:var(--mono)}
.player-footer .stream-label{color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
.player-footer .stream-url{flex:1;min-width:100px;padding:7px 12px;font-size:10px;font-family:var(--mono);border:1px solid var(--border);background:var(--bg);color:var(--text-secondary);cursor:pointer;outline:none;text-transform:none;letter-spacing:0;border-radius:var(--radius)}
.player-footer .stream-url:focus{border-color:var(--accent)}
.queue-drawer{position:fixed;bottom:0;left:0;right:0;z-index:200;background:var(--surface);border-top:1.5px solid var(--accent-dim);padding:20px 32px;max-height:260px;overflow-y:auto;display:none;box-shadow:0 -8px 40px rgba(0,0,0,.6)}
.queue-drawer.open{display:block}
.queue-drawer h3{font-size:12px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;color:var(--text-secondary)}
.queue-item{display:flex;align-items:center;gap:12px;padding:8px 0;font-size:11px;font-family:var(--mono);border-bottom:1px solid var(--border)}
.queue-item .q-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em}
.queue-item .q-remove{cursor:pointer;color:var(--text-muted);font-size:16px;line-height:1;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--radius);transition:all .15s}
.queue-item .q-remove:hover{color:var(--danger);background:rgba(255,59,48,.1)}
.queue-playing{color:var(--accent-bright);font-weight:600}
footer{text-align:center;padding:40px 24px;font-size:10px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.15em;color:var(--text-muted);border-top:1px solid var(--border);margin-top:32px}
@media(max-width:768px){
.grid{grid-template-columns:repeat(2,1fr);gap:18px;--grid-cols:2}
main{padding:20px 16px 100px}
.header-inner{padding:0 16px;height:56px}
.logo{font-size:16px}
.hero-strip h1{font-size:28px}
.video-count{display:none}
.tool-bar{flex-direction:column;align-items:stretch}
.sort-group,.tool-actions{justify-content:flex-end}
.tab{margin-right:20px;font-size:11px}
.card-title{font-size:12px}
.player-overlay{padding:0}
.player-modal{border-radius:0;max-width:100%}
.player-video-wrap video{max-height:55vh}
.player-footer{flex-direction:column;align-items:stretch;padding:8px 14px}
.player-footer .stream-url{min-width:0}
.player-title{font-size:13px}
.toast-container{left:12px;right:12px;bottom:12px}
.toast{max-width:100%;font-size:10px}
.stats-bar{font-size:9px;gap:10px}
.folder-bar{gap:4px}
.folder-chip{font-size:9px;padding:4px 10px}
.queue-drawer{padding:16px 20px;max-height:220px}
}
@media(max-width:480px){
.grid{grid-template-columns:repeat(2,1fr);gap:12px}
main{padding:16px 12px 100px}
.hero-strip h1{font-size:22px}
.card-title{font-size:11px}
.search-bar{font-size:14px}
}

.login-overlay{position:fixed;inset:0;z-index:900;background:rgba(6,6,6,.97);display:flex;align-items:center;justify-content:center;padding:24px;animation:fadeIn .3s ease}
.login-card{background:var(--surface);border:1px solid var(--accent-dim);padding:36px;border-radius:8px;width:380px;text-align:center;box-shadow:0 32px 80px rgba(0,0,0,.6)}
.login-card .brand{font-family:var(--serif);font-size:28px;font-weight:900;color:var(--text);margin-bottom:2px}
.login-card .brand em{font-style:italic;font-weight:400;color:var(--accent)}
.login-card .sub{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.12em;font-family:var(--mono);margin-bottom:24px}
.login-card label{display:block;font-size:9px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.08em;font-family:var(--mono);margin-bottom:6px;text-align:left}
.login-card input{width:100%;padding:11px 14px;background:var(--bg);border:1.5px solid var(--border);color:var(--text);font-size:15px;font-family:var(--font);border-radius:4px;outline:none;transition:all .15s;box-sizing:border-box}
.login-card input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
.login-card input.error{border-color:var(--danger);box-shadow:0 0 0 3px rgba(255,69,58,.12);animation:shake .35s ease}
.input-wrap{position:relative;display:flex;align-items:center}
.input-wrap input{width:100%;padding-right:40px}
.toggle-pwd{position:absolute;right:1px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:6px 8px;line-height:1;transition:color .15s}
.toggle-pwd:hover{color:var(--accent)}
.login-btn{width:100%;padding:11px;background:var(--accent);border:none;color:#000;font-size:11px;font-weight:700;font-family:var(--mono);text-transform:uppercase;letter-spacing:.12em;border-radius:4px;cursor:pointer;transition:all .15s;margin-top:10px}
.login-btn:hover{opacity:.85}
.login-btn:active{transform:scale(.98)}
.login-btn.loading{opacity:.6;pointer-events:none}
.login-err{background:rgba(255,69,58,.08);border:1px solid rgba(255,69,58,.15);color:var(--danger);font-size:11px;font-family:var(--mono);padding:8px 12px;border-radius:4px;margin-top:12px;display:none}
.login-card .hint{font-size:9px;color:var(--text-muted);margin-top:16px;font-family:var(--mono);letter-spacing:.05em}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
</style></head>
<body>
<a href="#main" class="skip-link">Skip to content</a>
<header><div class="header-inner"><div class="header-left"><button class="icon-btn" id="themeToggle" title="Toggle theme" aria-label="Toggle light/dark theme">&#9681;</button><span class="logo">Kittipan<em>Hub</em></span></div><div class="header-actions"><button class="icon-btn" id="queueToggle" title="Queue" aria-label="Toggle play queue">&#9776;</button><span class="video-count" id="videoCount">Loading...</span><button class="btn" id="refreshBtn">Refresh</button></div></div></header>
<main id="main">
<div class="hero-strip"><h1>Cinema <em>Archive</em></h1><p id="heroSub">Curated film collection &amp; more</p></div>
<div class="search-wrap"><div class="search-input-wrapper"><span class="search-icon">&#x1F50D;</span><input type="text" class="search-bar" id="search" placeholder="Search your library..." autocomplete="off" required><button class="search-clear" onclick="document.getElementById('search').value='';applyFilters()">Clear</button></div></div>
<div class="stats-bar" id="statsBar"><span>--</span> files · <span>--</span> GB · Movies: <span>--</span> · Series: <span>--</span> · JAV: <span>--</span> · IG: <span>--</span></div>
<div class="tool-bar"><div class="tabs" id="tabs"><button class="tab active" data-cat="all">All</button><button class="tab" data-cat="movie">Movies</button><button class="tab" data-cat="series">Series</button><button class="tab" data-cat="jav">JAV</button><button class="tab" data-cat="ig">IG</button></div><div class="sort-group" id="sortGroup"><span class="sort-label">Sort</span><button class="sort-btn active" data-sort="name">A-Z</button><button class="sort-btn" data-sort="newest">New</button><button class="sort-btn" data-sort="oldest">Old</button></div><div class="tool-actions"><button class="grid-btn active" onclick="setGrid(3)" id="g3">3</button><button class="grid-btn" onclick="setGrid(4)" id="g4">4</button><button class="grid-btn" onclick="setGrid(5)" id="g5">5</button><button class="btn" onclick="toggleFolders()" title="Folders">&#9776;</button></div></div>
<div class="folder-bar" id="folderBar"></div>
<div class="grid" id="grid"><div class="loading"><div class="spinner"></div><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em">Scanning videos...</span></div></div>
</main>
<div class="toast-container" id="toasts"></div>
<div class="queue-drawer" id="queueDrawer"><h3>Play Queue</h3><div id="queueList"></div></div>
<div class="player-overlay" id="playerOverlay" style="display:none" onclick="closePlayer(event)"><div class="player-modal" onclick="event.stopPropagation()"><div class="player-header"><div class="player-header-left"><span class="player-tag" id="playerTag">MOVIE</span><span class="player-title" id="playerTitle"></span></div><div class="player-header-actions"><button class="player-rotate" id="playerRotate" onclick="rotatePlayer(event)" title="Rotate">&#8635;</button><button class="player-close" onclick="closePlayer()">&times;</button></div></div><div class="player-video-wrap" id="playerWrap"><video id="playerVideo" controls autoplay></video><img id="playerImage" style="display:none" alt=""></div><div class="player-footer"><span class="stream-label">DL</span><input class="stream-url" id="streamUrl" readonly onclick="this.select()" value=""><button class="btn" id="playerDownload" onclick="dl()">Download</button></div></div></div>
<div class="login-overlay" id="loginOverlay" style="display:none"><div class="login-card"><div class="brand">Kittipan<em>Hub</em></div><div class="sub">Sign In</div><label for="loginUser">Username</label><input type="text" id="loginUser" placeholder="Enter username" autofocus><label for="loginPwd">Password</label><div class="input-wrap"><input type="password" id="loginPwd" placeholder="Enter password"><button class="toggle-pwd" onclick="var i=document.getElementById('loginPwd');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'&#9673;':'&#9680;'">&#9673;</button></div><button class="login-btn" id="loginBtn" onclick="doLogin()">Sign In</button><div class="login-err" id="loginErr">Invalid username or password</div><div class="hint">Contact admin for access</div></div></div>
<footer>&copy; KITTIPANHUB CINEMA ARCHIVE &middot; ALL RIGHTS RESERVED</footer>
<script>
var API_TOKEN=(document.querySelector('meta[name="api-token"]')||{}).getAttribute('content')||'';
var allVideos=[],activeCategory='all',sortBy='name',activeFolder='',gridCols=3,queue=[],queueIndex=-1;

function doLogin(){var b=document.getElementById('loginBtn');var u=document.getElementById('loginUser').value;var p=document.getElementById('loginPwd').value;b.classList.add('loading');b.textContent='Verifying...';fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}).then(function(r){if(!r.ok)throw Error();document.getElementById('loginErr').style.display='none';window.location.reload()}).catch(function(){document.getElementById('loginPwd').classList.add('error');document.getElementById('loginErr').style.display='block';b.classList.remove('loading');b.textContent='Sign In'})}
function showErr(m){document.getElementById('grid').innerHTML='<div class=empty><div class=icon>!</div><p>'+m+'</p></div>'}
function buildStats(d){var t=0;allVideos.forEach(function(v){t+=v.size_bytes||0});var gb=Math.round(t/10737418240)/10;var h=document.getElementById('statsBar');h.innerHTML=escapeHtml(d.count)+' files &middot; '+gb+' GB &middot; Movies: '+escapeHtml(d.movie||0)+' &middot; Series: '+escapeHtml(d.series||0)+' &middot; JAV: '+escapeHtml(d.jav||0)+' &middot; IG: '+escapeHtml(d.ig||0)}

function fetchVideos(){fetch('/api/videos',{headers:{'X-API-Token':API_TOKEN}}).then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(function(d){allVideos=d.videos;document.getElementById('videoCount').textContent=d.count+' vids';buildTabs(d.counts);buildStats(d.counts);buildFolders();applyFilters()}).catch(function(e){showErr(e.message||'Cannot connect')})}
function buildTabs(c){document.getElementById('tabs').querySelectorAll('.tab').forEach(function(t){var cat=t.dataset.cat;t.textContent=cat.charAt(0).toUpperCase()+cat.slice(1)+(c[cat]!=null?' ('+c[cat]+')':'')})}
function buildFolders(){var folders={};allVideos.forEach(function(v){var f=v.folder||'(root)';if(!folders[f])folders[f]=0;folders[f]++});var h='<button class="folder-chip '+(activeFolder?'active':'')+'" data-folder="all">All <span class=count>'+allVideos.length+'</span></button>';Object.keys(folders).sort().forEach(function(f){h+='<button class="folder-chip '+(activeFolder===f?'active':'')+'" data-folder="'+esc(f)+'">'+esc(f)+' <span class=count>'+folders[f]+'</span></button>'});document.getElementById('folderBar').innerHTML=h}
function filterFolder(f){activeFolder=f;document.querySelectorAll('.folder-chip').forEach(function(c){c.classList.toggle('active',(c.dataset.folder===(f||'all')))});applyFilters()}
function applyFilters(){var q=document.getElementById('search').value.toLowerCase().trim();var f=allVideos;if(activeCategory!=='all')f=f.filter(function(v){return v.category===activeCategory});if(activeFolder)f=f.filter(function(v){return v.folder===activeFolder});if(q)f=f.filter(function(v){return v.name.toLowerCase().indexOf(q)!==-1||v.filename.toLowerCase().indexOf(q)!==-1||v.folder.toLowerCase().indexOf(q)!==-1});f=sortVideos(f);renderGrid(f)}
function sortVideos(l){var s=l.slice();if(sortBy==='newest')s.sort(function(a,b){return (b.mtime||0)-(a.mtime||0)});else if(sortBy==='oldest')s.sort(function(a,b){return (a.mtime||0)-(b.mtime||0)});else s.sort(function(a,b){return a.name.localeCompare(b.name)});return s}
function catBadge(c){if(c==='jav')return'<span class="card-cat cat-jav">JAV</span>';if(c==='series')return'<span class="card-cat cat-series">SERIES</span>';if(c==='movie')return'<span class="card-cat cat-movie">MOVIE</span>';if(c==='ig')return'<span class="card-cat cat-ig">IG</span>';return''}
function inQueue(id){for(var i=0;i<queue.length;i++){if(queue[i].file_id===id)return true}return false}
function toggleQueueItem(e){e.stopPropagation();var c=e.target.closest('.card');var id=c.dataset.id;var name=c.dataset.name;var cat=c.dataset.cat;var type=c.dataset.type;if(inQueue(id)){queue=queue.filter(function(q){return q.file_id!==id})}else{queue.push({file_id:id,name:name,cat:cat,type:type})}saveQueue();renderQueue();applyFilters()}
function saveQueue(){localStorage.setItem('kh_queue',JSON.stringify(queue))}
function loadQueue(){try{queue=JSON.parse(localStorage.getItem('kh_queue'))||[]}catch(e){queue=[]}}
function renderQueue(){var d=document.getElementById('queueDrawer');var l=document.getElementById('queueList');l.innerHTML=queue.length?queue.map(function(q,i){return'<div class="queue-item'+(i===queueIndex?' queue-playing':'')+'"><span style=color:var(--text-muted)>'+(i+1)+'.</span><span class=q-title>'+escapeHtml(q.name)+'</span><span class="q-remove" onclick="removeQueue('+i+')">&#x2715;</span></div>'}).join(''):'<span style=font-size:10px;color:var(--text-muted)>Queue empty</span>';var btn=document.getElementById('queueToggle');btn.style.color=queue.length?'#C5A374':''}

function removeQueue(i){queue.splice(i,1);if(queueIndex>=i&&queueIndex>=0)queueIndex--;saveQueue();renderQueue()}
function toggleQueue(){var d=document.getElementById('queueDrawer');d.classList.toggle('open')}
function playNext(){if(queueIndex+1<queue.length){queueIndex++;var n=queue[queueIndex];openPlayer(n.file_id,n.name,n.cat,n.type)}else{queueIndex=-1}renderQueue()}

function renderGrid(v){var g=document.getElementById('grid');if(!v.length){g.innerHTML='<div class=empty><div class=icon>&#x1F3AC;</div><p>Your collection is empty</p></div>';return}
g.innerHTML=v.map(function(x,i){var isImg=x.mediaType==='image';var img='/api/thumbnail?id='+encodeURIComponent(x.file_id)+'&token='+encodeURIComponent(API_TOKEN);var qIn=inQueue(x.file_id);var delay=(i%12)*0.04;return'<div class=card style=animation-delay:'+delay+'s tabindex=0 data-id="'+esc(x.file_id)+'" data-name="'+esc(x.name)+'" data-cat="'+x.category+'" data-type="'+(x.mediaType||'video')+'" data-queue=\\'1\\'><div class=card-thumb><div class=card-gloss></div><img src="'+img+'" loading=lazy alt="'+esc(x.name)+'">'+catBadge(x.category)+'<button class="queue-btn'+(qIn?' in-queue':'')+'" onclick="event.stopPropagation();toggleQueueItem(event)" title="Add to queue" aria-label="Add to queue">+</button>'+(isImg?'':'<div class=play-overlay><div class=play-btn>&#9654;</div></div>')+'</div><div class=card-info><div class=card-title>'+esc(x.name)+(x.duration?' <span style=opacity:.5;font-size:95%>'+x.duration+'</span>':'')+'</div><div class=card-meta><span class="meta-badge meta-ext">'+x.ext+'</span>'+(x.folder?'<span class="meta-dot">&middot;</span><span class=card-folder>'+esc(x.folder)+'</span>':'')+'<span class=meta-dot">&middot;</span><span class=meta-badge>'+x.size+'</span></div></div></div>'}).join('')}

function openPlayer(id,name,cat,mediaType){var isImg=mediaType==='image';var vEl=document.getElementById('playerVideo');var iEl=document.getElementById('playerImage');var url='/api/video?id='+encodeURIComponent(id)+'&token='+encodeURIComponent(API_TOKEN);var dl='https://drive.google.com/uc?export=download&id='+encodeURIComponent(id);document.getElementById('playerTitle').textContent=name;document.getElementById('streamUrl').value=dl;document.getElementById('playerDownload').onclick=function(){window.open(dl,'_blank')};if(isImg){vEl.style.display='none';vEl.removeAttribute('src');iEl.style.display='block';iEl.src=url;document.getElementById('playerRotate').style.display='none'}else{iEl.style.display='none';iEl.removeAttribute('src');vEl.style.display='block';vEl.src=url;document.getElementById('playerRotate').style.display='';vEl.onended=function(){playNext()}}var tag=document.getElementById('playerTag');tag.textContent=(cat||'movie').toUpperCase();tag.className='player-tag'+((cat==='jav'?' jav-tag':'')+(cat==='series'?' series-tag':'')+(cat==='ig'?' ig-tag':''));document.getElementById('playerOverlay').style.display='flex';document.getElementById('playerWrap').className='player-video-wrap';document.getElementById('playerRotate').className='player-rotate'}

function closePlayer(e){if(e&&e.target!==e.currentTarget&&!e.target.closest('.player-close'))return;var v=document.getElementById('playerVideo');var i=document.getElementById('playerImage');v.pause();v.removeAttribute('src');v.load();v.onended=null;v.style.display='block';i.removeAttribute('src');i.style.display='none';document.getElementById('playerOverlay').style.display='none';document.getElementById('playerRotate').style.display=''}

var playerRot=0;function rotatePlayer(e){e.stopPropagation();playerRot=(playerRot+90)%360;var cls='player-video-wrap';if(playerRot===90)cls+=' rot90';else if(playerRot===180)cls+=' rot180';else if(playerRot===270)cls+=' rot270';document.getElementById('playerWrap').className=cls;document.getElementById('playerRotate').className='player-rotate'+(playerRot>0?' active':'')}

function setGrid(n){gridCols=n;document.documentElement.style.setProperty('--grid-cols',n);document.querySelectorAll('.grid-btn').forEach(function(b){b.classList.toggle('active',parseInt(b.textContent)===n)});localStorage.setItem('kh_grid',n)}

function toggleFolders(){document.getElementById('folderBar').classList.toggle('collapsed');document.querySelector('main').classList.toggle('folder-open')}

// Keyboard nav
var cardIndex=-1;var cards=[];
document.addEventListener('keydown',function(e){
  if(document.getElementById('playerOverlay').style.display==='flex'){
    if(e.key==='Escape')closePlayer(e);
    return;
  }
  cards=document.querySelectorAll('.card');
  if(e.key==='ArrowRight'||e.key==='ArrowDown'){e.preventDefault();cardIndex=Math.min(cardIndex+1,cards.length-1);if(cards[cardIndex])cards[cardIndex].focus()}
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp'){e.preventDefault();cardIndex=Math.max(cardIndex-1,0);if(cards[cardIndex])cards[cardIndex].focus()}
  else if(e.key==='Enter'||e.key===' '){e.preventDefault();if(cards[cardIndex]){var c=cards[cardIndex];openPlayer(c.dataset.id,c.dataset.name,c.dataset.cat,c.dataset.type)}}
  else if(e.key==='q'){e.preventDefault();toggleQueue()}
});

document.getElementById('grid').addEventListener('click',function(e){
  var c=e.target.closest('.card');if(!c)return;
  if(e.target.closest('.queue-btn'))return;
  cardIndex=Array.from(document.querySelectorAll('.card')).indexOf(c);
  openPlayer(c.dataset.id,c.dataset.name,c.dataset.cat,c.dataset.type)
});

document.getElementById('folderBar').addEventListener('click',function(e){var c=e.target.closest('.folder-chip');if(c)filterFolder(c.dataset.folder==='all'?'':c.dataset.folder)});
document.getElementById('search').addEventListener('input',function(){applyFilters()});
document.getElementById('tabs').addEventListener('click',function(e){var t=e.target.closest('.tab');if(!t)return;activeCategory=t.dataset.cat;document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('active',b===t)});applyFilters()});
document.getElementById('sortGroup').addEventListener('click',function(e){var t=e.target.closest('.sort-btn');if(!t)return;sortBy=t.dataset.sort;document.querySelectorAll('.sort-btn').forEach(function(b){b.classList.toggle('active',b===t)});applyFilters()});
document.getElementById('refreshBtn').addEventListener('click',function(){var g=document.getElementById('grid');g.innerHTML='<div class=loading><div class=spinner></div><span style=\"font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em\">Refreshing...</span></div>';fetch('/api/refresh',{method:'POST',headers:{'X-API-Token':API_TOKEN}}).then(function(r){return r.json()}).then(function(d){allVideos=d.videos;document.getElementById('videoCount').textContent=d.count+' vids';buildTabs(d.counts);buildStats(d.counts);buildFolders();applyFilters();toast('Refreshed','success')}).catch(function(){g.innerHTML='<div class=empty><div class=icon>!</div><p>Refresh failed</p></div>'})});

// Theme toggle
(function(){var s=localStorage.getItem('kh_theme')||'dark';document.documentElement.setAttribute('data-theme',s)}());
document.getElementById('themeToggle').addEventListener('click',function(){var c=document.documentElement.getAttribute('data-theme');var n=c==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);localStorage.setItem('kh_theme',n)});

// Grid cols restore
(function(){var g=parseInt(localStorage.getItem('kh_grid'))||3;setGrid(g)}());

// Queue toggle
document.getElementById('queueToggle').addEventListener('click',toggleQueue);
loadQueue();

// Keyboard Q
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.getElementById('playerOverlay').style.display!=='flex')document.getElementById('search').focus()});

function toast(msg,type){var c=document.getElementById('toasts');var e=document.createElement('div');e.className='toast '+type;e.textContent=msg;c.appendChild(e);setTimeout(function(){e.classList.add('fade-out');setTimeout(function(){e.remove()},300)},2000)}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
if(API_TOKEN){fetchVideos()}else{document.getElementById('loginOverlay').style.display='flex'}
renderQueue();
document.getElementById('loginPwd').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();document.getElementById('loginErr').style.display='none';this.classList.remove('error')});
document.getElementById('loginUser').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();document.getElementById('loginErr').style.display='none';});
</script>
</body></html>`;

// ── Admin HTML ──

// ── Account helpers ──

async function hashPassword(pw) {
  const data = new TextEncoder().encode('kittipanhub:' + (pw || ''));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(function(b){return b.toString(16).padStart(2,'0')}).join('');
}

async function getAccounts(env) {
  var raw = await env.TORRENT_CACHE.get('accounts');
  if (raw) return JSON.parse(raw);
  // First boot — create default account from API_TOKEN
  var initial = {};
  if (env.API_TOKEN) {
    initial['admin'] = {
      password_hash: await hashPassword(env.ADMIN_PASSWORD || '1234567890'),
      api_token: env.API_TOKEN,
      created: new Date().toISOString(),
    };
  }
  await env.TORRENT_CACHE.put('accounts', JSON.stringify(initial));
  return initial;
}

const ADMIN_LOGIN = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin — KittipanHub</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Playfair+Display:ital,wght@0,400;0,900;1,400&display=swap" rel="stylesheet">
<style>*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{background:#060606;color:#e4e4e7;font-family:Inter,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
body::before{content:'';position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 50% 40% at 30% 20%,rgba(197,163,116,.06),transparent 70%),radial-gradient(ellipse 40% 50% at 70% 80%,rgba(197,163,116,.04),transparent 70%)}
.login-card{position:relative;z-index:1;background:#0f0f0f;border:1px solid rgba(197,163,116,.12);padding:40px;border-radius:8px;width:360px;box-shadow:0 24px 80px rgba(0,0,0,.5)}
.brand{font-family:Playfair Display,serif;font-size:24px;font-weight:900;color:#fff;margin-bottom:2px;text-align:center}
.brand em{font-style:italic;font-weight:400;color:#C5A374}
.sub{font-size:10px;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.1em;font-family:JetBrains Mono,monospace;text-align:center;margin-bottom:28px}
label{display:block;font-size:9px;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:.1em;font-family:JetBrains Mono,monospace;margin-bottom:6px}
input{width:100%;padding:11px 14px;background:#060606;border:1px solid rgba(255,255,255,.08);color:#fff;font-size:15px;font-family:Inter,sans-serif;border-radius:4px;outline:none;transition:border-color .15s;box-sizing:border-box}
input:focus{border-color:#C5A374;box-shadow:0 0 0 3px rgba(197,163,116,.1)}
input.error{border-color:#ff453a;box-shadow:0 0 0 3px rgba(255,69,58,.1);animation:shake .35s ease}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
.btn{width:100%;padding:11px;background:#C5A374;border:none;color:#000;font-size:11px;font-weight:700;font-family:JetBrains Mono,monospace;text-transform:uppercase;letter-spacing:.12em;border-radius:4px;cursor:pointer;transition:all .15s;margin-top:8px}
.btn:hover{opacity:.85}
.btn:active{transform:scale(.98)}
.btn.loading{opacity:.6;pointer-events:none}
.err-box{background:rgba(255,69,58,.08);border:1px solid rgba(255,69,58,.15);color:#ff453a;font-size:11px;font-family:JetBrains Mono,monospace;padding:8px 12px;border-radius:4px;margin-top:12px;display:none;text-align:center}
.hint{font-size:9px;color:rgba(255,255,255,.15);text-align:center;margin-top:16px;font-family:JetBrains Mono,monospace;letter-spacing:.05em}
</style></head>
<body>
<div class=login-card>
<div class=brand>Kittipan<em>Hub</em></div>
<div class=sub>Admin Access</div>
<label for=pwd>Password</label>
<div style=position:relative><input type=password id=pwd placeholder="Enter admin password" autofocus><button onclick="var i=document.getElementById('pwd');i.type=i.type==='password'?'text':'password';this.textContent=i.type==='password'?'&#9673;':'&#9680;'" style=position:absolute;right:1px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:16px;padding:6px 8px>&#9673;</button></div>
<button class=btn id=loginBtn onclick=login()>Authenticate</button>
<div class=err-box id=err>Invalid password</div>
<div class=hint>&copy; KITTIPANHUB CINEMA ARCHIVE</div>
</div>
<script>
var btn=document.getElementById('loginBtn');
async function login(){btn.classList.add('loading');btn.textContent='Verifying...';var r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pwd').value})});if(!r.ok){document.getElementById('err').style.display='block';document.getElementById('pwd').classList.add('error');btn.classList.remove('loading');btn.textContent='Authenticate';document.getElementById('pwd').focus();return}window.location='/admin'}
document.getElementById('pwd').addEventListener('keydown',function(e){if(e.key==='Enter')login();document.getElementById('err').style.display='none';this.classList.remove('error')});
</script></body></html>`;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Admin — KittipanHub</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Playfair+Display:ital,wght@0,400;0,900;1,400&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}
body{background:#060606;color:#e4e4e7;font-family:Inter,sans-serif;font-size:14px;line-height:1.5;min-height:100vh}
header{padding:14px 24px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:space-between}
header h1{font-family:Playfair Display,serif;font-size:15px;color:#fff;font-weight:900}
header h1 em{font-style:italic;font-weight:400;color:#C5A374}
header a{color:rgba(255,255,255,.4);font-size:10px;font-family:JetBrains Mono,monospace;text-transform:uppercase;letter-spacing:.1em;text-decoration:none}
header a:hover{color:#C5A374}
main{max-width:1000px;margin:0 auto;padding:20px}
.section{margin-bottom:24px}
h2{font-family:JetBrains Mono,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:rgba(255,255,255,.45);margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,.04);padding-bottom:6px}
.grid2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat-card{background:#0f0f0f;border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:14px}
.stat-card .val{font-size:22px;font-weight:700;color:#fff;line-height:1.1}
.stat-card .lbl{font-size:9px;font-family:JetBrains Mono,monospace;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.3);margin-top:3px}
.tbl{width:100%;border-collapse:collapse;font-size:11px}
.tbl th{text-align:left;padding:6px 8px;font-family:JetBrains Mono,monospace;font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:rgba(255,255,255,.25);border-bottom:1px solid rgba(255,255,255,.04)}
.tbl td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.02);font-family:JetBrains Mono,monospace;font-size:10px;word-break:break-all}
.tbl .trunc{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.del-btn{background:none;border:none;color:#ff453a;cursor:pointer;font-size:13px;padding:2px 6px;border-radius:3px;transition:all .15s;font-family:JetBrains Mono,monospace}
.del-btn:hover{background:rgba(255,69,58,.15)}
.btn{padding:6px 14px;border:1px solid rgba(255,255,255,.08);background:transparent;color:rgba(255,255,255,.5);font-family:JetBrains Mono,monospace;font-size:9px;text-transform:uppercase;letter-spacing:.08em;border-radius:4px;cursor:pointer;transition:all .15s;line-height:1}
.btn:hover{border-color:#C5A374;color:#C5A374}
.btn.primary{background:#C5A374;border-color:#C5A374;color:#000;font-weight:700}
.btn.primary:hover{opacity:.85}
.btn.danger{background:rgba(255,69,58,.12);border-color:rgba(255,69,58,.25);color:#ff453a}
.btn.danger:hover{background:rgba(255,69,58,.2)}
input,select{padding:6px 10px;background:#060606;border:1px solid rgba(255,255,255,.08);color:#fff;font-size:12px;font-family:Inter,sans-serif;border-radius:4px;outline:none;margin:4px 0;max-width:100%}
input:focus{border-color:#C5A374}
.flex{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.info-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,.02)}
.info-row .k{color:rgba(255,255,255,.3);font-family:JetBrains Mono,monospace;font-size:9px;text-transform:uppercase;letter-spacing:.05em}
.info-row .v{color:rgba(255,255,255,.7);font-family:JetBrains Mono,monospace;font-size:10px}
.log-entry{display:flex;gap:8px;padding:4px 0;font-size:10px;font-family:JetBrains Mono,monospace;border-bottom:1px solid rgba(255,255,255,.02)}
.log-entry .lt{color:rgba(255,255,255,.25);width:60px;flex-shrink:0}
.log-entry .lp{color:#C5A374;width:70px;flex-shrink:0}
.log-entry .lpath{color:rgba(255,255,255,.5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.folder-item{padding:3px 0;font-size:11px;font-family:JetBrains Mono,monospace;color:rgba(255,255,255,.5);cursor:pointer;transition:color .15s}
.folder-item:hover{color:#C5A374}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 16px;background:#0f0f0f;border:1px solid rgba(197,163,116,.2);font-size:11px;font-family:JetBrains Mono,monospace;border-radius:4px;color:#e4e4e7;animation:slideUp .25s ease;z-index:100}
@keyframes slideUp{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
.tab-nav{display:flex;gap:0;margin-bottom:10px;border-bottom:1px solid rgba(255,255,255,.06)}
.tab-nav button{padding:6px 14px;border:none;background:transparent;color:rgba(255,255,255,.35);cursor:pointer;font-size:10px;font-family:JetBrains Mono,monospace;text-transform:uppercase;letter-spacing:.1em;transition:all .15s;border-bottom:2px solid transparent}
.tab-nav button:hover{color:#fff}
.tab-nav button.active{color:#C5A374;border-bottom-color:#C5A374}
@media(max-width:640px){.stat-grid{grid-template-columns:repeat(2,1fr)}.grid2{grid-template-columns:1fr}main{padding:14px}.tbl td{font-size:9px}}
</style></head>
<body>
<header><h1>Kittipan<em>Hub</em> <span style=font-family:JetBrains+Mono,monospace;font-size:10px;color:rgba(255,255,255,.25);text-transform:uppercase;letter-spacing:.1em;font-weight:400>Admin</span></h1><a href="/admin/logout" id=logoutLink>Logout</a></header>
<main>
<div class="tab-nav" id=tabNav><button class=active onclick="switchTab('dash')">Dashboard</button><button onclick="switchTab('accounts')">Accounts</button><button onclick="switchTab('folders')">Folders</button><button onclick="switchTab('config')">Config</button><button onclick="switchTab('logs')">Logs</button></div>

<div id=dashTab>
<div class=section><h2>Library</h2><div class=stat-grid id=stats></div></div>
<div class=section><h2>Storage</h2><div class=stat-grid id=quota><div class=stat-card><div class=val>--</div><div class=lbl>Loading...</div></div></div></div>
</div>

<div id=accountsTab style=display:none>
<div class=section><h2>Accounts</h2><div class=flex style=margin-bottom:8px><button class="btn primary" onclick=createAccount()>+ Create Account</button></div><table class=tbl><thead><tr><th>Username</th><th>API Token</th><th></th></tr></thead><tbody id=acctBody></tbody></table></div>
<div class=section><h2>Create Account</h2><div class=flex><input type=text id=newUser placeholder=Username style=flex:1><input type=password id=newPass placeholder=Password style=flex:1><button class="btn primary" onclick=createAccount()>Create</button></div></div>
<div class=section><h2>Reset Password</h2><div class=flex><input type=text id=resetUser placeholder=Username style=flex:1><input type=password id=resetPass placeholder="New password" style=flex:1><button class=btn onclick=resetPassword()>Reset</button></div></div></div>

<div id=foldersTab style=display:none>
<div class=section><h2>Drive Browser</h2><div style=max-height:300px;overflow-y:auto id=folderList>Loading...</div></div>
<div class=section><h2>Category Override</h2><div class=flex><input type=text id=ovrFileId placeholder="File ID"><select id=ovrCat><option value=movie>Movie</option><option value=series>Series</option><option value=jav>JAV</option><option value=ig>IG</option></select><button class=btn onclick=setOverride()>Set</button></div><div id=ovrList style=font-size:10px;font-family:JetBrains+Mono,monospace;margin-top:6px></div></div>
</div>

<div id=configTab style=display:none>
<div class=section><h2>Password</h2><div class=flex><input type=password id=newPw placeholder="New password"><button class="btn primary" onclick=changePw()>Change</button></div></div>
<div class=section><h2>Cache</h2><button class=btn onclick=clearCache()>Clear & Re-warm</button></div>
<div class=section><h2>System</h2><div id=sysInfo style=max-width:400px></div></div>
</div>

<div id=logsTab style=display:none>
<div class=section><h2>Access Log</h2><div id=accessLog style=max-height:200px;overflow-y:auto></div></div>
<div class=section><h2>Watch History</h2><div id=watchLog style=max-height:200px;overflow-y:auto></div></div>
</div>
</main>
<script>
function toast(m){var e=document.createElement('div');e.className='toast';e.textContent=m;document.body.appendChild(e);setTimeout(function(){e.remove()},2500)}
function switchTab(t){document.querySelectorAll('.tab-nav button').forEach(function(b){b.classList.toggle('active',b.textContent.toLowerCase().includes(t.slice(0,3)))});['dash','accounts','folders','config','logs'].forEach(function(n){document.getElementById(n+'Tab').style.display=n===t?'block':'none'})}

// Stats + Quota
function loadStats(){fetch('/api/admin/stats').then(function(r){if(r.status===403){window.location='/admin';return}return r.json()}).then(function(d){document.getElementById('stats').innerHTML=
'<div class=stat-card><div class=val>'+d.count+'</div><div class=lbl>Files</div></div>'+
'<div class=stat-card><div class=val>'+d.total_gb+'</div><div class=lbl>GB</div></div>'+
'<div class=stat-card><div class=val>'+(d.counts.movie||0)+'</div><div class=lbl>Movies</div></div>'+
'<div class=stat-card><div class=val>'+(d.counts.series||0)+'</div><div class=lbl>Series</div></div>'+
'<div class=stat-card><div class=val>'+(d.counts.jav||0)+'</div><div class=lbl>JAV</div></div>'+
'<div class=stat-card><div class=val>'+(d.counts.ig||0)+'</div><div class=lbl>IG</div></div>'})}

function loadQuota(){fetch('/api/admin/quota').then(function(r){return r.json()}).then(function(d){
var used=(d.usage||0)/1073741824;var lim=(d.limit||1)/1073741824;var pct=Math.round(used/lim*100);
document.getElementById('quota').innerHTML=
'<div class=stat-card><div class=val>'+used.toFixed(1)+'</div><div class=lbl>Used GB</div></div>'+
'<div class=stat-card><div class=val>'+lim.toFixed(0)+'</div><div class=lbl>Limit GB</div></div>'+
'<div class=stat-card><div class=val>'+pct+'%</div><div class=lbl>Used</div></div>'+
'<div class=stat-card><div class=val>'+(d.usageInDriveTrash?Math.round((d.usageInDriveTrash||0)/1073741824,1):'0')+'</div><div class=lbl>Trash GB</div></div>'})}

// Accounts
function loadTokens(){fetch('/api/admin/accounts').then(function(r){return r.json()}).then(function(d){var h='';d.forEach(function(a){h+='<tr><td>'+a.username+'</td><td class=trunc title="'+a.api_token+'">'+a.api_token.substring(0,20)+'..</td><td style=text-align:right><button class=del-btn onclick=deleteAccount("'+a.username+'")>&times;</button></td></tr>'});document.getElementById('acctBody').innerHTML=h})}
function genToken(){document.getElementById('accountsTab').style.display='block';document.getElementById('tokensTab')?.remove();}
function createAccount(){var u=document.getElementById('newUser').value;var p=document.getElementById('newPass').value;fetch('/api/admin/accounts/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})}).then(function(r){if(!r.ok)return r.json().then(function(d){toast(d.error||'Failed');throw Error()});return r.json()}).then(function(d){toast('Account created: '+d.username);loadTokens();document.getElementById('newUser').value='';document.getElementById('newPass').value=''}).catch(function(){})}
function deleteAccount(u){fetch('/api/admin/accounts/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u})}).then(function(){loadTokens();toast('Account deleted: '+u)})}
function resetPassword(){var u=document.getElementById('resetUser').value;var p=document.getElementById('resetPass').value;fetch('/api/admin/accounts/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,new_password:p})}).then(function(r){if(!r.ok)return r.json().then(function(d){toast(d.error||'Failed');throw Error()});return r.json()}).then(function(){toast('Password reset for: '+u);document.getElementById('resetUser').value='';document.getElementById('resetPass').value=''}).catch(function(){})}

// Config
function changePw(){var p=document.getElementById('newPw').value;fetch('/api/admin/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({new_password:p})}).then(function(r){return r.json()}).then(function(d){if(d.ok){toast('Password changed');document.getElementById('newPw').value=''}else{toast('Error: '+d.error)}})}
function clearCache(){fetch('/api/admin/cache',{method:'POST'}).then(function(){loadStats();toast('Cache cleared + re-warmed')})}

// Folders
function loadFolders(){fetch('/api/admin/folders').then(function(r){return r.json()}).then(function(d){var h='<div class=folder-item style=font-weight:600;color:#fff>Root ('+d.files.length+' files, '+d.folders.length+' folders)</div>';d.folders.forEach(function(f){h+='<div class=folder-item onclick="browseFolder('+"'"+f.id+"'"+')">'+f.name+'</div>'});document.getElementById('folderList').innerHTML=h})}
function browseFolder(id){fetch('/api/admin/folders?id='+id).then(function(r){return r.json()}).then(function(d){var h='<div class=folder-item onclick=loadFolders() style=color:#C5A374>.. up</div>';d.folders.forEach(function(f){h+='<div class=folder-item onclick="browseFolder('+"'"+f.id+"'"+')">'+f.name+'</div>'});d.files.forEach(function(f){h+='<div class=log-entry><span class=lp>'+f.id.substring(0,8)+'</span><span class=lpath>'+f.name+'</span></div>'});document.getElementById('folderList').innerHTML=h})}

// Category override
function loadOverrides(){fetch('/api/admin/categories').then(function(r){return r.json()}).then(function(d){var h=Object.keys(d.overrides).length?'':'Empty';for(var k in d.overrides){h+='<div>'+k.substring(0,12)+'.. → '+d.overrides[k]+' <button class=del-btn onclick="clearOverride('+"'"+k+"'"+')">&times;</button></div>'}document.getElementById('ovrList').innerHTML=h})}
function setOverride(){var id=document.getElementById('ovrFileId').value;var cat=document.getElementById('ovrCat').value;fetch('/api/admin/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({set:true,file_id:id,category:cat})}).then(function(){loadOverrides();toast('Override set')})}
function clearOverride(id){fetch('/api/admin/categories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clear:true,file_id:id})}).then(function(){loadOverrides()})}

// Logs
function loadLogs(){fetch('/api/admin/log').then(function(r){return r.json()}).then(function(d){var h='';d.entries.forEach(function(e){h+='<div class=log-entry><span class=lt>'+new Date(e.t).toLocaleTimeString()+'</span><span class=lp>'+e.tok+'</span><span class=lpath>'+e.path+'</span></div>'});document.getElementById('accessLog').innerHTML=h||'No entries'})}
function loadHistory(){fetch('/api/admin/history').then(function(r){return r.json()}).then(function(d){var h='';d.entries.forEach(function(e){h+='<div class=log-entry><span class=lt>'+new Date(e.t).toLocaleTimeString()+'</span><span class=lpath>'+e.file_id.substring(0,16)+'..</span></div>'});document.getElementById('watchLog').innerHTML=h||'No entries'})}

// Sysinfo
function loadSysInfo(){fetch('/api/admin/system').then(function(r){return r.json()}).then(function(d){var h='';for(var k in d){h+='<div class=info-row><span class=k>'+k+'</span><span class=v>'+d[k]+'</span></div>'}document.getElementById('sysInfo').innerHTML=h})}

document.getElementById('logoutLink').addEventListener('click',function(e){e.preventDefault();fetch('/admin/logout').then(function(){window.location='/admin'})});

loadStats();loadQuota();loadTokens();loadFolders();loadOverrides();loadLogs();loadHistory();loadSysInfo();
</script>
</body></html>`;

// ── Routes ──

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Token check for API routes — check against accounts
    if (path.startsWith('/api/')) {
      if (!path.startsWith('/api/admin')) {
        const reqToken = request.headers.get('X-API-Token') || url.searchParams.get('token');
        if (!reqToken) return json({ error: 'Unauthorized' }, 403);
        const accounts = await getAccounts(env);
        var valid = false;
        for (var k in accounts) { if (accounts[k].api_token === reqToken) { valid = true; break; } }
        if (!valid && reqToken !== env.API_TOKEN) {
          return json({ error: 'Unauthorized' }, 403);
        }
      }
    }

    // Access log middleware
    async function logAccess(path, env, request) {
      const token = request.headers.get('X-API-Token') || '';
      const prefix = token.substring(0, 8) || 'anon';
      const key = 'log_' + Date.now();
      await env.TORRENT_CACHE.put(key, JSON.stringify({ path, t: Date.now(), tok: prefix }), { expirationTtl: 86400 * 7 });
    }

    // Serve UI — check session cookie, inject token if valid
    if (path === '/') {
      var sessToken = getSid(request, 'site_sess');
      var validSess = sessToken ? await env.TORRENT_CACHE.get('site_sess_' + sessToken) : null;
      var tokenToInject = validSess ? (env.API_TOKEN || '') : '';
      var html = HTML.replace('__API_TOKEN__', tokenToInject);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Login — username + password
    if (path === '/login' && request.method === 'POST') {
      var body = await request.json();
      var uname = body.username || body.password || '';  // accept old 'password' field as fallback
      var pw = body.password || '';
      var accounts = await getAccounts(env);
      var match = null;
      for (var k in accounts) {
        if (k === uname || accounts[k].api_token === (body.password || '')) {
          var h = await hashPassword(pw);
          if (h === accounts[k].password_hash) { match = { name: k, token: accounts[k].api_token }; break; }
        }
      }
      if (!match && (uname === env.API_TOKEN || body.password === env.API_TOKEN)) {
        // Fallback: direct API_TOKEN login creates session with token
        var sessId2 = crypto.randomUUID().replace(/-/g, '');
        await env.TORRENT_CACHE.put('site_sess_' + sessId2, '1', { expirationTtl: 86400 });
        return json({ ok: true });
      }
      if (!match) return json({ error: 'Invalid credentials' }, 403);
      var sessId = crypto.randomUUID().replace(/-/g, '');
      await env.TORRENT_CACHE.put('site_sess_' + sessId, match.name, { expirationTtl: 86400 });
      var resp = json({ ok: true, username: match.name });
      resp.headers.set('Set-Cookie', `site_sess=${sessId}; HttpOnly; Secure; Path=/; Max-Age=86400; SameSite=Strict`);
      return resp;
    }

    // API: test Drive connection
    if (path === '/api/test') {
      try {
        const token = await getAccessToken(env);
        return json({ ok: true, token_prefix: token.substring(0, 10) + '...' });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // API: list videos
    if (path === '/api/videos') {
      try {
        ctx.waitUntil(logAccess(path, env, request));
        const videos = await getVideos(env);
        const overrides = JSON.parse(await env.TORRENT_CACHE.get('cat_overrides') || '{}');
        for (const v of videos) {
          if (overrides[v.file_id]) v.category = overrides[v.file_id];
        }
        await env.TORRENT_CACHE.put('video_list_' + CACHE_VERSION, JSON.stringify(videos), { expirationTtl: CACHE_TTL });
        const counts = { total: videos.length, movie: 0, series: 0, jav: 0, ig: 0 };
        for (const v of videos) counts[v.category] = (counts[v.category] || 0) + 1;
        return json({ videos, count: videos.length, counts });
      } catch (e) {
        return json({ error: 'Drive error: ' + e.message }, 500);
      }
    }

    // API: video stream → proxy from Drive
    if (path === '/api/video') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'missing id' }, 400);
      ctx.waitUntil(logAccess(path, env, request));
      ctx.waitUntil(env.TORRENT_CACHE.put('watch_' + Date.now(), JSON.stringify({ file_id: id, t: Date.now() }), { expirationTtl: 86400 * 30 }));
      try {
        const saToken = await getAccessToken(env);
        const driveRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${id}?alt=media`,
          { headers: { Authorization: 'Bearer ' + saToken, Range: request.headers.get('Range') || '' } }
        );
        const headers = new Headers();
        headers.set('Content-Type', driveRes.headers.get('Content-Type') || 'video/mp4');
        headers.set('Accept-Ranges', 'bytes');
        if (driveRes.status === 206) {
          headers.set('Content-Range', driveRes.headers.get('Content-Range') || '');
        }
        return new Response(driveRes.body, {
          status: driveRes.status,
          headers,
        });
      } catch (e) {
        return json({ error: 'Stream error: ' + e.message }, 500);
      }
    }

    // API: thumbnail → redirect to Drive
    if (path === '/api/thumbnail') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'missing id' }, 400);
      return Response.redirect(`https://drive.google.com/thumbnail?id=${id}&sz=w800`, 302);
    }

    // API: refresh cache
    if (path === '/api/refresh') {
      await env.TORRENT_CACHE.delete('video_list_' + CACHE_VERSION);
      const videos = await getVideos(env);
      const counts = { total: videos.length, movie: 0, series: 0, jav: 0, ig: 0 };
      for (const v of videos) counts[v.category] = (counts[v.category] || 0) + 1;
      return json({ videos, count: videos.length, counts });
    }

    // API: stats
    if (path === '/api/stats') {
      const videos = await getVideos(env);
      const counts = { total: videos.length, movie: 0, series: 0, jav: 0, ig: 0 };
      let totalGb = 0;
      for (const v of videos) {
        counts[v.category] = (counts[v.category] || 0) + 1;
        totalGb += (v.size_bytes || 0) / (1024 * 1024 * 1024);
      }
      return json({ count: videos.length, counts, total_gb: Math.round(totalGb * 10) / 10 });
    }

    // ── Admin routes ──

    function getSid(r, prefix) {
      var c = r.headers.get('Cookie');
      if (!c) return null;
      var p = prefix || 'admin_sess';
      var m = c.match(RegExp(p + '=([^;]+)'));
      return m ? m[1] : null;
    }

    if (path === '/admin') {
      var sid = getSid(request);
      if (sid && await env.TORRENT_CACHE.get('admin_sess_' + sid)) {
        const html = ADMIN_HTML.replace('__API_TOKEN__', env.API_TOKEN || '');
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response(ADMIN_LOGIN, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (path === '/admin/login' && request.method === 'POST') {
      const body = await request.json();
      const storedPw = await env.TORRENT_CACHE.get('admin_password');
      const validPw = storedPw || env.ADMIN_PASSWORD;
      if (body.password === validPw) {
        const sessId = crypto.randomUUID().replace(/-/g, '');
        await env.TORRENT_CACHE.put('admin_sess_' + sessId, '1', { expirationTtl: 86400 });
        const resp = json({ ok: true });
        resp.headers.set('Set-Cookie', `admin_sess=${sessId}; HttpOnly; Secure; Path=/; Max-Age=86400; SameSite=Strict`);
        return resp;
      }
      return json({ error: 'Wrong password' }, 403);
    }

    if (path === '/admin/logout') {
      var sess = getSid(request);
      if (sess) await env.TORRENT_CACHE.delete('admin_sess_' + sess);
      return new Response('Logged out', { headers: { 'Set-Cookie': 'admin_sess=; HttpOnly; Path=/; Max-Age=0' } });
    }

    if (path === '/api/admin/stats') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      const videos = await getVideos(env);
      const counts = { total: videos.length, movie: 0, series: 0, jav: 0, ig: 0 };
      let totalGb = 0;
      for (const v of videos) { counts[v.category] = (counts[v.category] || 0) + 1; totalGb += (v.size_bytes || 0) / (1024 * 1024 * 1024); }
      return json({ count: videos.length, counts, total_gb: Math.round(totalGb * 10) / 10 });
    }

    if (path === '/api/admin/accounts') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      var accounts = await getAccounts(env);
      var safe = {};
      for (var k in accounts) { safe[k] = { username: k, api_token: accounts[k].api_token, created: accounts[k].created }; }
      return json(Object.values(safe));
    }

    if (path === '/api/admin/accounts/create' && request.method === 'POST') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      var b = await request.json();
      if (!b.username || !b.password) return json({ error: 'Username and password required' }, 400);
      var accounts = await getAccounts(env);
      if (accounts[b.username]) return json({ error: 'Username already exists' }, 400);
      accounts[b.username] = { password_hash: await hashPassword(b.password), api_token: (env.API_TOKEN || '') + '-' + b.username, created: new Date().toISOString() };
      await env.TORRENT_CACHE.put('accounts', JSON.stringify(accounts));
      return json({ ok: true, username: b.username, api_token: accounts[b.username].api_token });
    }

    if (path === '/api/admin/accounts/delete' && request.method === 'POST') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      var b = await request.json();
      var accounts = await getAccounts(env);
      delete accounts[b.username];
      await env.TORRENT_CACHE.put('accounts', JSON.stringify(accounts));
      return json({ ok: true });
    }

    if (path === '/api/admin/accounts/reset' && request.method === 'POST') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      var b = await request.json();
      if (!b.new_password) return json({ error: 'New password required' }, 400);
      var accounts = await getAccounts(env);
      if (!accounts[b.username]) return json({ error: 'Account not found' }, 404);
      accounts[b.username].password_hash = await hashPassword(b.new_password);
      await env.TORRENT_CACHE.put('accounts', JSON.stringify(accounts));
      return json({ ok: true });
    }

    if (path === '/api/admin/cache' && request.method === 'POST') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      await env.TORRENT_CACHE.delete('video_list_' + CACHE_VERSION);
      await getVideos(env);
      return json({ ok: true });
    }

    // Admin: Drive quota
    if (path === '/api/admin/quota') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      const token = await getAccessToken(env);
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const data = await res.json();
      return json(data.storageQuota || data);
    }

    // Admin: change password
    if (path === '/api/admin/password' && request.method === 'POST') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      const body = await request.json();
      if (!body.new_password || body.new_password.length < 4) return json({ error: 'Password too short' }, 400);
      await env.TORRENT_CACHE.put('admin_password', body.new_password);
      return json({ ok: true });
    }

    // Admin: account login compatibility (deprecated)
    if (path === '/api/admin/tokens/refresh' || path === '/api/admin/tokens/test') {
      return json({ error: 'Deprecated - use Accounts tab instead' }, 410);
    }

    // Admin: system info
    if (path === '/api/admin/system') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      return json({
        cache_version: CACHE_VERSION,
        cache_ttl_s: CACHE_TTL,
        drive_folder: env.DRIVE_FOLDER_ID,
        ig_folder: env.IG_FOLDER_ID || null,
        has_kv: !!env.TORRENT_CACHE,
      });
    }

    // Admin: folders browser
    if (path === '/api/admin/folders') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      const token = await getAccessToken(env);
      const rootId = url.searchParams.get('id') || env.DRIVE_FOLDER_ID;
      const resp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q='${rootId}'+in+parents+and+trashed=false&fields=files(id,name,size,mimeType)&pageSize=200&orderBy=name`,
        { headers: { Authorization: 'Bearer ' + token } }
      );
      const data = await resp.json();
      const folders = (data.files || []).filter(f => f.mimeType === 'application/vnd.google-apps.folder').map(f => ({ id: f.id, name: f.name }));
      const files = (data.files || []).filter(f => f.mimeType !== 'application/vnd.google-apps.folder').map(f => ({
        id: f.id, name: f.name, size: f.size, mimeType: f.mimeType,
      }));
      return json({ folders, files, current_id: rootId });
    }

    // Admin: category overrides
    if (path === '/api/admin/categories') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      const overrides = JSON.parse(await env.TORRENT_CACHE.get('cat_overrides') || '{}');
      if (request.method === 'POST') {
        const body = await request.json();
        if (body.set) { overrides[body.file_id] = body.category; }
        if (body.clear && body.file_id) { delete overrides[body.file_id]; }
        await env.TORRENT_CACHE.put('cat_overrides', JSON.stringify(overrides));
      }
      return json({ overrides, count: Object.keys(overrides).length });
    }

    // Admin: access log
    if (path === '/api/admin/log') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const prefix = url.searchParams.get('prefix') || '';
      const keys = await env.TORRENT_CACHE.list({ prefix: 'log_', limit });
      const entries = [];
      for (const k of keys.keys) {
        const val = await env.TORRENT_CACHE.get(k.name);
        if (val) entries.push(JSON.parse(val));
      }
      if (prefix) entries.filter(e => e.tok === prefix);
      entries.sort((a, b) => b.t - a.t);
      return json({ entries: entries.slice(0, limit), total: entries.length });
    }

    // Admin: watch history
    if (path === '/api/admin/history') {
      if (!(getSid(request) && await env.TORRENT_CACHE.get('admin_sess_' + getSid(request)))) return json({ error: 'Unauthorized' }, 403);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const keys = await env.TORRENT_CACHE.list({ prefix: 'watch_', limit: 100 });
      const entries = [];
      for (const k of keys.keys) {
        const val = await env.TORRENT_CACHE.get(k.name);
        if (val) entries.push(JSON.parse(val));
      }
      entries.sort((a, b) => b.t - a.t);
      return json({ entries: entries.slice(0, limit), total: entries.length });
    }


    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST',
          'Access-Control-Allow-Headers': 'X-API-Token, Content-Type',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
