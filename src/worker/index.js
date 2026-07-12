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
<title>KittipanHub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=JetBrains+Mono:wght@400;500;600&family=Playfair+Display:ital,wght@0:400;0:600;1:400&display=swap" rel="stylesheet">
<style>*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root,[data-theme=dark]{--bg:#0A0A0A;--surface:#111;--border:rgba(255,255,255,.08);--text:#e0e0e0;--text-secondary:rgba(255,255,255,.4);--text-muted:rgba(255,255,255,.2);--accent:#C5A374;--radius:0;--font:'Inter',ui-sans-serif,system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace;--serif:'Playfair Display',Georgia,serif;--grid-cols:3}
[data-theme=light]{--bg:#f9f9fb;--surface:#fff;--border:rgba(0,0,0,.1);--text:#1a1a1a;--text-secondary:rgba(0,0,0,.5);--text-muted:rgba(0,0,0,.3);--accent:#a48b5a}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh;transition:background .3s,color .3s}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:#1a1a1a;border:1px solid rgba(197,163,116,.1)}
::-webkit-scrollbar-thumb:hover{background:var(--accent)}
header{position:sticky;top:0;z-index:100;background:var(--bg);border-bottom:1px solid var(--border);transition:background .3s}
.header-inner{max-width:1280px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 24px;gap:12px}
.header-left{display:flex;align-items:center;gap:12px}
.logo{font-size:14px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--text)}
.logo em{font-family:var(--serif);font-weight:400;font-style:italic;text-transform:lowercase;color:var(--accent);letter-spacing:0}
.header-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
.icon-btn{background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;padding:4px 6px;font-family:var(--mono);line-height:1;transition:color .2s}
.icon-btn:hover{color:var(--accent)}
.video-count{font-size:10px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.1em;font-family:var(--mono);white-space:nowrap}
.btn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;font-size:10px;font-weight:500;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text-secondary);transition:all .2s;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;line-height:1}
.btn:hover{border-color:var(--accent);color:var(--text)}
.btn:active{opacity:.8}
.btn.accent{background:var(--accent);border-color:var(--accent);color:#000;font-weight:700}
.btn.accent:hover{opacity:.85}
main{max-width:1280px;margin:0 auto;padding:20px 24px 100px}
.search-wrap{margin-bottom:8px}
.search-input-wrapper{position:relative;width:100%}
.search-icon{position:absolute;left:1px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:14px;pointer-events:none;line-height:0}
.search-bar{width:100%;padding:0 0 8px 26px;font-size:14px;font-family:var(--font);font-weight:300;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text);outline:none;transition:border-color .2s;letter-spacing:.02em}
.search-bar::placeholder{color:var(--text-muted)}
.search-bar:focus{border-bottom-color:var(--accent)}
.search-clear{position:absolute;right:1px;bottom:6px;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);cursor:pointer;font-family:var(--mono);background:none;border:none;display:none}
.search-clear:hover{color:var(--accent)}
.search-bar:valid~.search-clear{display:block}
.tool-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--border);padding-bottom:10px}
.tabs{display:flex;gap:0}
.sort-group{display:flex;align-items:center;gap:4px}
.tool-actions{display:flex;align-items:center;gap:4px}
.tab{padding:6px 0 8px;margin-right:20px;border:none;border-bottom:1.5px solid transparent;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:10px;font-family:var(--mono);font-weight:500;text-transform:uppercase;letter-spacing:.15em;transition:all .2s;line-height:1}
.tab:hover{color:var(--text)}
.tab.active{border-bottom-color:var(--accent);color:var(--accent)}
.sort-btn,.grid-btn{padding:4px 8px;border:1px solid var(--border);background:var(--surface);color:var(--text-secondary);cursor:pointer;font-size:9px;font-family:var(--mono);font-weight:500;text-transform:uppercase;letter-spacing:.1em;transition:all .2s;line-height:1.2}
.sort-btn:hover,.grid-btn:hover{border-color:var(--accent);color:var(--text)}
.sort-btn.active,.grid-btn.active{background:rgba(197,163,116,.1);border-color:var(--accent);color:var(--accent)}
.sort-label{font-size:9px;color:var(--text-muted);text-transform:uppercase;font-family:var(--mono);margin-right:2px}
.folder-bar{padding:8px 0 16px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;max-height:60px;overflow-y:auto;transition:max-height .3s}
.folder-bar.collapsed{max-height:0;padding:0;overflow:hidden}
.folder-chip{padding:3px 8px;border:1px solid var(--border);font-size:9px;font-family:var(--mono);cursor:pointer;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em;transition:all .15s;white-space:nowrap}
.folder-chip:hover{border-color:var(--accent);color:var(--text)}
.folder-chip.active{background:rgba(197,163,116,.15);border-color:var(--accent);color:var(--accent)}
.folder-chip .count{color:var(--text-muted);margin-left:2px;font-size:8px}
.stats-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:6px 0 10px;font-size:9px;font-family:var(--mono);color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.stats-bar span{color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(var(--grid-cols,3),1fr);gap:20px}
.card{background:var(--surface);border:1px solid var(--border);overflow:hidden;cursor:pointer;transition:all .25s;display:flex;flex-direction:column;outline:none;position:relative}
.card:hover{border-color:rgba(197,163,116,.4)}
.card:focus-visible{outline:2px solid var(--accent);outline-offset:-1px}
.card-thumb{width:100%;aspect-ratio:16/10;background:#161616;position:relative;overflow:hidden}
.card-thumb img{width:100%;height:100%;object-fit:cover;transition:transform .5s ease}
.card:hover .card-thumb img{transform:scale(1.05)}
.play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);opacity:0;transition:opacity .3s}
.card:hover .play-overlay,.card:focus-visible .play-overlay{opacity:1}
.play-btn{width:36px;height:36px;border-radius:50%;border:1px solid var(--accent);background:rgba(0,0,0,.4);color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;transform:scale(.9);transition:transform .3s}
.card:hover .play-btn{transform:scale(1)}
.queue-btn{position:absolute;top:6px;right:6px;z-index:2;width:24px;height:24px;border-radius:50%;border:1px solid var(--border);background:rgba(0,0,0,.6);color:var(--text-muted);display:flex;align-items:center;justify-content:center;font-size:10px;cursor:pointer;transition:all .2s;opacity:0}
.card:hover .queue-btn{opacity:1}
.queue-btn:hover{border-color:var(--accent);color:var(--accent);background:rgba(0,0,0,.8)}
.queue-btn.in-queue{opacity:1;border-color:var(--accent);color:var(--accent);background:rgba(197,163,116,.2)}
.card-body{padding:8px 10px 10px;flex:1;display:flex;flex-direction:column;gap:3px}
.card-title{font-size:11px;font-weight:300;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);text-transform:uppercase;letter-spacing:.06em}
.card:hover .card-title{color:var(--accent)}
.card-meta{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:auto}
.meta-badge{display:inline-flex;align-items:center;gap:3px;font-size:9px;font-weight:500;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.05em;font-family:var(--mono)}
.meta-ext{color:var(--accent);font-weight:600}
.meta-dot{color:rgba(197,163,116,.4);font-size:8px}
.card-folder{font-size:9px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);text-transform:uppercase}
.card-cat{position:absolute;bottom:6px;right:6px;z-index:2;padding:2px 6px;font-size:8px;font-weight:700;letter-spacing:.1em;pointer-events:none;text-transform:uppercase;font-family:var(--mono)}
.cat-movie{background:rgba(0,0,0,.8);color:var(--accent);border:1px solid rgba(197,163,116,.2)}
.cat-series{background:rgba(0,0,0,.8);color:#af52de;border:1px solid rgba(175,82,222,.2)}
.cat-jav{background:rgba(0,0,0,.8);color:#ff375f;border:1px solid rgba(255,55,95,.2)}
.cat-ig{background:rgba(0,0,0,.8);color:#e879f9;border:1px solid rgba(232,121,249,.2)}
.loading,.empty{display:flex;align-items:center;justify-content:center;padding:100px 0;flex-direction:column;gap:16px;color:var(--text-muted)}
.empty .icon{width:40px;height:40px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--accent);font-size:18px;margin-bottom:4px}
.empty p{font-size:13px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.1em;font-family:var(--serif);font-style:italic}
.spinner{width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast-container{position:fixed;bottom:20px;right:20px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.toast{padding:10px 14px;background:var(--surface);border:1px solid rgba(197,163,116,.15);font-size:11px;color:var(--text);animation:slideUp .3s ease;max-width:320px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.05em;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.toast.success{border-color:rgba(197,163,116,.4);color:var(--accent)}
.toast.error{border-color:rgba(255,59,48,.3);color:#ff453a}
.toast.fade-out{animation:slideDown .3s ease forwards}
@keyframes slideUp{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes slideDown{to{transform:translateY(10px);opacity:0}}
.player-overlay{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.97);display:flex;align-items:center;justify-content:center;padding:16px;animation:fadeIn .25s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.player-modal{background:#0F0F0F;border:1px solid rgba(197,163,116,.12);max-width:960px;width:100%;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.8)}
.player-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.05);background:#070707}
.player-header-left{display:flex;align-items:center;gap:8px;min-width:0}
.player-tag{font-size:8px;font-weight:700;padding:2px 6px;letter-spacing:.1em;text-transform:uppercase;font-family:var(--mono);color:var(--accent);background:rgba(197,163,116,.1);border:1px solid rgba(197,163,116,.2);white-space:nowrap}
.player-tag.jav-tag{color:#ff375f;background:rgba(255,55,95,.1);border:1px solid rgba(255,55,95,.2)}
.player-tag.series-tag{color:#af52de;background:rgba(175,82,222,.1);border:1px solid rgba(175,82,222,.2)}
.player-tag.ig-tag{color:#e879f9;background:rgba(232,121,249,.1);border:1px solid rgba(232,121,249,.2)}
.player-title{font-size:12px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;letter-spacing:.05em}
.player-header-actions{display:flex;align-items:center;gap:4px;flex-shrink:0}
.player-rotate{background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:16px;font-family:var(--mono);padding:4px 6px;transition:color .2s;line-height:1}
.player-rotate:hover{color:var(--accent)}
.player-rotate.active{color:var(--accent)}
.player-close{background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:20px;padding:4px 6px;transition:color .2s;line-height:1}
.player-close:hover{color:#fff}
.player-video-wrap{position:relative;display:flex;align-items:center;justify-content:center;background:#000}
.player-video-wrap.rot90 video{transform:rotate(90deg)}
.player-video-wrap.rot180 video{transform:rotate(180deg)}
.player-video-wrap.rot270 video{transform:rotate(270deg)}
.player-video-wrap video{width:100%;max-height:65vh;display:block;transition:transform .3s ease}
#playerImage{width:100%;max-height:65vh;object-fit:contain;display:none}
.player-footer{padding:8px 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.05);font-size:10px;font-family:var(--mono)}
.player-footer .stream-label{color:var(--text-muted);text-transform:uppercase;letter-spacing:.1em;white-space:nowrap}
.player-footer .stream-url{flex:1;min-width:100px;padding:4px 8px;font-size:10px;font-family:var(--mono);border:1px solid var(--border);background:var(--surface);color:var(--text-secondary);cursor:pointer;outline:none;text-transform:none;letter-spacing:0}
.player-footer .stream-url:focus{border-color:var(--accent)}
.queue-drawer{position:fixed;bottom:0;left:0;right:0;z-index:200;background:var(--bg);border-top:1px solid var(--border);padding:16px 24px;max-height:200px;overflow-y:auto;display:none;box-shadow:0 -4px 20px rgba(0,0,0,.5)}
.queue-drawer.open{display:block}
.queue-drawer h3{font-size:11px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px;color:var(--text-secondary)}
.queue-item{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:10px;font-family:var(--mono);border-bottom:1px solid var(--border)}
.queue-item .q-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-transform:uppercase;letter-spacing:.05em}
.queue-item .q-remove{cursor:pointer;color:var(--text-muted);font-size:14px;line-height:1}
.queue-item .q-remove:hover{color:var(--accent)}
.queue-playing{color:var(--accent)}
footer{text-align:center;padding:40px 24px;font-size:9px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.15em;color:var(--text-muted);border-top:1px solid var(--border);margin-top:24px}
@media(max-width:640px){
.grid{grid-template-columns:repeat(2,1fr);gap:12px;--grid-cols:2}
main{padding:14px 14px 80px}
.header-inner{padding:0 14px;height:50px}
.logo{font-size:12px}
.video-count{display:none}
.tool-bar{flex-direction:column;align-items:stretch}
.sort-group,.tool-actions{justify-content:flex-end}
.tab{margin-right:14px;font-size:9px}
.card-body{padding:6px 8px 8px}
.card-title{font-size:10px}
.player-overlay{padding:0}
.player-modal{max-width:100%}
.player-video-wrap video{max-height:50vh}
.player-footer{flex-direction:column;align-items:stretch;padding:6px 10px}
.player-footer .stream-url{min-width:0}
.player-title{font-size:10px}
.toast-container{left:8px;right:8px;bottom:8px}
.toast{max-width:100%;font-size:10px}
.stats-bar{font-size:8px;gap:6px}
.folder-bar{gap:3px}
.folder-chip{font-size:8px;padding:2px 6px}
}
</style></head>
<body>
<header><div class="header-inner"><div class="header-left"><button class="icon-btn" id="themeToggle" title="Toggle theme">&#9681;</button><span class="logo">TORRENT <em>browser</em></span></div><div class="header-actions"><button class="icon-btn" id="queueToggle" title="Queue (Q)">&#9776;</button><span class="video-count" id="videoCount">Loading...</span><button class="btn" id="refreshBtn">Refresh</button></div></div></header>
<main>
<div class="search-wrap"><div class="search-input-wrapper"><span class="search-icon">&#x1F50D;</span><input type="text" class="search-bar" id="search" placeholder="Search videos, tags, codes..." autocomplete="off" required><button class="search-clear" onclick="document.getElementById('search').value='';applyFilters()">Clear</button></div></div>
<div class="stats-bar" id="statsBar"><span>--</span> files · <span>--</span> GB · Movies: <span>--</span> · Series: <span>--</span> · JAV: <span>--</span> · IG: <span>--</span></div>
<div class="tool-bar"><div class="tabs" id="tabs"><button class="tab active" data-cat="all">All</button><button class="tab" data-cat="movie">Movies</button><button class="tab" data-cat="series">Series</button><button class="tab" data-cat="jav">JAV</button><button class="tab" data-cat="ig">IG</button></div><div class="sort-group"><span class="sort-label">Sort</span><button class="sort-btn active" data-sort="name">A-Z</button><button class="sort-btn" data-sort="newest">New</button><button class="sort-btn" data-sort="oldest">Old</button></div><div class="tool-actions"><button class="grid-btn active" onclick="setGrid(3)" id="g3">3</button><button class="grid-btn" onclick="setGrid(4)" id="g4">4</button><button class="grid-btn" onclick="setGrid(5)" id="g5">5</button><button class="btn" onclick="toggleFolders()" title="Folders">&#9776;</button></div></div>
<div class="folder-bar collapsed" id="folderBar"></div>
<div class="grid" id="grid"><div class="loading"><div class="spinner"></div><span style="font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em">Scanning videos...</span></div></div>
</main>
<div class="toast-container" id="toasts"></div>
<div class="queue-drawer" id="queueDrawer"><h3>Play Queue</h3><div id="queueList"></div></div>
<div class="player-overlay" id="playerOverlay" style="display:none" onclick="closePlayer(event)"><div class="player-modal" onclick="event.stopPropagation()"><div class="player-header"><div class="player-header-left"><span class="player-tag" id="playerTag">MOVIE</span><span class="player-title" id="playerTitle"></span></div><div class="player-header-actions"><button class="player-rotate" id="playerRotate" onclick="rotatePlayer(event)" title="Rotate">&#8635;</button><button class="player-close" onclick="closePlayer()">&times;</button></div></div><div class="player-video-wrap" id="playerWrap"><video id="playerVideo" controls autoplay></video><img id="playerImage" style="display:none" alt=""></div><div class="player-footer"><span class="stream-label">DL</span><input class="stream-url" id="streamUrl" readonly onclick="this.select()" value=""><button class="btn" id="playerDownload" onclick="dl()">Download</button></div></div></div>
<footer>&copy; KITTIPANHUB · SECURE DIRECT STREAM CACHE</footer>
<script>
var API_TOKEN=(document.querySelector('meta[name="api-token"]')||{}).getAttribute('content')||'';
var allVideos=[],activeCategory='all',sortBy='name',activeFolder='',gridCols=3,queue=[],queueIndex=-1;

function showErr(m){document.getElementById('grid').innerHTML='<div class=empty><div class=icon>!</div><p>'+m+'</p></div>'}
function buildStats(d){var t=0;allVideos.forEach(function(v){t+=v.size_bytes||0});var gb=Math.round(t/10737418240)/10;var h=document.getElementById('statsBar');h.innerHTML=escapeHtml(d.count)+' files &middot; '+gb+' GB &middot; Movies: '+escapeHtml(d.movie||0)+' &middot; Series: '+escapeHtml(d.series||0)+' &middot; JAV: '+escapeHtml(d.jav||0)+' &middot; IG: '+escapeHtml(d.ig||0)}

function fetchVideos(){fetch('/api/videos',{headers:{'X-API-Token':API_TOKEN}}).then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(function(d){allVideos=d.videos;document.getElementById('videoCount').textContent=d.count+' vids';buildTabs(d.counts);buildStats(d.counts);buildFolders();applyFilters()}).catch(function(e){showErr(e.message||'Cannot connect')})}
function buildTabs(c){document.getElementById('tabs').querySelectorAll('.tab').forEach(function(t){var cat=t.dataset.cat;t.textContent=cat.charAt(0).toUpperCase()+cat.slice(1)+(c[cat]!=null?' ('+c[cat]+')':'')})}
function buildFolders(){var folders={};allVideos.forEach(function(v){var f=v.folder||'(root)';if(!folders[f])folders[f]=0;folders[f]++});var h='<button class="folder-chip '+(!activeFolder?'active':'')+'" onclick="filterFolder(\'\')">All <span class=count>'+allVideos.length+'</span></button>';Object.keys(folders).sort().forEach(function(f){h+='<button class="folder-chip '+(activeFolder===f?'active':'')+'" onclick="filterFolder(\''+escapeHtml(f)+'\')">'+escapeHtml(f)+' <span class=count>'+folders[f]+'</span></button>'});document.getElementById('folderBar').innerHTML=h}
function filterFolder(f){activeFolder=f;document.querySelectorAll('.folder-chip').forEach(function(c){c.classList.toggle('active',(c.textContent.trim().startsWith(f||'All')))});applyFilters()}
function applyFilters(){var q=document.getElementById('search').value.toLowerCase().trim();var f=allVideos;if(activeCategory!=='all')f=f.filter(function(v){return v.category===activeCategory});if(activeFolder)f=f.filter(function(v){return v.folder===activeFolder});if(q)f=f.filter(function(v){return v.name.toLowerCase().indexOf(q)!==-1||v.filename.toLowerCase().indexOf(q)!==-1||v.folder.toLowerCase().indexOf(q)!==-1});f=sortVideos(f);renderGrid(f)}
function sortVideos(l){var s=l.slice();if(sortBy==='newest')s.sort(function(a,b){return (b.mtime||0)-(a.mtime||0)});else if(sortBy==='oldest')s.sort(function(a,b){return (a.mtime||0)-(b.mtime||0)});else s.sort(function(a,b){return a.name.localeCompare(b.name)});return s}
function catBadge(c){if(c==='jav')return'<span class="card-cat cat-jav">JAV</span>';if(c==='series')return'<span class="card-cat cat-series">SERIES</span>';if(c==='movie')return'<span class="card-cat cat-movie">MOVIE</span>';if(c==='ig')return'<span class="card-cat cat-ig">IG</span>';return''}
function inQueue(id){for(var i=0;i<queue.length;i++){if(queue[i].file_id===id)return true}return false}
function toggleQueueItem(e,id,name,cat,type){e.stopPropagation();if(inQueue(id)){queue=queue.filter(function(q){return q.file_id!==id})}else{queue.push({file_id:id,name:name,cat:cat,type:type})}saveQueue();renderQueue();applyFilters()}
function saveQueue(){localStorage.setItem('kh_queue',JSON.stringify(queue))}
function loadQueue(){try{queue=JSON.parse(localStorage.getItem('kh_queue'))||[]}catch(e){queue=[]}}
function renderQueue(){var d=document.getElementById('queueDrawer');var l=document.getElementById('queueList');l.innerHTML=queue.length?queue.map(function(q,i){return'<div class="queue-item'+(i===queueIndex?' queue-playing':'')+'"><span style=color:var(--text-muted)>'+(i+1)+'.</span><span class=q-title>'+escapeHtml(q.name)+'</span><span class="q-remove" onclick="removeQueue('+i+')">&#x2715;</span></div>'}).join(''):'<span style=font-size:10px;color:var(--text-muted)>Queue empty</span>';var btn=document.getElementById('queueToggle');btn.style.color=queue.length?var(--accent):''}

function removeQueue(i){queue.splice(i,1);if(queueIndex>=i&&queueIndex>=0)queueIndex--;saveQueue();renderQueue()}
function toggleQueue(){var d=document.getElementById('queueDrawer');d.classList.toggle('open')}
function playNext(){if(queueIndex+1<queue.length){queueIndex++;var n=queue[queueIndex];openPlayer(n.file_id,n.name,n.cat,n.type)}else{queueIndex=-1}renderQueue()}

function renderGrid(v){var g=document.getElementById('grid');if(!v.length){g.innerHTML='<div class=empty><div class=icon>&#x1F50D;</div><p>No videos found</p></div>';return}
g.innerHTML=v.map(function(x,i){var isImg=x.mediaType==='image';var img='/api/thumbnail?id='+encodeURIComponent(x.file_id)+'&token='+encodeURIComponent(API_TOKEN);var qIn=inQueue(x.file_id);return'<div class=card tabindex=0 data-id="'+esc(x.file_id)+'" data-name="'+esc(x.name)+'" data-cat="'+x.category+'" data-type="'+(x.mediaType||'video')+'"><div class=card-thumb><img src="'+img+'" loading=lazy>'+catBadge(x.category)+'<button class="queue-btn'+(qIn?' in-queue':'')+'" onclick="event.stopPropagation();toggleQueueItem(event,\''+esc(x.file_id)+'\',\''+esc(x.name)+'\',\''+x.category+'\',\''+(x.mediaType||'video')+'\')" title="Add to queue">+</button>'+(isImg?'':'<div class=play-overlay><div class=play-btn>&#9654;</div></div>')+'</div><div class=card-body><div class=card-title title="'+esc(x.filename)+'">'+esc(x.name)+(x.duration?' <span style=color:var(--text-muted);font-size:9px>'+x.duration+'</span>':'')+'</div><div class=card-meta><span class="meta-badge meta-ext">'+x.ext+'</span>'+(x.folder?'<span class="meta-dot">&middot;</span><span class=card-folder>'+esc(x.folder)+'</span>':'')+'<span class=meta-dot>&middot;</span><span class=meta-badge>'+x.size+'</span></div></div></div>'}).join('')}

function openPlayer(id,name,cat,mediaType){var isImg=mediaType==='image';var vEl=document.getElementById('playerVideo');var iEl=document.getElementById('playerImage');var url='/api/video?id='+encodeURIComponent(id)+'&token='+encodeURIComponent(API_TOKEN);var dl='https://drive.google.com/uc?export=download&id='+encodeURIComponent(id);document.getElementById('playerTitle').textContent=name;document.getElementById('streamUrl').value=dl;document.getElementById('playerDownload').onclick=function(){window.open(dl,'_blank')};if(isImg){vEl.style.display='none';vEl.removeAttribute('src');iEl.style.display='block';iEl.src=url;document.getElementById('playerRotate').style.display='none'}else{iEl.style.display='none';iEl.removeAttribute('src');vEl.style.display='block';vEl.src=url;document.getElementById('playerRotate').style.display='';vEl.onended=function(){playNext()}}var tag=document.getElementById('playerTag');tag.textContent=(cat||'movie').toUpperCase();tag.className='player-tag'+((cat==='jav'?' jav-tag':'')+(cat==='series'?' series-tag':'')+(cat==='ig'?' ig-tag':''));document.getElementById('playerOverlay').style.display='flex';document.getElementById('playerWrap').className='player-video-wrap';document.getElementById('playerRotate').className='player-rotate'}

function closePlayer(e){if(e&&e.target!==e.currentTarget&&!e.target.closest('.player-close'))return;var v=document.getElementById('playerVideo');var i=document.getElementById('playerImage');v.pause();v.removeAttribute('src');v.load();v.onended=null;v.style.display='block';i.removeAttribute('src');i.style.display='none';document.getElementById('playerOverlay').style.display='none';document.getElementById('playerRotate').style.display=''}

var playerRot=0;function rotatePlayer(e){e.stopPropagation();playerRot=(playerRot+90)%360;var cls='player-video-wrap';if(playerRot===90)cls+=' rot90';else if(playerRot===180)cls+=' rot180';else if(playerRot===270)cls+=' rot270';document.getElementById('playerWrap').className=cls;document.getElementById('playerRotate').className='player-rotate'+(playerRot>0?' active':'')}

function setGrid(n){gridCols=n;document.documentElement.style.setProperty('--grid-cols',n);document.querySelectorAll('.grid-btn').forEach(function(b){b.classList.toggle('active',parseInt(b.textContent)===n)});localStorage.setItem('kh_grid',n)}

function toggleFolders(){document.getElementById('folderBar').classList.toggle('collapsed')}

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
fetchVideos();
renderQueue();
</script>
</body></html>`;

// ── Routes ──

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Token check for API routes
    if (path.startsWith('/api/')) {
      const token = request.headers.get('X-API-Token') || url.searchParams.get('token');
      if (token !== env.API_TOKEN) {
        return json({ error: 'Unauthorized' }, 403);
      }
    }

    // Serve UI
    if (path === '/') {
      const html = HTML.replace('__API_TOKEN__', env.API_TOKEN || '');
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      });
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
        const videos = await getVideos(env);
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
