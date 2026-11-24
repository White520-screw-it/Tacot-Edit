// Pure project/timeline math for Tacot Edit. No DOM, no Tauri — unit tested in Node.

export const APP_VERSION = '0.1.0';
export const PROJECT_VERSION = 3;

export const ASPECTS = {
  '16:9': { width: 1920, height: 1080, label: '16:9 · Landscape' },
  '9:16': { width: 1080, height: 1920, label: '9:16 · Vertical' },
  '1:1': { width: 1080, height: 1080, label: '1:1 · Square' },
  '4:5': { width: 1080, height: 1350, label: '4:5 · Portrait' },
  '4:3': { width: 1440, height: 1080, label: '4:3 · Classic' },
  '21:9': { width: 2560, height: 1080, label: '21:9 · Cinematic' },
};

export const TRACK_KINDS = ['text', 'overlay', 'video', 'audio'];

/** Paint order: index 0 is the topmost layer. */
export const TRACK_PRIORITY = { text: 0, overlay: 1, video: 2, audio: 3 };

/** Keep text above overlays above video above audio, preserving order within a kind. */
export function sortTracks(project) {
  project.tracks = project.tracks
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const pa = TRACK_PRIORITY[a.track.kind] ?? 9;
      const pb = TRACK_PRIORITY[b.track.kind] ?? 9;
      return pa === pb ? a.index - b.index : pa - pb;
    })
    .map((entry) => entry.track);
  return project.tracks;
}

export const TRANSITIONS = [
  { id: 'none', label: 'None' },
  { id: 'crossfade', label: 'Cross Dissolve' },
  { id: 'dipblack', label: 'Dip to Black' },
  { id: 'dipwhite', label: 'Dip to White' },
  { id: 'slideleft', label: 'Slide Left' },
  { id: 'slideright', label: 'Slide Right' },
  { id: 'slideup', label: 'Slide Up' },
  { id: 'zoomin', label: 'Zoom In' },
  { id: 'zoomout', label: 'Zoom Out' },
  { id: 'blur', label: 'Blur Dissolve' },
  { id: 'wipe', label: 'Wipe' },
  { id: 'spin', label: 'Spin' },
];

export const EFFECTS = [
  { id: 'none', label: 'None' },
  { id: 'grain', label: 'Film Grain' },
  { id: 'vignette', label: 'Vignette' },
  { id: 'glow', label: 'Glow' },
  { id: 'chroma', label: 'Chromatic' },
  { id: 'pixelate', label: 'Pixelate' },
  { id: 'mirror', label: 'Mirror' },
  { id: 'vhs', label: 'VHS' },
  { id: 'scanlines', label: 'Scanlines' },
  { id: 'leak', label: 'Light Leak' },
  { id: 'shake', label: 'Camera Shake' },
  { id: 'pulse', label: 'Zoom Pulse' },
  { id: 'blur', label: 'Soft Focus' },
];

export const FILTERS = [
  { id: 'none', label: 'Original', css: '' },
  { id: 'warm', label: 'Golden Hour', css: 'saturate(1.15) contrast(1.06) sepia(0.12) brightness(1.04)' },
  { id: 'cool', label: 'Arctic', css: 'saturate(0.92) contrast(1.1) hue-rotate(-8deg) brightness(1.02)' },
  { id: 'mono', label: 'Monochrome', css: 'grayscale(1) contrast(1.12)' },
  { id: 'noir', label: 'Noir', css: 'grayscale(1) contrast(1.45) brightness(0.92)' },
  { id: 'fade', label: 'Faded Film', css: 'saturate(0.78) contrast(0.88) brightness(1.08) sepia(0.08)' },
  { id: 'vivid', label: 'Vivid Pop', css: 'saturate(1.45) contrast(1.12)' },
  { id: 'cinema', label: 'Cinema', css: 'contrast(1.16) saturate(1.05) brightness(0.97) sepia(0.05)' },
  { id: 'mint', label: 'Mint', css: 'hue-rotate(28deg) saturate(1.1) brightness(1.03)' },
  { id: 'sunset', label: 'Sunset', css: 'sepia(0.28) saturate(1.3) contrast(1.05) hue-rotate(-12deg)' },
  { id: 'chrome', label: 'Chrome', css: 'contrast(1.28) saturate(1.2) brightness(1.05)' },
  { id: 'dream', label: 'Dreamy', css: 'brightness(1.06) saturate(1.12) blur(0.4px) contrast(0.96)' },
];

export const TEXT_ANIMATIONS = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade Up' },
  { id: 'pop', label: 'Pop' },
  { id: 'slideup', label: 'Slide Up' },
  { id: 'slidedown', label: 'Slide Down' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'word', label: 'Word Reveal' },
  { id: 'scale', label: 'Grow' },
];

export const FONTS = [
  { id: 'display', label: 'Editorial Serif', stack: 'Georgia, "Times New Roman", serif' },
  { id: 'sans', label: 'Clean Grotesk', stack: '"Segoe UI", "Helvetica Neue", Arial, sans-serif' },
  { id: 'mono', label: 'Technical Mono', stack: '"Cascadia Mono", Consolas, "Courier New", monospace' },
  { id: 'condensed', label: 'Condensed Impact', stack: '"Arial Narrow", "Haettenschweiler", Impact, sans-serif' },
  { id: 'rounded', label: 'Friendly Rounded', stack: '"Trebuchet MS", "Segoe UI", sans-serif' },
];

const EASES = {
  linear: (p) => p,
  easeIn: (p) => p * p,
  easeOut: (p) => 1 - (1 - p) * (1 - p),
  easeInOut: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
  hold: () => 0,
};

let counter = 0;

export function uid(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function easeValue(ease, progress) {
  const fn = EASES[ease] || EASES.linear;
  return fn(clamp(progress, 0, 1));
}

export function defaultAdjust() {
  return {
    exposure: 1,
    contrast: 1,
    saturation: 1,
    temperature: 0,
    tint: 0,
    sharpen: 0,
    vignette: 0,
  };
}

export function defaultTransform() {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false };
}

export function defaultCrop() {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

export function createClip(kind, props = {}) {
  const base = {
    id: uid('clip'),
    kind,
    name: props.name || 'Clip',
    start: Math.max(0, props.start ?? 0),
    in: Math.max(0, props.in ?? 0),
    out: Math.max(0.1, props.out ?? 5),
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    transform: defaultTransform(),
    crop: defaultCrop(),
    adjust: defaultAdjust(),
    filter: 'none',
    effect: { id: 'none', amount: 0.5 },
    transition: { id: 'none', duration: 0.5 },
    keyframes: {},
    mediaKey: null,
    ext: null,
    text: null,
    color: '#1b1d24',
    label: props.label || null,
  };

  if (kind === 'text') {
    base.out = base.in + (props.duration ?? 4);
    base.text = {
      content: 'Your headline',
      font: 'display',
      size: 96,
      weight: 700,
      color: '#ffffff',
      align: 'center',
      letterSpacing: 0,
      lineHeight: 1.15,
      strokeColor: '#000000',
      strokeWidth: 0,
      shadow: 0.45,
      background: 'none',
      bgColor: '#000000',
      bgOpacity: 0.45,
      padX: 48,
      padY: 28,
      radius: 18,
      animation: 'fade',
      maxWidth: 0.8,
    };
  }

  return { ...base, ...props, keyframes: props.keyframes || {}, text: props.text ?? base.text };
}

export function trackKindFor(mediaKind) {
  if (mediaKind === 'audio') return 'audio';
  if (mediaKind === 'image') return 'video';
  return 'video';
}

export function createTrack(kind, name) {
  const labels = { text: 'Text', overlay: 'Overlay', video: 'Video', audio: 'Audio' };
  return {
    id: uid('track'),
    kind,
    name: name || labels[kind] || 'Track',
    muted: false,
    locked: false,
    hidden: false,
    clips: [],
  };
}

export function createProject(title = 'Untitled Project') {
  return {
    version: PROJECT_VERSION,
    name: title,
    aspect: '16:9',
    width: ASPECTS['16:9'].width,
    height: ASPECTS['16:9'].height,
    fps: 30,
    background: { type: 'color', color: '#07080b', blur: 28 },
    range: { in: null, out: null },
    markers: [],
    media: [],
    tracks: [createTrack('overlay', 'Overlay 1'), createTrack('video', 'Video 1'), createTrack('audio', 'Audio 1')],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function clipDuration(clip) {
  if (clip.kind === 'text') return Math.max(0.05, clip.out - clip.in);
  const speed = clip.speed > 0 ? clip.speed : 1;
  return Math.max(0.05, (clip.out - clip.in) / speed);
}

export function clipEnd(clip) {
  return clip.start + clipDuration(clip);
}

export function sequenceDuration(project) {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  }
  return Math.max(end, 1);
}

export function allClips(project) {
  return project.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));
}

/** Every distinct local time that carries a keyframe on this clip. */
export function keyframeTimes(clip) {
  const times = new Set();
  for (const list of Object.values(clip.keyframes || {})) {
    for (const frame of list) times.add(round2(frame.t));
  }
  return [...times].sort((a, b) => a - b);
}

/** Resolve the export/playback window from the optional in/out range. */
export function rangeWindow(project) {
  const total = sequenceDuration(project);
  const start = Number.isFinite(project.range?.in) ? Math.max(0, project.range.in) : 0;
  const end = Number.isFinite(project.range?.out) ? Math.min(total, project.range.out) : total;
  if (end - start < 0.2) return { start: 0, end: total, active: false };
  return { start, end, active: start > 0.001 || end < total - 0.001 };
}

export function sortClips(track) {
  track.clips.sort((a, b) => a.start - b.start);
  return track;
}

/** Source time inside the media file for a timeline instant. */
export function sourceTimeAt(clip, time) {
  const local = time - clip.start;
  const speed = clip.speed > 0 ? clip.speed : 1;
  return clamp(clip.in + local * speed, clip.in, clip.in + (clip.out - clip.in));
}

export function localTimeOf(clip, time) {
  return clamp(time - clip.start, 0, clipDuration(clip));
}

export function findClipAt(track, time) {
  return track.clips.find((clip) => time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) || null;
}

export function clipAt(project, trackId, time) {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  return findClipAt(track, time);
}

export function upsertKeyframe(clip, property, time, value, ease = 'linear') {
  const list = clip.keyframes[property] ? [...clip.keyframes[property]] : [];
  const at = Math.max(0, round2(time));
  const index = list.findIndex((frame) => Math.abs(frame.t - at) < 0.02);
  if (index >= 0) list[index] = { t: at, v: value, ease };
  else list.push({ t: at, v: value, ease });
  list.sort((a, b) => a.t - b.t);
  clip.keyframes[property] = list;
  return clip;
}

export function removeKeyframe(clip, property, time) {
  const list = (clip.keyframes[property] || []).filter((frame) => Math.abs(frame.t - time) >= 0.02);
  if (list.length) clip.keyframes[property] = list;
  else delete clip.keyframes[property];
  return clip;
}

/** Interpolated value for a keyframed property, or the static fallback. */
export function keyedValue(clip, property, fallback, time) {
  const list = clip.keyframes && clip.keyframes[property];
  if (!list || list.length === 0) return fallback;
  const local = time - clip.start;
  if (list.length === 1) return list[0].v;
  if (local <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (local >= last.t) return last.v;
  for (let i = 0; i < list.length - 1; i += 1) {
    const a = list[i];
    const b = list[i + 1];
    if (local >= a.t && local <= b.t) {
      const span = b.t - a.t || 1;
      const progress = (local - a.t) / span;
      return a.v + (b.v - a.v) * easeValue(a.ease, progress);
    }
  }
  return fallback;
}

export function fadeGain(clip, time) {
  const local = time - clip.start;
  const duration = clipDuration(clip);
  let gain = 1;
  if (clip.fadeIn > 0 && local < clip.fadeIn) gain = Math.min(gain, local / clip.fadeIn);
  const tail = duration - local;
  if (clip.fadeOut > 0 && tail < clip.fadeOut) gain = Math.min(gain, Math.max(0, tail / clip.fadeOut));
  return clamp(gain, 0, 1);
}

export function volumeAt(clip, time) {
  const keyed = keyedValue(clip, 'volume', clip.volume, time);
  return clamp(keyed * fadeGain(clip, time), 0, 2);
}

export function transformAt(clip, time) {
  const base = clip.transform;
  return {
    x: keyedValue(clip, 'x', base.x, time),
    y: keyedValue(clip, 'y', base.y, time),
    scale: keyedValue(clip, 'scale', base.scale, time),
    rotation: keyedValue(clip, 'rotation', base.rotation, time),
    opacity: clamp(keyedValue(clip, 'opacity', base.opacity, time), 0, 1),
    flipH: base.flipH,
    flipV: base.flipV,
  };
}

/** CSS filter string combining the clip's preset, manual adjustment and keyframed exposure. */
export function cssFilterFor(clip, time) {
  const preset = FILTERS.find((item) => item.id === clip.filter);
  const parts = [];
  if (preset && preset.css) parts.push(preset.css);
  const adjust = clip.adjust || defaultAdjust();
  const exposure = keyedValue(clip, 'exposure', adjust.exposure, time);
  if (Math.abs(exposure - 1) > 0.001) parts.push(`brightness(${exposure.toFixed(3)})`);
  if (Math.abs(adjust.contrast - 1) > 0.001) parts.push(`contrast(${adjust.contrast.toFixed(3)})`);
  if (Math.abs(adjust.saturation - 1) > 0.001) parts.push(`saturate(${adjust.saturation.toFixed(3)})`);
  if (Math.abs(adjust.temperature) > 0.001) {
    parts.push(adjust.temperature > 0 ? `sepia(${(adjust.temperature * 0.4).toFixed(3)})` : `hue-rotate(${(adjust.temperature * 24).toFixed(1)}deg)`);
  }
  if (Math.abs(adjust.tint) > 0.001) parts.push(`hue-rotate(${(adjust.tint * 30).toFixed(1)}deg)`);
  if (adjust.sharpen > 0.001) parts.push(`contrast(${(1 + adjust.sharpen * 0.18).toFixed(3)})`);
  return parts.join(' ') || 'none';
}

export function snapCandidates(project, excludeId = null) {
  const points = new Set([0]);
  for (const { clip } of allClips(project)) {
    if (clip.id === excludeId) continue;
    points.add(round2(clip.start));
    points.add(round2(clipEnd(clip)));
  }
  points.add(round2(sequenceDuration(project)));
  return [...points].sort((a, b) => a - b);
}

export function snapTime(value, candidates, threshold, enabled = true) {
  if (!enabled) return { time: Math.max(0, value), snapped: null };
  let best = null;
  for (const point of candidates) {
    const delta = Math.abs(point - value);
    if (delta <= threshold && (best === null || delta < Math.abs(best - value))) best = point;
  }
  return best === null ? { time: Math.max(0, value), snapped: null } : { time: best, snapped: best };
}

/** Trim one edge of a clip, keeping the opposite edge fixed on the timeline. */
export function trimClip(clip, edge, time, minDuration = 0.1) {
  const duration = clipDuration(clip);
  if (edge === 'start') {
    const maxStart = clip.start + duration - minDuration;
    const nextStart = clamp(time, Math.max(0, clip.start - clip.in / (clip.speed || 1)), maxStart);
    const delta = nextStart - clip.start;
    const speed = clip.speed > 0 ? clip.speed : 1;
    if (clip.kind === 'text') {
      clip.in = Math.max(0, clip.in + delta);
    } else {
      clip.in = clamp(clip.in + delta * speed, 0, clip.out - minDuration);
    }
    clip.start = Math.max(0, nextStart);
  } else {
    const minEnd = clip.start + minDuration;
    const nextEnd = Math.max(minEnd, time);
    if (clip.kind !== 'text') {
      const speed = clip.speed > 0 ? clip.speed : 1;
      clip.out = clip.in + (nextEnd - clip.start) * speed;
    } else {
      clip.out = clip.in + (nextEnd - clip.start);
    }
  }
  return clip;
}

const EPS = 1e-6;

/** Trim an existing clip's tail so it ends at `end` (keeps object identity). */
function trimTailTo(clip, end) {
  const speed = clip.speed > 0 ? clip.speed : 1;
  if (clip.kind === 'text') clip.out = clip.in + Math.max(0.05, end - clip.start);
  else clip.out = clip.in + Math.max(0.05, end - clip.start) * speed;
}

/** Move an existing clip's head so it starts at `start` (keeps object identity). */
function trimHeadTo(clip, start) {
  const speed = clip.speed > 0 ? clip.speed : 1;
  const delta = start - clip.start;
  if (clip.kind === 'text') clip.in = Math.max(0, clip.in + delta);
  else clip.in = Math.max(0, clip.in + delta * speed);
  clip.start = start;
}

function coveredRemoval(track, clip) {
  const start = clip.start;
  const end = clipEnd(clip);
  const kept = [];
  for (const other of track.clips) {
    if (other.id === clip.id) {
      kept.push(other);
      continue;
    }
    const otherStart = other.start;
    const otherEnd = clipEnd(other);
    if (otherEnd <= start + EPS || otherStart >= end - EPS) {
      kept.push(other);
      continue;
    }
    if (otherStart >= start - EPS && otherEnd <= end + EPS) continue; // fully covered
    if (otherStart < start && otherEnd > end) {
      // Split around the incoming clip: trim the original, append a shifted copy.
      const tail = { ...other, id: uid('clip'), keyframes: structuredCloneSafe(other.keyframes) };
      trimTailTo(other, start);
      trimHeadTo(tail, end);
      tail.keyframes = shiftKeyframes(tail.keyframes, -(end - otherStart));
      kept.push(other, tail);
      continue;
    }
    if (otherStart < start) {
      trimTailTo(other, start);
      kept.push(other);
      continue;
    }
    trimHeadTo(other, end);
    kept.push(other);
  }
  track.clips = kept;
}

function structuredCloneSafe(value) {
  return value ? JSON.parse(JSON.stringify(value)) : {};
}

/** Overwrite-style placement: dragging a clip over others trims or splits them. */
export function placeClip(track, clip) {
  clip.start = Math.max(0, round2(clip.start));
  coveredRemoval(track, clip);
  if (!track.clips.some((item) => item.id === clip.id)) track.clips.push(clip);
  sortClips(track);
  return clip;
}

export function moveClipToTrack(project, clipId, targetTrackId, newStart) {
  let found = null;
  for (const track of project.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) {
      found = track.clips[index];
      track.clips.splice(index, 1);
      break;
    }
  }
  if (!found) return null;
  const target = project.tracks.find((track) => track.id === targetTrackId);
  if (!target) return null;
  found.start = Math.max(0, newStart);
  placeClip(target, found);
  return found;
}

/** Split a clip at a timeline instant, returning the new right-hand clip. */
export function splitClip(project, clipId, time) {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index < 0) continue;
    const clip = track.clips[index];
    const duration = clipDuration(clip);
    const local = time - clip.start;
    if (local <= 0.05 || local >= duration - 0.05) return null;
    const speed = clip.speed > 0 ? clip.speed : 1;
    const right = JSON.parse(JSON.stringify(clip));
    right.id = uid('clip');
    right.start = round2(clip.start + local);
    if (clip.kind === 'text') {
      right.in = clip.in + local;
      right.out = clip.out;
      clip.out = clip.in + local;
    } else {
      right.in = clip.in + local * speed;
      right.out = clip.out;
      clip.out = clip.in + local * speed;
    }
    right.keyframes = shiftKeyframes(right.keyframes, -local);
    track.clips.splice(index + 1, 0, right);
    sortClips(track);
    return right;
  }
  return null;
}

function shiftKeyframes(keyframes, delta) {
  const shifted = {};
  for (const [property, list] of Object.entries(keyframes || {})) {
    shifted[property] = list.map((frame) => ({ ...frame, t: Math.max(0, round2(frame.t + delta)) }));
    if (!shifted[property].length) delete shifted[property];
  }
  return shifted;
}

export function deleteClip(project, clipId) {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((clip) => clip.id === clipId);
    if (index >= 0) {
      const [removed] = track.clips.splice(index, 1);
      return removed;
    }
  }
  return null;
}

/** Close the gap left by a clip, sliding everything after it on the same track. */
export function rippleClose(project, trackId, atTime) {
  const track = project.tracks.find((item) => item.id === trackId);
  if (!track) return;
  const removed = track.clips.find((clip) => Math.abs(clip.start - atTime) < 0.35);
  if (!removed) return;
  const gap = clipDuration(removed);
  const after = track.clips.filter((clip) => clip.start > removed.start).sort((a, b) => a.start - b.start);
  for (const clip of after) clip.start = Math.max(0, round2(clip.start - gap));
  deleteClip(project, removed.id);
}

export function duplicateClip(project, clipId) {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (!clip) continue;
    const copy = JSON.parse(JSON.stringify(clip));
    copy.id = uid('clip');
    copy.start = round2(clipEnd(clip));
    placeClip(track, copy);
    return copy;
  }
  return null;
}

export function formatTimecode(seconds, fps = 30) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const frames = Math.floor((total - Math.floor(total)) * fps);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}:${pad(frames)}`;
}

export function parseTimecode(text) {
  const parts = String(text).trim().split(':').map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 30;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

export function displayDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function aspectSize(aspect) {
  return ASPECTS[aspect] || ASPECTS['16:9'];
}

export function setAspect(project, aspect) {
  const size = aspectSize(aspect);
  project.aspect = aspect;
  project.width = size.width;
  project.height = size.height;
  return project;
}

const NUMERIC_FIELDS = ['start', 'in', 'out', 'speed', 'volume', 'fadeIn', 'fadeOut'];

/** Validate and repair a loaded project so a bad field can never wedge the UI. */
export function normalizeProject(raw) {
  const base = createProject();
  if (!raw || typeof raw !== 'object') return base;

  const project = {
    ...base,
    ...raw,
    version: PROJECT_VERSION,
    background: { ...base.background, ...(raw.background || {}) },
    media: Array.isArray(raw.media) ? raw.media.filter((item) => item && item.key) : [],
    tracks: [],
  };

  project.width = Number.isFinite(project.width) ? project.width : base.width;
  project.height = Number.isFinite(project.height) ? project.height : base.height;
  project.fps = Number.isFinite(project.fps) && project.fps >= 12 ? project.fps : 30;

  const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  for (const track of tracks) {
    if (!track || !TRACK_KINDS.includes(track.kind)) continue;
    const next = createTrack(track.kind, track.name);
    next.id = track.id || next.id;
    next.muted = Boolean(track.muted);
    next.locked = Boolean(track.locked);
    next.hidden = Boolean(track.hidden);
    const clips = Array.isArray(track.clips) ? track.clips : [];
    for (const clip of clips) {
      if (!clip || typeof clip !== 'object') continue;
      const kind = clip.kind === 'text' || clip.kind === 'audio' ? clip.kind : 'video';
      const created = createClip(kind, {});
      const merged = {
        ...created,
        ...clip,
        kind,
        transform: { ...created.transform, ...(clip.transform || {}) },
        crop: { ...created.crop, ...(clip.crop || {}) },
        adjust: { ...created.adjust, ...(clip.adjust || {}) },
        effect: { ...created.effect, ...(clip.effect || {}) },
        transition: { ...created.transition, ...(clip.transition || {}) },
        keyframes: clip.keyframes && typeof clip.keyframes === 'object' ? clip.keyframes : {},
        text: created.text ? { ...created.text, ...(clip.text || {}) } : null,
      };
      for (const field of NUMERIC_FIELDS) {
        if (!Number.isFinite(merged[field])) merged[field] = created[field];
      }
      if (merged.speed <= 0) merged.speed = 1;
      if (merged.out <= merged.in) merged.out = merged.in + 1;
      merged.start = Math.max(0, merged.start);
      next.clips.push(merged);
    }
    sortClips(next);
    project.tracks.push(next);
  }

  if (project.tracks.length === 0) project.tracks = base.tracks;
  project.range = {
    in: Number.isFinite(raw.range?.in) ? Math.max(0, raw.range.in) : null,
    out: Number.isFinite(raw.range?.out) ? Math.max(0, raw.range.out) : null,
  };
  project.markers = Array.isArray(raw.markers)
    ? raw.markers
        .filter((marker) => marker && Number.isFinite(marker.time))
        .map((marker) => ({
          id: marker.id || uid('mark'),
          time: Math.max(0, marker.time),
          label: marker.label || 'Marker',
          color: marker.color || '#2ad6c4',
        }))
        .sort((a, b) => a.time - b.time)
    : [];
  sortTracks(project);
  return project;
}

export function estimateExportBytes(duration, width, height, fps) {
  const pixels = width * height * (fps || 30) * Math.max(0.1, duration);
  return Math.round(pixels * 0.07);
}

export function projectStats(project) {
  const clips = allClips(project);
  const video = clips.filter(({ clip }) => clip.kind === 'video').length;
  const audio = clips.filter(({ clip }) => clip.kind === 'audio').length;
  const text = clips.filter(({ clip }) => clip.kind === 'text').length;
  return {
    clips: clips.length,
    video,
    audio,
    text,
    duration: sequenceDuration(project),
    tracks: project.tracks.length,
    keyframes: clips.reduce(
      (total, { clip }) => total + Object.values(clip.keyframes || {}).reduce((sum, list) => sum + list.length, 0),
      0,
    ),
  };
}
