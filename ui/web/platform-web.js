// Browser-only platform adapter. Media and projects stay in this browser's IndexedDB.
const DB_NAME = 'tacot-edit-web';
const DB_VERSION = 1;
const TTL = 7 * 24 * 60 * 60 * 1000;
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpeg', 'mpg'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];
export const ACCEPTED = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];
export const hasTauri = false;

const urls = new Map();
let dbPromise;
let lastProject = null;
let driveToken = null;
let driveEnabled = false;

export function extensionOf(name) {
  const parts = String(name).split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function kindOf(name, mime = '') {
  const ext = extensionOf(name);
  if (mime.startsWith('video') || VIDEO_EXT.includes(ext)) return 'video';
  if (mime.startsWith('audio') || AUDIO_EXT.includes(ext)) return 'audio';
  if (mime.startsWith('image') || IMAGE_EXT.includes(ext)) return 'image';
  return 'video';
}

export function mimeFor(ext) {
  const map = { webm: 'video/webm', mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
  return map[String(ext).replace(/^\./, '').toLowerCase()] || '';
}

function openDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('This browser does not support local project storage'));
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local project storage'));
  });
  return dbPromise;
}

async function request(store, method, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, method === 'getAll' || method === 'get' ? 'readonly' : 'readwrite');
    const req = value === undefined ? tx.objectStore(store)[method]() : tx.objectStore(store)[method](value);
    let result;
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => reject(req.error || new Error(`IndexedDB ${method} failed`));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error(`IndexedDB ${method} failed`));
    tx.onabort = () => reject(tx.error || new Error(`IndexedDB ${method} was aborted`));
  });
}

async function cleanupExpired() {
  const now = Date.now();
  const [projects, media, autosave] = await Promise.all([
    request('projects', 'getAll'), request('media', 'getAll'), request('meta', 'get', 'autosave'),
  ]);
  const expiredProjects = projects.filter((item) => !item.keepForever && item.expiresAt <= now);
  const expiredIds = new Set(media.filter((item) => !item.keepForever && item.expiresAt <= now).map((item) => item.id));
  const referenced = new Set(projects.filter((item) => item.keepForever || item.expiresAt > now)
    .flatMap((item) => item.mediaIds || []));
  const db = await openDb();
  const tx = db.transaction(['projects', 'media', 'meta'], 'readwrite');
  const p = tx.objectStore('projects');
  for (const item of expiredProjects) p.delete(item.name);
  const m = tx.objectStore('media');
  for (const item of media) if ((expiredIds.has(item.id) || item.expiresAt <= now) && !item.keepForever && !referenced.has(item.id)) m.delete(item.id);
  if (autosave && !autosave.keepForever && autosave.expiresAt <= now) tx.objectStore('meta').delete('autosave');
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  return expiredProjects.length;
}

async function touchMedia(ids, keepForever = false) {
  const db = await openDb();
  const tx = db.transaction('media', 'readwrite');
  const store = tx.objectStore('media');
  await Promise.all(ids.map((id) => new Promise((resolve) => {
    const get = store.get(id);
    get.onsuccess = () => {
      if (get.result) store.put({ ...get.result, lastOpenedAt: Date.now(), expiresAt: keepForever ? Number.MAX_SAFE_INTEGER : Date.now() + TTL,
        keepForever: keepForever || Boolean(get.result.keepForever) });
      resolve();
    };
    get.onerror = () => resolve();
  })));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

function mediaId(path) {
  return String(path || '').startsWith('web-media:') ? String(path).slice('web-media:'.length) : String(path || '');
}

export function fileUrl(path) {
  const key = mediaId(path);
  if (urls.has(key)) return urls.get(key);
  if (String(path).startsWith('blob:') || String(path).startsWith('data:')) return path;
  return '';
}

async function recordFor(path) {
  const id = mediaId(path);
  const record = await request('media', 'get', id);
  if (!record) throw new Error('This media file is missing from this browser. Import it again to continue.');
  return record;
}

async function objectUrl(path) {
  const record = await recordFor(path);
  if (!urls.has(record.id)) urls.set(record.id, URL.createObjectURL(record.blob));
  return urls.get(record.id);
}

export async function importFile(file) {
  const id = `media_${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
  const now = Date.now();
  const record = { id, name: file.name, kind: kindOf(file.name, file.type), type: file.type || mimeFor(extensionOf(file.name)),
    blob: file.slice(0, file.size, file.type), bytes: file.size, createdAt: now, lastOpenedAt: now, expiresAt: now + TTL, keepForever: false };
  await request('media', 'put', record);
  const url = URL.createObjectURL(record.blob);
  urls.set(id, url);
  return { id, key: id, path: `web-media:${id}`, name: file.name, kind: record.kind, bytes: file.size };
}

export async function importPath(path) {
  const record = await recordFor(path);
  await objectUrl(path);
  return { id: record.id, key: record.id, path: `web-media:${record.id}`, name: record.name, kind: record.kind, bytes: record.bytes };
}

function probe(url, kind) {
  return new Promise((resolve, reject) => {
    const element = document.createElement(kind === 'audio' ? 'audio' : 'video');
    element.preload = 'metadata'; element.muted = true; element.src = url;
    const timer = setTimeout(() => { clean(); reject(new Error('Timed out reading media metadata')); }, 20000);
    const clean = () => { clearTimeout(timer); element.removeAttribute('src'); element.load(); };
    element.onloadedmetadata = () => { const result = { duration: Number.isFinite(element.duration) ? element.duration : 0,
      width: element.videoWidth || 0, height: element.videoHeight || 0 }; clean(); resolve(result); };
    element.onerror = () => { clean(); reject(new Error('This file could not be decoded by the browser')); };
  });
}

async function filmstrip(url, duration, count = 8) {
  if (!duration || duration <= 0) return [];
  const video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true; video.src = url;
  await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Video thumbnails unavailable')); });
  const canvas = document.createElement('canvas'); canvas.width = 160;
  canvas.height = Math.max(2, Math.min(160, Math.round(160 * (video.videoHeight || 9) / (video.videoWidth || 16))));
  const ctx = canvas.getContext('2d'); const frames = [];
  for (let i = 0; i < count; i += 1) {
    const at = Math.max(0, Math.min(duration - 0.05, (duration * (i + 0.5)) / count));
    await new Promise((resolve) => { const timer = setTimeout(resolve, 2500); video.onseeked = () => { clearTimeout(timer); resolve(); }; video.currentTime = at; });
    try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); frames.push(canvas.toDataURL('image/jpeg', 0.58)); } catch { break; }
  }
  video.removeAttribute('src'); video.load(); return frames;
}

async function waveform(url, kind) {
  if (kind === 'image') return [];
  const bytes = await (await fetch(url)).arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return [];
  const context = new Ctx();
  try {
    const audio = await context.decodeAudioData(bytes.slice(0)); const channel = audio.getChannelData(0);
    const bars = 220; const step = Math.max(1, Math.floor(channel.length / bars)); const peaks = [];
    for (let i = 0; i < bars; i += 1) { let peak = 0; const end = Math.min(channel.length, (i + 1) * step);
      for (let j = i * step; j < end; j += 1) peak = Math.max(peak, Math.abs(channel[j])); peaks.push(Math.min(1, peak * 1.7)); }
    return peaks;
  } finally { await context.close().catch(() => {}); }
}

export async function describeMedia(entry) {
  let url = entry.path;
  if (String(url).startsWith('web-media:')) url = await objectUrl(url);
  const id = entry.id || entry.key || mediaId(entry.path);
  const record = await recordFor(id);
  const kind = entry.kind || record.kind || kindOf(entry.name, record.type);
  let info = { duration: kind === 'image' ? 5 : 0, width: 0, height: 0, error: null };
  try {
    if (kind === 'image') {
      const img = await new Promise((resolve, reject) => { const el = new Image(); el.onload = () => resolve(el); el.onerror = reject; el.src = url; });
      info.width = img.naturalWidth; info.height = img.naturalHeight;
    } else info = { ...info, ...await probe(url, kind) };
  } catch (err) { info.error = err.message; }
  const frames = kind === 'video' ? await filmstrip(url, info.duration).catch(() => []) : [];
  const peaks = await waveform(url, kind).catch(() => []);
  return { ...entry, id, key: entry.key || id, path: `web-media:${id}`, kind, bytes: entry.bytes || record.bytes, duration: info.duration || (kind === 'image' ? 5 : 0),
    width: info.width || 0, height: info.height || 0, frames, peaks, error: info.error };
}

export function thumbnailFor(media, ratio = 0) {
  if (!media?.frames?.length) return null;
  return media.frames[Math.min(media.frames.length - 1, Math.max(0, Math.floor(ratio * media.frames.length)))];
}

function mediaRefs(project) {
  return [...new Set((project.media || []).map((item) => mediaId(item.path || item.key)).filter(Boolean))];
}

async function saveProjectRecord(name, json, keepForever = driveEnabled) {
  const parsed = JSON.parse(json); const now = Date.now(); const ids = mediaRefs(parsed);
  await touchMedia(ids, keepForever);
  const prior = await request('projects', 'get', name);
  await request('projects', 'put', { name, json, bytes: new Blob([json]).size, modified: Math.floor(now / 1000),
    lastOpenedAt: now, expiresAt: keepForever ? Number.MAX_SAFE_INTEGER : now + TTL, keepForever: keepForever || Boolean(prior?.keepForever), mediaIds: ids });
  lastProject = { name, json: JSON.stringify(parsed), mediaIds: ids };
  return `browser://${name}.tacot`;
}

export async function saveProject(name, json) { return saveProjectRecord(name, json); }

export async function loadProject(name) {
  const item = await request('projects', 'get', name);
  if (!item) throw new Error('Saved project not found');
  await saveProjectRecord(name, item.json, item.keepForever);
  return item.json;
}

export async function listProjects() {
  await cleanupExpired();
  return (await request('projects', 'getAll')).sort((a, b) => b.modified - a.modified)
    .map(({ name, modified, bytes }) => ({ name, modified, bytes }));
}

export async function deleteProject(name) {
  const item = await request('projects', 'get', name);
  await request('projects', 'delete', name);
  if (item?.mediaIds?.length) {
    const [projects, autosave] = await Promise.all([request('projects', 'getAll'), request('meta', 'get', 'autosave')]);
    const autosaveIds = autosave ? mediaRefs(JSON.parse(autosave.json)) : [];
    const used = new Set([...projects.flatMap((p) => p.mediaIds || []), ...autosaveIds]);
    for (const id of item.mediaIds) if (!used.has(id)) { await request('media', 'delete', id); const url = urls.get(id); if (url) URL.revokeObjectURL(url); urls.delete(id); }
  }
}

export async function autosave(json) {
  const project = JSON.parse(json); const now = Date.now();
  const previous = await request('meta', 'get', 'autosave');
  const keepForever = driveEnabled || Boolean(previous?.keepForever);
  const ids = mediaRefs(project); await touchMedia(ids, keepForever);
  await request('meta', 'put', { key: 'autosave', json, lastOpenedAt: now, expiresAt: keepForever ? Number.MAX_SAFE_INTEGER : now + TTL, keepForever });
  lastProject = { name: project.name || 'Untitled Project', json, mediaIds: ids };
}

export async function readAutosave() {
  await cleanupExpired();
  const item = await request('meta', 'get', 'autosave');
  if (!item) return null;
  const parsed = JSON.parse(item.json); const ids = mediaRefs(parsed); await touchMedia(ids, item.keepForever);
  lastProject = { name: parsed.name || 'Untitled Project', json: item.json, mediaIds: ids };
  return item.json;
}

export function setDriveProject(json) {
  const project = JSON.parse(json);
  lastProject = { name: project.name || 'Untitled Project', json, mediaIds: mediaRefs(project) };
}

export async function checkFfmpeg() { return { found: false, path: '', version: '' }; }
export async function exportDir() { return 'Downloads'; }

const downloads = new Map();
export async function command(name, args = {}) {
  if (name === 'export_begin') {
    const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`;
    downloads.set(id, { name: args.name || 'Tacot Edit Export', ext: args.ext || 'webm', chunks: [] }); return id;
  }
  if (name === 'export_chunk') { const entry = downloads.get(args.id); if (!entry) throw new Error('Export session expired');
    const raw = atob(args.chunk); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i); entry.chunks.push(bytes); return true; }
  if (name === 'export_finish') {
    const entry = downloads.get(args.id); if (!entry) throw new Error('Export session expired'); downloads.delete(args.id);
    const ext = String(entry.ext).replace(/^\./, ''); const blob = new Blob(entry.chunks, { type: mimeFor(ext) || 'application/octet-stream' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${entry.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Tacot Edit Export'}.${ext}`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 15 * 60_000);
    return { path: `download://${anchor.download}` };
  }
  if (name === 'export_reveal') return true;
  if (name === 'ffmpeg_check') return { found: false, path: '', version: '' };
  if (name === 'transcribe_engine') throw new Error('Speech tools are available in the desktop app');
  if (name === 'app_version') return '0.2.2';
  throw new Error(`“${name}” is available in the desktop app only`);
}

export async function openMediaDialog() {
  return new Promise((resolve) => {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
    input.accept = ACCEPTED.map((ext) => `.${ext}`).join(',');
    input.onchange = async () => {
      const imported = [];
      for (const file of input.files || []) imported.push(file);
      resolve(imported);
    };
    input.oncancel = () => resolve([]); input.click();
  });
}

async function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return;
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    script.onload = resolve; script.onerror = () => reject(new Error('Google Drive sign-in could not be loaded')); document.head.appendChild(script); });
}

async function driveRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${driveToken}`, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`Google Drive returned ${response.status}`); return response.status === 204 ? null : response.json();
}

async function putDriveFile(name, blob, mimeType) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const query = encodeURIComponent(`name='${escaped}' and 'appDataFolder' in parents and trashed=false`);
  const found = await driveRequest(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=appDataFolder&fields=files(id)`);
  const metadata = { name, ...(found.files?.[0] ? {} : { parents: ['appDataFolder'] }) };
  const boundary = `tacot_${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
  const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, blob, `\r\n--${boundary}--`]);
  const method = found.files?.[0] ? 'PATCH' : 'POST';
  const url = `https://www.googleapis.com/upload/drive/v3/files${found.files?.[0] ? `/${found.files[0].id}` : ''}?uploadType=multipart&fields=id`;
  const result = await driveRequest(url, { method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return result.id;
}

async function syncProjectToDrive() {
  if (!lastProject) throw new Error('Save the project once before connecting Drive');
  await putDriveFile(`Tacot Edit - ${lastProject.name}.tacot`, new Blob([lastProject.json], { type: 'application/json' }), 'application/json');
  for (const id of lastProject.mediaIds) {
    const media = await request('media', 'get', id); if (!media) continue;
    await putDriveFile(`Tacot Edit - ${id} - ${media.name}`, media.blob, media.type || 'application/octet-stream');
  }
  driveEnabled = true;
  const project = await request('projects', 'get', lastProject.name);
  if (project) await request('projects', 'put', { ...project, keepForever: true, expiresAt: Number.MAX_SAFE_INTEGER });
  await touchMedia(lastProject.mediaIds, true);
}

export async function initBrowserStorage() {
  await cleanupExpired();
  const badge = document.getElementById('storageBadge'); const driveButton = document.getElementById('driveButton');
  if (badge) badge.textContent = 'Saves kept for 7 days';
  if (!driveButton) return;
  if (window.TACOT_DRIVE_CLIENT_ID) loadGoogleIdentity().catch(() => {});
  driveButton.addEventListener('click', async () => {
    const clientId = window.TACOT_DRIVE_CLIENT_ID;
    if (!clientId) { if (badge) badge.textContent = 'Drive is not configured for this site'; return; }
    try {
      driveButton.disabled = true; if (badge) badge.textContent = 'Connecting to Google Drive…';
      if (!window.google?.accounts?.oauth2) throw new Error('Drive sign-in is still loading. Try again in a moment.');
      const token = await new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: 'https://www.googleapis.com/auth/drive.appdata',
          callback: (result) => result.error ? reject(new Error(result.error_description || result.error)) : resolve(result.access_token),
          error_callback: (error) => reject(new Error(error.message || 'Drive authorization was canceled')) });
        client.requestAccessToken({ prompt: '' });
      });
      driveToken = token;
      if (lastProject) await saveProjectRecord(lastProject.name, lastProject.json);
      await syncProjectToDrive();
      if (badge) badge.textContent = 'Drive copy saved · local saves kept';
    } catch (error) { if (badge) badge.textContent = error.message; }
    finally { driveToken = null; driveButton.disabled = false; }
  });
}

window.addEventListener('beforeunload', () => { for (const url of urls.values()) URL.revokeObjectURL(url); });
