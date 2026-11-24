// Automation features: subtitles, colour matching, loudness and marker detection.
// These never cut or rearrange the timeline — they only add captions, settings and markers.
import { command } from './platform.js';
import { extractWav } from './audio.js';
import {
  captionStyle,
  captionClips,
  chunkSegments,
  silenceRanges,
  normalizeGain,
  beatMarkers,
  sceneMarkers,
  suggestColorAdjust,
  createMarker,
  dedupeMarkers,
} from './auto-model.js';
import { clipDuration, createClip, createTrack, sortTracks } from './model.js';

const CHUNK = 2 * 1024 * 1024;

function toBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

async function writeTempWav(wav, name) {
  const id = await command('temp_begin', { name, ext: '.wav' });
  for (let offset = 0; offset < wav.length; offset += CHUNK) {
    const slice = wav.subarray(offset, Math.min(wav.length, offset + CHUNK));
    // eslint-disable-next-line no-await-in-loop
    await command('temp_chunk', { id, chunk: toBase64(slice) });
  }
  return command('temp_finish', { id });
}

export function createAutomation({ store, engine, app }) {
  function project() {
    return store.state.project;
  }

  function mediaFor(clip) {
    return project().media.find((item) => item.key === clip.mediaKey) || null;
  }

  function clipsToProcess() {
    const selected = store.selectedClips();
    if (selected.length) return selected.filter(({ clip }) => clip.mediaKey && clip.kind !== 'text');
    return store.state.project.tracks
      .filter((track) => track.kind !== 'text' && !track.hidden)
      .flatMap((track) => track.clips.filter((clip) => clip.mediaKey).map((clip) => ({ clip, track })))
      .sort((a, b) => a.clip.start - b.clip.start);
  }

  function captionTrack() {
    return project().tracks.find((track) => track.kind === 'text' && /caption/i.test(track.name));
  }

  function ensureCaptionTrack() {
    let track = captionTrack();
    if (track) return track;
    track = createTrack('text', 'Captions');
    store.mutate('add caption track', (draft) => {
      draft.tracks.push(track);
      sortTracks(draft);
    });
    return track;
  }

  async function engineInfo() {
    try {
      return await command('transcribe_engine');
    } catch {
      return { engine: 'unavailable', detail: 'Transcription needs the desktop app' };
    }
  }

  /** Auto subtitles for the selected clips (or every clip with audio). */
  async function autoSubtitles(options = {}) {
    const style = captionStyle(options.style || 'bold');
    const language = options.language || 'en';
    const targets = clipsToProcess();
    if (!targets.length) throw new Error('add a clip with audio first');

    const report = options.onProgress || (() => {});
    const allChunks = [];
    let engineName = '';

    for (let index = 0; index < targets.length; index += 1) {
      const { clip } = targets[index];
      const media = mediaFor(clip);
      if (!media) continue;
      report(`Listening to ${media.name} (${index + 1}/${targets.length})…`, index / targets.length);
      // eslint-disable-next-line no-await-in-loop
      const { wav, duration } = await extractWav(media);
      // eslint-disable-next-line no-await-in-loop
      const wavPath = await writeTempWav(wav, `transcribe-${media.key}`);
      report('Transcribing…', (index + 0.4) / targets.length);
      // eslint-disable-next-line no-await-in-loop
      const transcript = await command('transcribe', { wav: wavPath, language });
      command('temp_discard', { path: wavPath }).catch(() => {});
      engineName = transcript.engine;
      const sourceDuration = Math.min(duration, media.duration || duration);
      const chunks = chunkSegments(transcript.segments, {
        maxChars: options.maxChars || 42,
        maxDuration: options.maxDuration || 5.5,
      });
      // Map source time onto the timeline through the clip's speed and in-point.
      const speed = clip.speed > 0 ? clip.speed : 1;
      const offset = clip.start - clip.in / speed;
      const mapped = chunks
        .filter((chunk) => chunk.start < sourceDuration)
        .map((chunk) => ({
          start: offset + chunk.start / speed,
          end: offset + Math.min(chunk.end, sourceDuration) / speed,
          text: chunk.text,
        }))
        .filter((chunk) => chunk.end > 0);
      const clips = captionClips(mapped, style, 0, Infinity);
      for (const caption of clips) {
        if (caption.start < clip.start - 0.25 || caption.start > clip.start + clipDuration(clip) + 0.25) continue;
        allChunks.push(caption);
      }
      report(`Transcribed ${chunks.length} lines`, (index + 1) / targets.length);
    }

    if (!allChunks.length) throw new Error('no speech was recognised');

    const track = ensureCaptionTrack();
    store.mutate('auto subtitles', (draft) => {
      const target = draft.tracks.find((item) => item.id === track.id) || draft.tracks[0];
      target.clips = [];
      const seen = new Set();
      for (const caption of allChunks) {
        // Captions are one-per-instant: nudge overlaps so the last one wins cleanly.
        let start = Math.max(0, caption.start);
        while (seen.has(start.toFixed(2))) start += 0.01;
        seen.add(start.toFixed(2));
        caption.start = start;
        target.clips.push(caption);
      }
      target.clips.sort((a, b) => a.start - b.start);
    });

    return { count: allChunks.length, engine: engineName || 'unknown' };
  }

  /** Caption clips on the Captions track, in timeline order. */
  function captions() {
    const track = captionTrack();
    return track ? [...track.clips].sort((a, b) => a.start - b.start) : [];
  }

  /** Insert one editable caption at a time on the captions track. */
  function addCaptionAt(time, styleId = 'bold') {
    const track = ensureCaptionTrack();
    const style = captionStyle(styleId);
    const clip = createClip('text', {
      start: Math.max(0, Number(time) || 0),
      duration: 2.5,
      name: 'New caption',
    });
    Object.assign(clip.text, {
      content: 'New caption',
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
    store.mutate('add caption', (draft) => {
      const target = draft.tracks.find((item) => item.id === track.id) || draft.tracks[0];
      target.clips.push(clip);
      target.clips.sort((a, b) => a.start - b.start);
    });
    return clip;
  }

  function removeCaption(id) {
    store.mutate('delete caption', (draft) => {
      for (const track of draft.tracks) {
        const index = track.clips.findIndex((clip) => clip.id === id);
        if (index >= 0) track.clips.splice(index, 1);
      }
    });
  }

  function sampleFrameStats() {
    const canvas = document.getElementById('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const width = canvas.width;
    const height = canvas.height;
    const { data } = context.getImageData(0, 0, width, height);
    const step = 4 * Math.max(1, Math.floor((width * height) / 40000));
    let total = 0;
    let totalSq = 0;
    let saturation = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += step) {
      const r = data[index] / 255;
      const g = data[index + 1] / 255;
      const b = data[index + 2] / 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      total += luma;
      totalSq += luma * luma;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      saturation += max === 0 ? 0 : (max - min) / max;
      red += r;
      green += g;
      blue += b;
      count += 1;
    }
    if (!count) return null;
    const meanLuma = total / count;
    const variance = Math.max(0, totalSq / count - meanLuma * meanLuma);
    return {
      meanLuma,
      contrast: Math.sqrt(variance) * 2,
      meanSaturation: saturation / count,
      balance: { r: red / count, g: green / count, b: blue / count },
    };
  }

  /** One-click colour balance for the selected clip, measured from the current frame. */
  function autoColor() {
    const entry = store.selected();
    if (!entry) throw new Error('select a clip first');
    engine.draw(store.state.playhead, { guides: false });
    const stats = sampleFrameStats();
    if (!stats) throw new Error('could not read the frame');
    const suggestion = suggestColorAdjust(stats);
    store.mutate('auto colour', () => {
      entry.clip.adjust = { ...entry.clip.adjust, ...suggestion };
      if (entry.clip.effect.id === 'none') entry.clip.effect = { id: 'none', amount: entry.clip.effect.amount ?? 0.5 };
    });
    return suggestion;
  }

  function autoLoudness() {
    const entry = store.selected();
    if (!entry) throw new Error('select a clip first');
    const peaks = store.state.media.get(entry.clip.mediaKey)?.peaks || [];
    if (!peaks.length) throw new Error('no audio was analysed for this clip');
    const gain = normalizeGain(peaks);
    store.mutate('auto loudness', () => {
      entry.clip.volume = Number(gain.toFixed(2));
      entry.clip.fadeIn = Math.min(0.12, clipDuration(entry.clip) / 8);
      entry.clip.fadeOut = entry.clip.fadeIn;
    });
    return gain;
  }

  function addMarkers(list, color) {
    if (!list.length) return 0;
    store.mutate('add markers', (draft) => {
      if (!Array.isArray(draft.markers)) draft.markers = [];
      const fresh = list.map((time) => createMarker(time, 'Auto marker', color));
      draft.markers = dedupeMarkers([...draft.markers, ...fresh]);
    });
    return list.length;
  }

  function findSilences(options = {}) {
    const entry = store.selected();
    if (!entry) throw new Error('select a clip first');
    const media = mediaFor(entry.clip);
    const peaks = store.state.media.get(entry.clip.mediaKey)?.peaks || [];
    if (!peaks.length) throw new Error('no audio was analysed for this clip');
    const duration = Math.min(media?.duration || 0, entry.clip.out) - entry.clip.in;
    const ranges = silenceRanges(peaks, duration, options);
    if (!ranges.length) return 0;
    const speed = entry.clip.speed || 1;
    const offset = entry.clip.start - entry.clip.in / speed;
    const times = [];
    for (const range of ranges) {
      times.push(offset + range.start / speed);
      times.push(offset + range.end / speed);
    }
    return addMarkers(times.filter((time) => Number.isFinite(time) && time >= 0), '#5c6577');
  }

  function beats() {
    const entry = store.selected();
    if (!entry) throw new Error('select a clip first');
    const media = mediaFor(entry.clip);
    const peaks = store.state.media.get(entry.clip.mediaKey)?.peaks || [];
    if (!peaks.length) throw new Error('no audio was analysed for this clip');
    const duration = Math.min(media?.duration || 0, entry.clip.out) - entry.clip.in;
    const times = beatMarkers(peaks, duration);
    const speed = entry.clip.speed || 1;
    const offset = entry.clip.start - entry.clip.in / speed;
    return addMarkers(times.map((time) => offset + time / speed), '#7c5cff');
  }

  async function scenes() {
    const entry = store.selected();
    if (!entry) throw new Error('select a clip first');
    const media = mediaFor(entry.clip);
    if (!media || media.kind === 'audio') throw new Error('select a video clip first');
    const video = document.createElement('video');
    video.src = (await import('./platform.js')).fileUrl(media.path);
    video.muted = true;
    video.preload = 'auto';
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('could not read this video')), { once: true });
      setTimeout(() => reject(new Error('timed out reading the video')), 15000);
    });
    const scratch = document.createElement('canvas');
    scratch.width = 48;
    scratch.height = 27;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    const interval = 0.5;
    const start = entry.clip.in;
    const end = Math.min(video.duration || entry.clip.out, entry.clip.out);
    const scores = [];
    let previous = null;
    for (let time = start; time < end; time += interval) {
      video.currentTime = time;
      // eslint-disable-next-line no-await-in-loop
      const ok = await new Promise((resolve) => {
        video.addEventListener('seeked', () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 900);
      });
      if (!ok) break;
      context.drawImage(video, 0, 0, scratch.width, scratch.height);
      const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
      if (previous) {
        let diff = 0;
        for (let index = 0; index < data.length; index += 4) {
          diff += Math.abs(data[index] - previous[index]) + Math.abs(data[index + 1] - previous[index + 1]);
        }
        scores.push(diff / (data.length / 4) / 510);
      }
      previous = data;
    }
    video.removeAttribute('src');
    video.load();
    const times = sceneMarkers(scores, interval, { threshold: 0.18 }).map(
      (time) => entry.clip.start + (start - entry.clip.in) / (entry.clip.speed || 1) + time,
    );
    return addMarkers(times, '#2ad6c4');
  }

  /** Animate the selected text clip in and out with keyframes (no timeline changes). */
  function animateText() {
    const entry = store.selected();
    if (!entry || entry.clip.kind !== 'text') throw new Error('select a text clip first');
    const clip = entry.clip;
    const duration = clip.out - clip.in;
    store.mutate('animate text', () => {
      clip.keyframes = clip.keyframes || {};
      clip.keyframes.opacity = [
        { t: 0, v: 0, ease: 'easeOut' },
        { t: Math.min(0.45, duration / 3), v: 1, ease: 'linear' },
        { t: Math.max(0.01, duration - 0.35), v: 1, ease: 'easeIn' },
        { t: duration, v: 0, ease: 'linear' },
      ];
      clip.keyframes.y = [
        { t: 0, v: clip.transform.y + 0.04, ease: 'easeOut' },
        { t: Math.min(0.6, duration / 2), v: clip.transform.y, ease: 'linear' },
      ];
    });
    return true;
  }

  function clearMarkers() {
    const count = (project().markers || []).length;
    store.mutate('clear markers', (draft) => {
      draft.markers = [];
    });
    return count;
  }

  return {
    autoSubtitles,
    captions,
    addCaptionAt,
    removeCaption,
    engineInfo,
    autoColor,
    autoLoudness,
    findSilences,
    beats,
    scenes,
    animateText,
    clearMarkers,
    addMarkers,
    sampleFrameStats,
  };
}
