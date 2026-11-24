// Pure automation helpers: caption chunking, silence/beat/scene detection, loudness and colour analysis.
import { clamp, createClip, uid } from './model.js';

export const CAPTION_STYLES = [
  {
    id: 'bold',
    label: 'Bold Caption',
    font: 'sans',
    size: 62,
    weight: 800,
    color: '#ffffff',
    strokeWidth: 8,
    strokeColor: '#000000',
    shadow: 0.5,
    background: 'none',
    animation: 'pop',
    maxWidth: 0.7,
    lineHeight: 1.12,
    letterSpacing: 0,
    uppercase: true,
  },
  {
    id: 'clean',
    label: 'Clean',
    font: 'sans',
    size: 52,
    weight: 550,
    color: '#ffffff',
    strokeWidth: 0,
    strokeColor: '#000000',
    shadow: 0.55,
    background: 'none',
    animation: 'fade',
    maxWidth: 0.74,
    lineHeight: 1.2,
    letterSpacing: 0,
    uppercase: false,
  },
  {
    id: 'boxed',
    label: 'Boxed',
    font: 'sans',
    size: 46,
    weight: 650,
    color: '#ffffff',
    strokeWidth: 0,
    strokeColor: '#000000',
    shadow: 0.2,
    background: 'box',
    bgColor: '#0b0c0f',
    bgOpacity: 0.82,
    animation: 'slideup',
    maxWidth: 0.66,
    lineHeight: 1.18,
    letterSpacing: 0,
    uppercase: false,
  },
  {
    id: 'doc',
    label: 'Documentary',
    font: 'display',
    size: 44,
    weight: 600,
    color: '#f4f1ea',
    strokeWidth: 0,
    strokeColor: '#000000',
    shadow: 0.35,
    background: 'none',
    animation: 'fade',
    maxWidth: 0.62,
    lineHeight: 1.28,
    letterSpacing: 1,
    uppercase: false,
  },
  {
    id: 'mono',
    label: 'Technical',
    font: 'mono',
    size: 38,
    weight: 600,
    color: '#2ad6c4',
    strokeWidth: 0,
    strokeColor: '#000000',
    shadow: 0.4,
    background: 'box',
    bgColor: '#07110f',
    bgOpacity: 0.72,
    animation: 'typewriter',
    maxWidth: 0.6,
    lineHeight: 1.3,
    letterSpacing: 2,
    uppercase: true,
  },
];

export function captionStyle(id) {
  return CAPTION_STYLES.find((style) => style.id === id) || CAPTION_STYLES[0];
}

/**
 * Split transcript segments into caption-sized chunks that keep their timing.
 * Breaks on long pauses, at a character budget and at a maximum duration.
 */
export function chunkSegments(segments, options = {}) {
  const maxChars = options.maxChars ?? 42;
  const maxDuration = options.maxDuration ?? 5.5;
  const pause = options.pause ?? 0.6;
  const minDuration = options.minDuration ?? 0.7;
  const out = [];

  const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const pushChunk = (start, end, text, limit) => {
    const trimmed = clean(text);
    if (!trimmed) return;
    let finish = Math.max(end, start + minDuration);
    let begin = start;
    if (Number.isFinite(limit) && finish > limit) {
      finish = limit;
      begin = Math.max(0, Math.min(begin, finish - minDuration));
    }
    if (finish <= begin) finish = begin + 0.05;
    out.push({ start: begin, end: finish, text: trimmed });
  };

  for (const segment of segments) {
    const text = clean(segment.text);
    if (!text) continue;
    const start = Math.max(0, segment.start);
    const end = Math.max(start + minDuration, segment.end);
    const words = text.split(' ');
    const perWord = (end - start) / Math.max(1, words.length);
    let buffer = [];
    let bufferStart = start;

    const flush = (atEnd) => {
      if (!buffer.length) return;
      const chunkText = buffer.join(' ');
      const chunkStart = bufferStart;
      const chunkEnd = Math.min(end, chunkStart + Math.max(minDuration, buffer.length * perWord));
      pushChunk(chunkStart, atEnd ? Math.max(chunkEnd, end) : chunkEnd, chunkText, end);
      buffer = [];
      bufferStart = chunkEnd;
    };

    for (const word of words) {
      const candidate = buffer.length ? `${buffer.join(' ')} ${word}` : word;
      const wouldRunLong = buffer.length > 0 && (end - bufferStart) > maxDuration;
      if ((candidate.length > maxChars || wouldRunLong) && buffer.length) {
        flush(false);
      }
      buffer.push(word);
    }
    flush(true);
  }

  // Merge tiny neighbours separated by a short pause so captions don't flicker.
  const merged = [];
  for (const chunk of out) {
    const previous = merged[merged.length - 1];
    const combinedLength = previous ? `${previous.text} ${chunk.text}`.length : Infinity;
    if (
      previous &&
      chunk.start - previous.end < pause / 3 &&
      chunk.end - previous.start <= maxDuration &&
      combinedLength <= maxChars
    ) {
      previous.text = `${previous.text} ${chunk.text}`;
      previous.end = chunk.end;
      continue;
    }
    merged.push(chunk);
  }
  return merged;
}

/** Build text clips for the caption chunks, offset onto the timeline. */
export function captionClips(chunks, style, timelineStart, sourceDuration) {
  const clips = [];
  for (const chunk of chunks) {
    const start = timelineStart + chunk.start;
    const end = timelineStart + Math.min(chunk.end, sourceDuration || chunk.end);
    if (end <= start) continue;
    const clip = createClip('text', {
      start,
      in: 0,
      out: Math.max(0.4, end - start),
      name: chunk.text.slice(0, 28),
    });
    Object.assign(clip.text, {
      content: style.uppercase ? chunk.text.toUpperCase() : chunk.text,
      font: style.font,
      size: style.size,
      weight: style.weight,
      color: style.color,
      strokeWidth: style.strokeWidth,
      strokeColor: style.strokeColor,
      shadow: style.shadow,
      background: style.background,
      bgColor: style.bgColor || '#000000',
      bgOpacity: style.bgOpacity ?? 0.45,
      animation: style.animation,
      maxWidth: style.maxWidth,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      align: 'center',
    });
    clip.transform.y = 0.34;
    clips.push(clip);
  }
  return clips;
}

/** Silent stretches from a peak envelope (0..1) spanning `duration`. */
export function silenceRanges(peaks, duration, options = {}) {
  const threshold = options.threshold ?? 0.05;
  const minLength = options.minLength ?? 0.4;
  if (!peaks || peaks.length === 0 || !duration) return [];
  const step = duration / peaks.length;
  const ranges = [];
  let runStart = null;
  peaks.forEach((peak, index) => {
    if (peak <= threshold) {
      if (runStart === null) runStart = index * step;
    } else if (runStart !== null) {
      const end = index * step;
      if (end - runStart >= minLength) ranges.push({ start: runStart, end });
      runStart = null;
    }
  });
  if (runStart !== null && duration - runStart >= minLength) {
    ranges.push({ start: runStart, end: duration });
  }
  return ranges;
}

/** Gain that brings the clip's average level toward a target RMS. */
export function normalizeGain(peaks, target = 0.16, maxGain = 3) {
  if (!peaks || peaks.length === 0) return 1;
  const usable = peaks.filter((peak) => peak > 0);
  if (!usable.length) return 1;
  const rms = Math.sqrt(usable.reduce((sum, peak) => sum + peak * peak, 0) / usable.length);
  if (rms <= 0.0001) return 1;
  return clamp(target / rms, 0.25, maxGain);
}

/** Onset times (seconds) where the energy envelope jumps, for beat markers. */
export function beatMarkers(peaks, duration, options = {}) {
  if (!peaks || peaks.length < 4 || !duration) return [];
  const sensitivity = options.sensitivity ?? 1.4;
  const step = duration / peaks.length;
  const flux = peaks.map((peak, index) => Math.max(0, peak - (peaks[index - 1] ?? peak)));
  const mean = flux.reduce((sum, value) => sum + value, 0) / flux.length;
  const variance = flux.reduce((sum, value) => sum + (value - mean) ** 2, 0) / flux.length;
  const threshold = mean + Math.sqrt(variance) * sensitivity;
  const markers = [];
  for (let index = 1; index < flux.length - 1; index += 1) {
    if (flux[index] > threshold && flux[index] >= flux[index - 1] && flux[index] >= flux[index + 1]) {
      const time = index * step;
      if (!markers.length || time - markers[markers.length - 1] > 0.18) markers.push(time);
    }
  }
  return markers.slice(0, 240);
}

/** Pick scene-change times from frame difference scores sampled every `interval`. */
export function sceneMarkers(scores, interval, options = {}) {
  const threshold = options.threshold ?? 0.16;
  const markers = [];
  scores.forEach((score, index) => {
    if (score >= threshold && (!markers.length || index * interval - markers[markers.length - 1] > 0.4)) {
      markers.push(index * interval);
    }
  });
  return markers.slice(0, 200);
}

/** Suggest neutralising colour settings from sampled frame statistics. */
export function suggestColorAdjust(stats) {
  const luma = clamp(stats.meanLuma ?? 0.5, 0, 1);
  const contrast = clamp(stats.contrast ?? 0.5, 0, 1);
  const saturation = clamp(stats.meanSaturation ?? 0.4, 0, 1);
  const balance = stats.balance || { r: 1, g: 1, b: 1 };

  const exposure = clamp(0.42 / Math.max(0.05, luma), 0.55, 1.9);
  const contrastValue = clamp(0.42 / Math.max(0.08, contrast), 0.85, 1.45);
  const saturationValue = clamp(0.34 / Math.max(0.06, saturation), 0.85, 1.7);
  const warmth = clamp((balance.r - balance.b) * 2.2, -1, 1);
  const greenBias = clamp((balance.g - (balance.r + balance.b) / 2) * 2.6, -1, 1);

  return {
    exposure: Number(exposure.toFixed(2)),
    contrast: Number(contrastValue.toFixed(2)),
    saturation: Number(saturationValue.toFixed(2)),
    temperature: Number((-warmth * 0.6).toFixed(2)),
    tint: Number((-greenBias * 0.4).toFixed(2)),
    sharpen: 0.12,
    vignette: 0,
  };
}

export function createMarker(time, label, color = '#2ad6c4') {
  return { id: uid('mark'), time: Math.max(0, time), label: label || 'Marker', color };
}

/** Drop markers that sit almost on top of one another. */
export function dedupeMarkers(markers, tolerance = 0.12) {
  const sorted = [...markers].sort((a, b) => a.time - b.time);
  const out = [];
  for (const marker of sorted) {
    const previous = out[out.length - 1];
    if (previous && Math.abs(previous.time - marker.time) < tolerance) continue;
    out.push(marker);
  }
  return out;
}
