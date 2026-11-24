// Platform bridge: Tauri commands, native import, media probing, thumbnails and waveform peaks.
import { invoke as tauriInvoke, convertFileSrc } from './tauri.js';

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpeg', 'mpg'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];

export const ACCEPTED = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];

export function extensionOf(name) {
  const parts = String(name).split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function kindOf(name, mime = '') {
  const ext = extensionOf(name);
  if (mime.startsWith('video')) return 'video';
  if (mime.startsWith('audio')) return 'audio';
  if (mime.startsWith('image')) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return 'video';
}

export function fileUrl(path) {
  return convertFileSrc(path);
}

export async function command(name, args) {
  return tauriInvoke(name, args);
}

export async function openMediaDialog() {
  try {
    const picked = await tauriInvoke('plugin:dialog|open', {
      options: {
        multiple: true,
        directory: false,
        title: 'Add media to Tacot Edit',
        filters: [
          { name: 'Video', extensions: VIDEO_EXT },
          { name: 'Audio', extensions: AUDIO_EXT },
          { name: 'Images', extensions: IMAGE_EXT },
          { name: 'All supported', extensions: ACCEPTED },
        ],
      },
    });
    if (!picked) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch (err) {
    console.warn('native open dialog unavailable', err);
    return null;
  }
}

/** Copy a file from disk into the app media cache. */
export async function importPath(path) {
  const name = String(path).split(/[\\/]/).pop();
  const result = await tauriInvoke('media_import_path', { path });
  return { ...result, name: result.name || name, kind: kindOf(name) };
}

/** Import dropped File objects (browser fallback): sends bytes to Rust when available. */
export async function importFile(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  const stored = await tauriInvoke('media_import', { name: file.name, bytes: Array.from(buffer) });
  return { ...stored, kind: kindOf(file.name, file.type), name: file.name };
}

function probeElement(kind, url) {
  return new Promise((resolve, reject) => {
    const el = kind === 'audio' ? document.createElement('audio') : document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    el.src = url;
    const cleanup = () => {
      el.removeAttribute('src');
      el.load();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out reading media'));
    }, 12000);
    el.addEventListener(
      'loadedmetadata',
      () => {
        clearTimeout(timer);
        const info = {
          duration: Number.isFinite(el.duration) ? el.duration : 0,
          width: el.videoWidth || 0,
          height: el.videoHeight || 0,
        };
        cleanup();
        resolve(info);
      },
      { once: true },
    );
    el.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        cleanup();
        reject(new Error('this file could not be decoded'));
      },
      { once: true },
    );
  });
}

/** Grab N evenly spaced frames for the timeline filmstrip. */
async function filmstrip(url, duration, count = 8) {
  if (!duration || duration <= 0) return [];
  const el = document.createElement('video');
  el.preload = 'auto';
  el.muted = true;
  el.playsInline = true;
  el.src = url;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('thumbnail timeout')), 12000);
    el.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    el.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('thumbnail decode failed'));
    }, { once: true });
  }).catch(() => null);

  const canvas = document.createElement('canvas');
  const width = 160;
  const height = Math.max(2, Math.round((width * (el.videoHeight || 9)) / (el.videoWidth || 16)));
  canvas.width = width;
  canvas.height = Math.min(160, height);
  const ctx = canvas.getContext('2d');
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const at = Math.min(duration - 0.05, (duration * (i + 0.5)) / count);
    el.currentTime = Math.max(0, at);
    // eslint-disable-next-line no-await-in-loop
    const ok = await new Promise((resolve) => {
      const done = () => resolve(true);
      el.addEventListener('seeked', done, { once: true });
      setTimeout(() => resolve(false), 1500);
    });
    if (!ok) break;
    ctx.fillStyle = '#15171d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try {
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    } catch {
      break;
    }
    frames.push(canvas.toDataURL('image/jpeg', 0.6));
  }
  el.removeAttribute('src');
  el.load();
  return frames;
}

/** Try to decode an audio track for the timeline waveform; fall back to a synthetic envelope. */
async function waveform(url, duration, kind) {
  const bars = 220;
  try {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await audioCtx.decodeAudioData(bytes.slice(0));
    const channel = audio.getChannelData(0);
    const step = Math.floor(channel.length / bars) || 1;
    const peaks = [];
    for (let i = 0; i < bars; i += 1) {
      let sum = 0;
      for (let j = 0; j < step; j += 1) sum += Math.abs(channel[i * step + j] || 0);
      peaks.push(Math.min(1, (sum / step) * 3.2));
    }
    audioCtx.close();
    return peaks;
  } catch {
    if (kind === 'image') return [];
    const peaks = [];
    for (let i = 0; i < bars; i += 1) {
      const envelope = 0.32 + 0.3 * Math.sin(i / 7) + 0.18 * Math.sin(i / 2.3 + 1.7);
      peaks.push(Math.max(0.06, Math.min(1, Math.abs(envelope) * (0.6 + 0.4 * Math.random()))));
    }
    return peaks;
  }
}

/** Full media descriptor: metadata, filmstrip and waveform. */
export async function describeMedia(entry) {
  const url = fileUrl(entry.path);
  const kind = entry.kind || kindOf(entry.name);
  let info = { duration: kind === 'image' ? 5 : 0, width: 0, height: 0 };
  if (kind !== 'image') {
    try {
      info = await probeElement(kind, url);
    } catch (err) {
      info = { ...info, error: err.message };
    }
  } else {
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image failed'));
        img.src = url;
      });
      info = { duration: 5, width: image.naturalWidth, height: image.naturalHeight };
    } catch {
      info = { duration: 5, width: 0, height: 0 };
    }
  }
  const frames = kind === 'video' ? await filmstrip(url, info.duration).catch(() => []) : [];
  const peaks = await waveform(url, info.duration, kind).catch(() => []);
  return {
    ...entry,
    kind,
    duration: info.duration || (kind === 'image' ? 5 : 0),
    width: info.width || 0,
    height: info.height || 0,
    frames,
    peaks,
    error: info.error || null,
  };
}

export function thumbnailFor(media, ratio = 0) {
  if (!media || !media.frames || media.frames.length === 0) return null;
  const index = Math.min(media.frames.length - 1, Math.max(0, Math.floor(ratio * media.frames.length)));
  return media.frames[index];
}

export async function saveProject(name, json) {
  return tauriInvoke('project_save', { name, json });
}

export async function loadProject(name) {
  return tauriInvoke('project_load', { name });
}

export async function listProjects() {
  try {
    return await tauriInvoke('project_list');
  } catch {
    return [];
  }
}

export async function deleteProject(name) {
  return tauriInvoke('project_delete', { name });
}

export async function autosave(json) {
  return tauriInvoke('autosave_write', { json });
}

export async function readAutosave() {
  try {
    return await tauriInvoke('autosave_read');
  } catch {
    return null;
  }
}

export async function checkFfmpeg() {
  try {
    return await tauriInvoke('ffmpeg_check');
  } catch {
    return { found: false, path: '', version: '' };
  }
}

export async function exportDir() {
  try {
    return await tauriInvoke('export_dir');
  } catch {
    return '';
  }
}

export function mimeFor(ext) {
  const map = {
    webm: 'video/webm',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  };
  return map[ext] || '';
}
