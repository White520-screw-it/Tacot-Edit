// In-app renderer: composites the timeline in realtime, records canvas + mixed audio,
// then streams the result to disk in base64 chunks (optionally transcoding to MP4).
import { command } from './platform.js';

const CHUNK = 2 * 1024 * 1024;

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm',
  ];
  for (const mime of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function toBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function writeBlob(blob, name, ext, onStatus) {
  const id = await command('export_begin', { name, ext });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK));
    // eslint-disable-next-line no-await-in-loop
    await command('export_chunk', { id, chunk: toBase64(slice) });
    onStatus?.(`Writing ${Math.min(100, Math.round(((offset + slice.length) / bytes.length) * 100))}%`);
  }
  const saved = await command('export_finish', { id });
  return { ...saved, bytes: bytes.length };
}

export async function renderToFile(options) {
  const { store, engine, canvas, fps = 30, bitrate = 12_000_000, format = 'webm', name = 'Tacot Edit Export', onProgress, onStatus, shouldCancel } = options;
  const project = store.state.project;
  const duration = Math.max(0.2, options.duration || sequenceDuration(project));
  const startAt = Math.max(0, options.startAt || 0);

  if (!window.MediaRecorder) throw new Error('this build cannot record video');

  const mime = pickMime();
  if (!mime) throw new Error('no supported recording format');

  const audioDest = await engine.beginExportAudio();
  engine.resumeAudio();

  const stream = canvas.captureStream(fps);
  if (audioDest) {
    for (const track of audioDest.stream.getAudioTracks()) stream.addTrack(track);
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: 192_000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };

  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  onStatus?.('Priming decoder…');
  store.state.playing = false;
  engine.pauseAll();
  engine.sync(startAt, false);
  await new Promise((resolve) => setTimeout(resolve, 220));

  onStatus?.('Rendering…');
  const started = performance.now();
  recorder.start(400);

  await new Promise((resolve, reject) => {
    let cancelled = false;
    const step = () => {
      if (shouldCancel && shouldCancel()) {
        cancelled = true;
        resolve();
        return;
      }
      const elapsed = (performance.now() - started) / 1000;
      const time = Math.min(startAt + duration, startAt + elapsed);
      try {
        engine.tick(time, true);
      } catch (err) {
        reject(err);
        return;
      }
      onProgress?.(Math.min(1, elapsed / duration) * 0.96, time);
      if (elapsed >= duration) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    if (cancelled) reject(new Error('cancelled'));
  });

  await new Promise((resolve) => setTimeout(resolve, 120));
  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;
  engine.pauseAll();
  await engine.endExportAudio();

  onProgress?.(0.97, duration);
  onStatus?.('Saving…');
  const blob = new Blob(chunks, { type: 'video/webm' });
  const saved = await writeBlob(blob, name, 'webm', onStatus);

  let finalPath = saved.path;
  if (format === 'mp4') {
    if (!store.state.ffmpeg.found) {
      onStatus?.('Saved WebM (ffmpeg not found for MP4)');
      return { path: finalPath, bytes: saved.bytes, format: 'webm', note: 'ffmpeg missing' };
    }
    onStatus?.('Converting to MP4…');
    onProgress?.(0.99, duration);
    const target = saved.path.replace(/\.webm$/i, '.mp4');
    try {
      finalPath = await command('ffmpeg_transcode', { source: saved.path, target });
      await command('export_remove', { path: saved.path }).catch(() => {});
      return { path: finalPath, bytes: saved.bytes, format: 'mp4' };
    } catch (err) {
      return { path: saved.path, bytes: saved.bytes, format: 'webm', note: err.message || String(err) };
    }
  }

  onProgress?.(1, duration);
  return { path: finalPath, bytes: saved.bytes, format: 'webm' };
}

/** Capture the current frame as a lossless PNG. */
export async function renderStill({ engine, canvas, store, name = 'Tacot Edit still' }) {
  engine.draw(store.state.playhead, { guides: false });
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) resolve(result);
      else reject(new Error('could not capture the frame'));
    }, 'image/png');
  });
  const saved = await writeBlob(blob, name, 'png');
  return saved;
}
