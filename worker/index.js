const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const MIN_SIZE = 50 * 1024 * 1024;
const CACHE_TTL = 300; // 5 min — reduce Drive API calls
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

async function listFolder(token, parentId, folderName) {
  const videos = [];
  let pageToken = null;
  while (true) {
    const q = `'${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
    const params = new URLSearchParams({ q, fields: 'files(id,name,size),nextPageToken', pageSize: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await driveFetch(`${DRIVE_API}?${params}`, token);
    const data = await res.json();
    for (const f of (data.files || [])) {
      const sz = parseInt(f.size || '0', 10);
      if (sz < MIN_SIZE) continue;
      const ext = (f.name || '').split('.').pop().toUpperCase() || '?';
      videos.push({
        name: (f.name || '').replace(/\.[^.]+$/, ''),
        filename: f.name,
        file_id: f.id,
        folder: folderName,
        size: fmtSize(sz),
        size_bytes: sz,
        has_thumbnail: true,
        ext, category: detectCat(f.name, folderName),
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return videos;
}

async function listAll(token, rootId) {
  const videos = [];
  const subFolders = [];
  let pageToken = null;

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
        const sz = parseInt(f.size || '0', 10);
        if (sz < MIN_SIZE) continue;
        const ext = (f.name || '').split('.').pop().toUpperCase() || '?';
        videos.push({
          name: (f.name || '').replace(/\.[^.]+$/, ''),
          filename: f.name, file_id: f.id, folder: '',
          size: fmtSize(sz), size_bytes: sz, has_thumbnail: true,
          ext, category: detectCat(f.name, ''),
        });
      }
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  // List subfolders one-by-one (max ~48 to stay under 50 subrequest limit)
  // Root(1) + Token(1) + Folders(N) must be < 50
  const MAX_FOLDERS = 45;
  let count = 0;
  for (const folder of subFolders) {
    if (count >= MAX_FOLDERS) break;
    try {
      const files = await listFolder(token, folder.id, folder.name);
      videos.push(...files);
      count++;
    } catch (e) {
      console.error('Folder error:', folder.name, e.message);
    }
  }

  return videos;
}

async function getVideos(env) {
  const cached = await env.TORRENT_CACHE.get('video_list');
  if (cached) return JSON.parse(cached);
  const token = await getAccessToken(env);
  const videos = await listAll(token, env.DRIVE_FOLDER_ID);
  await env.TORRENT_CACHE.put('video_list', JSON.stringify(videos), { expirationTtl: CACHE_TTL });
  return videos;
}

// ── UI HTML ──

const HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="api-token" content="__API_TOKEN__">
<title>KittipanHub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#ffffff;--surface:#f5f5f7;--border:#d2d2d7;--text:#1d1d1f;--text-secondary:#424245;--text-muted:#6e6e73;--accent:#007aff;--radius:8px;--radius-sm:5px;--radius-xs:3px;--font:'IBM Plex Mono',monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0c0c0e;--surface:#161618;--border:#38383a;--text:#fff;--text-secondary:#c7c7cc;--text-muted:#a1a1a6}}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh}
header{position:sticky;top:0;z-index:100;background:var(--bg);border-bottom:1px solid var(--border)}
.header-inner{max-width:1280px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 24px}
.logo{font-size:16px;font-weight:600;letter-spacing:-0.01em}
.video-count{font-size:12px;color:var(--text-muted)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:var(--radius-sm);font-size:13px;font-weight:500;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);transition:all .15s ease;font-family:var(--font);line-height:1}
.btn:hover{border-color:var(--accent)}
.btn:active{opacity:.8}
.btn:focus-visible{box-shadow:0 0 0 2px var(--accent);outline:none}
main{max-width:1280px;margin:0 auto;padding:24px}
.search-wrap{margin-bottom:16px}
.search-input-wrapper{position:relative;display:inline-block;max-width:400px;width:100%}
.search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:14px;pointer-events:none}
.search-bar{width:100%;padding:8px 12px 8px 34px;font-size:15px;font-family:var(--font);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);outline:none;transition:border-color .15s ease}
.search-bar::placeholder{color:var(--text-muted)}
.search-bar:focus{border-color:var(--accent)}
.tool-bar{display:flex;align-items:center;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.sort-group{display:flex;gap:4px;margin-left:auto}
.tab,.sort-btn{padding:5px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--surface);color:var(--text-secondary);cursor:pointer;font-size:13px;font-family:var(--font);font-weight:500;transition:all .15s ease;line-height:1.4}
.tab:hover,.sort-btn:hover{border-color:var(--accent);color:var(--text)}
.tab.active,.sort-btn.active{background:rgba(0,122,255,.1);border-color:var(--accent);color:var(--accent)}
.tab-count{color:var(--text-muted);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:border-color .15s ease}
.card:hover{border-color:var(--accent)}
.card-thumb{width:100%;aspect-ratio:16/9;background:#1c1c1f;position:relative;overflow:hidden}
.card-thumb img{width:100%;height:100%;object-fit:cover}
.thumb-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#1a1a2e;color:rgba(255,255,255,.15);font-size:2.5rem}
.play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:transparent;transition:background .2s ease}
.card:hover .play-overlay{background:rgba(0,0,0,.4)}
.play-btn{width:48px;height:48px;border-radius:50%;background:var(--accent);border:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;opacity:0;transition:opacity .2s ease,transform .2s ease;transform:scale(.9)}
.card:hover .play-btn{opacity:1;transform:scale(1)}
.card-body{padding:12px 14px}
.card-title{font-size:13px;font-weight:600;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px}
.card-meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px}
.meta-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:var(--radius-xs);font-size:11px;font-weight:500;line-height:1.5;background:rgba(128,128,128,.08);color:var(--text-secondary)}
.meta-ext{background:rgba(0,122,255,.1);color:var(--accent);font-weight:600}
.card-folder{font-size:11px;color:var(--text-muted);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-cat{position:absolute;top:8px;left:8px;z-index:2;padding:2px 8px;border-radius:var(--radius-xs);font-size:11px;font-weight:600;letter-spacing:.02em;pointer-events:none;line-height:1.6}
.cat-movie{background:rgba(0,122,255,.18);color:var(--accent)}
.cat-series{background:rgba(175,82,222,.18);color:#af52de}
.cat-jav{background:rgba(255,55,95,.18);color:#ff375f}
.loading,.empty{display:flex;align-items:center;justify-content:center;padding:80px 0;flex-direction:column;gap:12px;color:var(--text-muted)}
.empty p{font-size:14px}
.spinner{width:28px;height:28px;border:2.5px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast-container{position:fixed;bottom:20px;right:20px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.toast{padding:10px 16px;border-radius:var(--radius-sm);background:var(--surface);border:1px solid var(--border);font-size:13px;color:var(--text);animation:slideIn .25s ease;max-width:360px;box-shadow:0 2px 8px rgba(0,0,0,.12)}
.toast.success{border-color:#30d158}
.toast.error{border-color:#ff3b30}
.toast.fade-out{animation:slideOut .25s ease forwards}
@keyframes slideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes slideOut{to{transform:translateX(120%);opacity:0}}
.player-overlay{position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:16px}
.player-modal{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);max-width:960px;width:100%;overflow:hidden;display:flex;flex-direction:column}
.player-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)}
.player-title{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.player-close{background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;font-family:var(--font);padding:0 4px;line-height:1}
.player-close:hover{color:var(--text)}
.player-modal video{width:100%;display:block;background:#000;max-height:60vh}
.player-footer{padding:10px 16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);font-size:12px}
.player-footer .stream-url{flex:1;min-width:160px;padding:5px 8px;font-size:11px;font-family:var(--font);border:1px solid var(--border);border-radius:var(--radius-xs);background:var(--surface);color:var(--text-secondary);cursor:pointer;outline:none}
.player-footer .stream-url:focus{border-color:var(--accent)}
.player-footer .stream-label{color:var(--text-muted);white-space:nowrap}
@media(max-width:640px){.grid{grid-template-columns:1fr;gap:12px}main{padding:16px}.header-inner{padding:0 16px}.sort-group{margin-left:0}}
</style></head>
<body>
<header><div class="header-inner"><span class="logo">KittipanHub</span><div class="header-actions"><span class="video-count" id="videoCount">Loading...</span><button class="btn" id="refreshBtn" title="Refresh">Refresh</button></div></div></header>
<main>
<div class="search-wrap"><div class="search-input-wrapper"><span class="search-icon">&#x1F50D;</span><input type="text" class="search-bar" id="search" placeholder="Search videos..." autocomplete="off"></div></div>
<div class="tool-bar"><div class="tabs" id="tabs"><button class="tab active" data-cat="all">All <span class="tab-count">0</span></button><button class="tab" data-cat="movie">Movies <span class="tab-count">0</span></button><button class="tab" data-cat="series">Series <span class="tab-count">0</span></button><button class="tab" data-cat="jav">JAV <span class="tab-count">0</span></button></div><div class="sort-group" id="sortGroup"><button class="sort-btn active" data-sort="name">A-Z</button><button class="sort-btn" data-sort="newest">Newest</button><button class="sort-btn" data-sort="oldest">Oldest</button></div></div>
<div class="grid" id="grid"><div class="loading"><div class="spinner"></div><span>Scanning videos...</span></div></div>
</main>
<div class="toast-container" id="toasts"></div>
<div class="player-overlay" id="playerOverlay" style="display:none" onclick="closePlayer(event)"><div class="player-modal" onclick="event.stopPropagation()"><div class="player-header"><span class="player-title" id="playerTitle"></span><button class="player-close" onclick="closePlayer()">&times;</button></div><video id="playerVideo" controls autoplay></video><div class="player-footer"><span class="stream-label">Stream URL:</span><input class="stream-url" id="streamUrl" readonly onclick="this.select()" placeholder="Loading..." value=""></div></div></div>
<script>
var API_TOKEN=(document.querySelector('meta[name="api-token"]')||{}).getAttribute('content')||'';
var allVideos=[],activeCategory='all',sortBy='name';
function fetchVideos(){fetch('/api/videos',{headers:{'X-API-Token':API_TOKEN}}).then(function(r){return r.json()}).then(function(d){allVideos=d.videos;document.getElementById('videoCount').textContent=d.count+' videos';buildTabs(d.counts);applyFilters()}).catch(function(){document.getElementById('grid').innerHTML='<div class=empty><p>Cannot connect to server</p></div>'})}
function buildTabs(c){document.getElementById('tabs').querySelectorAll('.tab').forEach(function(t){var cat=t.dataset.cat;t.querySelector('.tab-count').textContent=c[cat]!=null?c[cat]:c.total})}
function applyFilters(){var q=document.getElementById('search').value.toLowerCase().trim();var f=allVideos;if(activeCategory!=='all')f=f.filter(function(v){return v.category===activeCategory});if(q)f=f.filter(function(v){return v.name.toLowerCase().indexOf(q)!==-1||v.filename.toLowerCase().indexOf(q)!==-1||v.folder.toLowerCase().indexOf(q)!==-1});f=sortVideos(f);renderGrid(f)}
function sortVideos(l){var s=l.slice();if(sortBy==='newest')s.sort(function(a,b){return b.mtime-a.mtime});else if(sortBy==='oldest')s.sort(function(a,b){return a.mtime-b.mtime});else s.sort(function(a,b){return a.name.localeCompare(b.name)});return s}
function catBadge(c){if(c==='jav')return'<span class="card-cat cat-jav">JAV</span>';if(c==='series')return'<span class="card-cat cat-series">SERIES</span>';if(c==='movie')return'<span class="card-cat cat-movie">MOVIE</span>';return''}
function renderGrid(v){var g=document.getElementById('grid');if(!v.length){g.innerHTML='<div class=empty><p>No videos found</p></div>';return}
g.innerHTML=v.map(function(x,i){var img='/api/thumbnail?id='+encodeURIComponent(x.file_id)+'&token='+encodeURIComponent(API_TOKEN);return'<div class=card data-id="'+esc(x.file_id)+'" data-name="'+esc(x.name)+'"><div class=card-thumb><img src="'+img+'" loading=lazy onerror="this.parentElement.innerHTML=\\'<div class=thumb-placeholder>&#9654;</div>\\'">'+catBadge(x.category)+'<div class=play-overlay><div class=play-btn>&#9654;</div></div></div><div class=card-body><div class=card-title title="'+esc(x.filename)+'">'+esc(x.name)+'</div><div class=card-meta><span class="meta-badge meta-ext">'+x.ext+'</span>'+(x.duration?'<span class=meta-badge>'+x.duration+'</span>':'')+'<span class=meta-badge>'+x.size+'</span></div>'+(x.folder?'<div class=card-folder>'+esc(x.folder)+'</div>':'')+'</div></div>'}).join('')}
function openPlayer(id,name){var url=location.protocol+'//'+location.host+'/api/video?id='+encodeURIComponent(id)+'&token='+encodeURIComponent(API_TOKEN);document.getElementById('playerTitle').textContent=name;document.getElementById('playerVideo').src=url.replace(location.protocol+'//'+location.host,'');document.getElementById('streamUrl').value=url;document.getElementById('playerOverlay').style.display='flex'}
function closePlayer(e){if(e&&e.target!==e.currentTarget&&!e.target.closest('.player-close'))return;var v=document.getElementById('playerVideo');v.pause();v.removeAttribute('src');v.load();document.getElementById('playerOverlay').style.display='none'}
document.getElementById('search').addEventListener('input',function(){applyFilters()});
document.getElementById('tabs').addEventListener('click',function(e){var t=e.target.closest('.tab');if(!t)return;activeCategory=t.dataset.cat;document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('active',b===t)});applyFilters()});
document.getElementById('sortGroup').addEventListener('click',function(e){var t=e.target.closest('.sort-btn');if(!t)return;sortBy=t.dataset.sort;document.querySelectorAll('.sort-btn').forEach(function(b){b.classList.toggle('active',b===t)});applyFilters()});
document.getElementById('grid').addEventListener('click',function(e){var c=e.target.closest('.card');if(c)openPlayer(c.dataset.id,c.dataset.name)});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closePlayer(e)});
document.getElementById('refreshBtn').addEventListener('click',function(){var g=document.getElementById('grid');g.innerHTML='<div class=loading><div class=spinner></div><span>Refreshing...</span></div>';fetch('/api/refresh',{method:'POST',headers:{'X-API-Token':API_TOKEN}}).then(function(r){return r.json()}).then(function(d){allVideos=d.videos;document.getElementById('videoCount').textContent=d.count+' videos';buildTabs(d.counts);applyFilters();toast('Refreshed','success')}).catch(function(){g.innerHTML='<div class=empty><p>Refresh failed</p></div>'})});
function toast(msg,type){var c=document.getElementById('toasts');var e=document.createElement('div');e.className='toast '+type;e.textContent=msg;c.appendChild(e);setTimeout(function(){e.classList.add('fade-out');setTimeout(function(){e.remove()},250)},2500)}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
fetchVideos();
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
        const token = await getAccessToken(env);
        const videos = await listAll(token, env.DRIVE_FOLDER_ID);
        await env.TORRENT_CACHE.put('video_list', JSON.stringify(videos), { expirationTtl: CACHE_TTL });
        const counts = { total: videos.length, movie: 0, series: 0, jav: 0 };
        for (const v of videos) counts[v.category] = (counts[v.category] || 0) + 1;
        return json({ videos, count: videos.length, counts });
      } catch (e) {
        return json({ error: 'Drive error: ' + e.message }, 500);
      }
    }

    // API: video stream → redirect to Drive
    if (path === '/api/video') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'missing id' }, 400);
      return Response.redirect(`https://drive.google.com/uc?export=download&confirm=t&id=${id}`, 302);
    }

    // API: thumbnail → redirect to Drive
    if (path === '/api/thumbnail') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'missing id' }, 400);
      return Response.redirect(`https://drive.google.com/thumbnail?id=${id}&sz=w800`, 302);
    }

    // API: refresh cache
    if (path === '/api/refresh') {
      await env.TORRENT_CACHE.delete('video_list');
      const videos = await getVideos(env);
      const counts = { total: videos.length, movie: 0, series: 0, jav: 0 };
      for (const v of videos) counts[v.category] = (counts[v.category] || 0) + 1;
      return json({ videos, count: videos.length, counts });
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
