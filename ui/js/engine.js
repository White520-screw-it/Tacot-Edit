// Canvas compositor and media engine: draws the timeline at a given time and keeps
// video/audio elements in sync with the playhead.
import {
  clipDuration,
  clipEnd,
  clamp,
  cssFilterFor,
  transformAt,
  volumeAt,
  sourceTimeAt,
  textAnimationState,
  layoutText,
} from './render-model.js';
import { FONTS } from './model.js';
import { fileUrl } from './platform.js';

const FONT_STACKS = Object.fromEntries(FONTS.map((font) => [font.id, font.stack]));

export function createEngine({ canvas, store }) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const pools = new Map(); // clip.id -> { el, gain, url, kind }
  const measureCanvas = document.createElement('canvas');
  const noiseTile = buildNoiseTile();
  const scanTile = buildScanTile();
  let audioCtx = null;
  let masterGain = null;
  let masterVolume = 1;
  let exportDest = null;
  let exportMode = false;
  const exportPool = new Map(); // media.key -> { el, gain, blobUrl } for the export mixer

  function project() {
    return store.state.project;
  }

  function mediaFor(clip) {
    return project().media.find((item) => item.key === clip.mediaKey) || null;
  }

  function ensureAudio() {
    if (audioCtx) return audioCtx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    // Some embedded webviews reject a requested sample rate. Keep native media
    // playback available in that case instead of leaving every element silent.
    try {
      try {
        audioCtx = new Ctor({ sampleRate: 48000 });
      } catch {
        audioCtx = new Ctor();
      }
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1;
      masterGain.connect(audioCtx.destination);
    } catch (error) {
      console.warn('Web Audio unavailable; using native media audio', error);
      audioCtx = null;
      masterGain = null;
      return null;
    }
    return audioCtx;
  }

  function setMasterVolume(value) {
    masterVolume = clamp(value, 0, 1.5);
    ensureAudio();
    if (masterGain) masterGain.gain.value = masterVolume;
  }

  /** Size of a clip's drawn box in frame pixels, before its transform. */
  function measureClipBox(clip) {
    const frameWidth = project().width;
    const frameHeight = project().height;
    if (clip.kind === 'text') {
      const text = clip.text || {};
      const scratch = measureCanvas.getContext('2d');
      const size = Math.max(8, (text.size || 96) * (frameWidth / 1920));
      scratch.font = `${text.weight || 700} ${size}px ${FONT_STACKS[text.font] || FONT_STACKS.sans}`;
      const maxWidth = Math.max(120, (text.maxWidth || 0.8) * frameWidth);
      const lines = layoutText(scratch, text.content || '', maxWidth);
      const widest = Math.max(...lines.map((line) => scratch.measureText(line).width), size);
      const height = lines.length * size * (text.lineHeight || 1.15);
      return { width: Math.min(maxWidth, widest), height: Math.max(height, size * 0.6) };
    }
    const media = mediaFor(clip);
    const el = media ? elementFor(clip) : null;
    const naturalWidth = el?.videoWidth || el?.naturalWidth || media?.width || 16;
    const naturalHeight = el?.videoHeight || el?.naturalHeight || media?.height || 9;
    const crop = clip.crop || { top: 0, right: 0, bottom: 0, left: 0 };
    const cw = naturalWidth * (1 - (crop.left || 0) - (crop.right || 0));
    const ch = naturalHeight * (1 - (crop.top || 0) - (crop.bottom || 0));
    const fit = Math.min(frameWidth / cw, frameHeight / ch);
    return { width: cw * fit, height: ch * fit };
  }

  function resumeAudio() {
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  function elementFor(clip) {
    const media = mediaFor(clip);
    if (!media) return null;
    if (media.kind === 'image') {
      const existing = pools.get(clip.id);
      if (existing && existing.url === media.path && existing.kind === 'image') return existing.el;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = fileUrl(media.path);
      const entry = { el: img, gain: null, url: media.path, kind: 'image' };
      pools.set(clip.id, entry);
      return img;
    }

    const existing = pools.get(clip.id);
    if (existing && existing.url === media.path) return existing.el;

    const el = document.createElement(media.kind === 'audio' ? 'audio' : 'video');
    const url = fileUrl(media.path);
    el.preload = 'auto';
    el.playsInline = true;
    el.crossOrigin = 'anonymous';
    el.muted = false;
    el.volume = 0;
    // If the asset protocol refuses the CORS request, fall back to a plain load so the
    // picture still plays (audio routing then degrades to the element's own output).
    el.addEventListener(
      'error',
      () => {
        if (!el.crossOrigin) return;
        el.removeAttribute('crossorigin');
        el.src = url;
        el.load();
      },
      { once: true },
    );
    el.src = url;
    // Preview audio plays straight from the element. Routing asset-protocol media through
    // Web Audio makes Chromium output silence: a MediaElementAudioSourceNode is muted for
    // cross-origin sources, which is exactly what the asset protocol is.
    pools.set(clip.id, { el, gain: null, url: media.path, kind: 'video' });
    return el;
  }

  function prunePool() {
    const alive = new Set();
    for (const track of project().tracks) for (const clip of track.clips) alive.add(clip.id);
    for (const [id, entry] of pools.entries()) {
      if (alive.has(id)) continue;
      try {
        if (entry.el && entry.el.pause) entry.el.pause();
        if (entry.el) entry.el.removeAttribute('src');
        if (entry.gain) entry.gain.disconnect();
      } catch {
        /* element already torn down */
      }
      pools.delete(id);
    }
  }

  function invalidate() {
    for (const entry of pools.values()) {
      try {
        if (entry.el && entry.el.pause) entry.el.pause();
        if (entry.el) entry.el.removeAttribute('src');
        if (entry.gain) entry.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    pools.clear();
  }

  // ---------------------------------------------------------------- text drawing

  function drawTextClip(target, clip, local, frameWidth, frameHeight, alpha) {
    const text = clip.text;
    if (!text) return;
    const scale = frameWidth / 1920;
    const fontSize = Math.max(8, text.size * scale);
    const family = FONT_STACKS[text.font] || FONT_STACKS.sans;
    target.save();
    target.globalAlpha *= alpha;
    target.font = `${text.weight || 700} ${fontSize}px ${family}`;
    target.textAlign = text.align === 'left' ? 'left' : text.align === 'right' ? 'right' : 'center';
    target.textBaseline = 'middle';
    if ('letterSpacing' in target) target.letterSpacing = `${(text.letterSpacing || 0) * scale}px`;

    const maxWidth = Math.max(120, (text.maxWidth || 0.8) * frameWidth);
    const lines = layoutText(target, text.content || '', maxWidth);
    const lineHeight = fontSize * (text.lineHeight || 1.15);
    const animation = textAnimationState(text.animation, local, clipDuration(clip));
    const visibleLines = animation.mode === 'words' || animation.mode === 'chars'
      ? revealLines(lines, animation.progress, animation.mode)
      : lines;

    const blockHeight = lines.length * lineHeight;
    let originX = 0;
    if (text.align === 'left') originX = -maxWidth / 2;
    if (text.align === 'right') originX = maxWidth / 2;

    if (text.background === 'box') {
      const widest = Math.max(...lines.map((line) => target.measureText(line).width), fontSize * 0.6);
      const padX = (text.padX || 40) * scale;
      const padY = (text.padY || 24) * scale;
      const x = originX - (text.align === 'left' ? padX : text.align === 'right' ? -padX + widest + padX : widest / 2 + padX);
      const width = widest + padX * 2;
      const height = blockHeight + padY * 2;
      const radius = Math.min((text.radius || 16) * scale, height / 2);
      target.globalAlpha = (alpha) * (text.bgOpacity ?? 0.4);
      target.fillStyle = text.bgColor || '#000000';
      target.beginPath();
      roundedRect(target, x, -height / 2 + (text.align === 'center' ? 0 : 0), width, height, radius);
      target.fill();
      target.globalAlpha = alpha;
    }

    target.translate(animation.dx || 0, animation.dy || 0);
    if (animation.scale && animation.scale !== 1) target.scale(animation.scale, animation.scale);

    if (text.shadow > 0) {
      target.shadowColor = `rgba(0,0,0,${Math.min(0.9, text.shadow)})`;
      target.shadowBlur = fontSize * 0.28;
      target.shadowOffsetY = fontSize * 0.045;
    }

    const strokeWidth = (text.strokeWidth || 0) * scale;
    visibleLines.forEach((line, index) => {
      const y = -blockHeight / 2 + lineHeight * (index + 0.5);
      if (strokeWidth > 0) {
        target.lineWidth = strokeWidth;
        target.strokeStyle = text.strokeColor || '#000000';
        target.lineJoin = 'round';
        target.strokeText(line, originX, y, maxWidth);
      }
      target.fillStyle = text.color || '#ffffff';
      target.fillText(line, originX, y, maxWidth);
    });
    target.restore();
  }

  function roundedRect(target, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, height / 2, width / 2));
    target.moveTo(x + r, y);
    target.lineTo(x + width - r, y);
    target.quadraticCurveTo(x + width, y, x + width, y + r);
    target.lineTo(x + width, y + height - r);
    target.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    target.lineTo(x + r, y + height);
    target.quadraticCurveTo(x, y + height, x, y + height - r);
    target.lineTo(x, y + r);
    target.quadraticCurveTo(x, y, x + r, y);
  }

  function revealLines(lines, progress, mode) {
    if (mode === 'chars') {
      const total = lines.reduce((sum, line) => sum + line.length, 0);
      let budget = Math.floor(total * progress);
      return lines.map((line) => {
        if (budget <= 0) return '';
        const slice = line.slice(0, budget);
        budget -= line.length;
        return slice;
      });
    }
    const all = lines.join(' ').split(/\s+/).filter(Boolean);
    const words = Math.floor(all.length * progress);
    const shown = all.slice(0, words).join(' ');
    return layoutText(ctx, shown, ctx.canvas.width);
  }

  // ------------------------------------------------------------------- rendering

  function applyFilter(target, clip, time, extra = '') {
    const base = store.state.compare ? 'none' : cssFilterFor(clip, time);
    const parts = [base === 'none' ? '' : base, extra].filter(Boolean);
    target.filter = parts.join(' ') || 'none';
  }

  function sourceBox(el, crop) {
    const width = el.videoWidth || el.naturalWidth || el.width || 0;
    const height = el.videoHeight || el.naturalHeight || el.height || 0;
    if (!width || !height) return null;
    const sx = width * (crop?.left || 0);
    const sy = height * (crop?.top || 0);
    const sw = Math.max(2, width * (1 - (crop?.left || 0) - (crop?.right || 0)));
    const sh = Math.max(2, height * (1 - (crop?.top || 0) - (crop?.bottom || 0)));
    return { sx, sy, sw, sh };
  }

  function paintBase(target, clip, time, opts = {}) {
    const frameWidth = project().width;
    const frameHeight = project().height;
    const local = clamp(time - clip.start, 0, clipDuration(clip));

    if (clip.kind === 'text') {
      drawTextClip(target, clip, local, frameWidth, frameHeight, 1);
      return;
    }

    const media = mediaFor(clip);
    if (!media) {
      target.save();
      target.fillStyle = 'rgba(255,92,57,0.12)';
      target.fillRect(-frameWidth / 2, -frameHeight / 2, frameWidth, frameHeight);
      target.restore();
      return;
    }
    const el = elementFor(clip);
    if (!el) return;
    const box = sourceBox(el, clip.crop);
    if (!box) return;

    const fitScale = Math.min(frameWidth / box.sw, frameHeight / box.sh);
    const dw = box.sw * fitScale;
    const dh = box.sh * fitScale;
    try {
      target.drawImage(el, box.sx, box.sy, box.sw, box.sh, -dw / 2, -dh / 2, dw, dh);
    } catch {
      /* frame not ready yet */
    }
  }

  function paintEffectOverlay(target, clip, time, alpha, box) {
    const effect = clip.effect || { id: 'none', amount: 0.5 };
    if (store.state.compare || effect.id === 'none') return;
    const amount = effect.amount ?? 0.5;
    const W = project().width;
    const H = project().height;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = alpha;
    switch (effect.id) {
      case 'grain': {
        target.globalAlpha = alpha * (0.12 + amount * 0.5);
        target.globalCompositeOperation = 'overlay';
        const pattern = target.createPattern(noiseTile, 'repeat');
        target.fillStyle = pattern;
        target.fillRect(0, 0, W, H);
        break;
      }
      case 'scanlines': {
        target.globalAlpha = alpha * (0.12 + amount * 0.35);
        const pattern = target.createPattern(scanTile, 'repeat');
        target.fillStyle = pattern;
        target.fillRect(0, 0, W, H);
        break;
      }
      case 'vignette': {
        const gradient = target.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.28, W / 2, H / 2, Math.max(W, H) * 0.72);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(1, `rgba(0,0,0,${0.35 + amount * 0.5})`);
        target.fillStyle = gradient;
        target.fillRect(0, 0, W, H);
        break;
      }
      case 'vhs': {
        target.globalAlpha = alpha * 0.35;
        const pattern = target.createPattern(scanTile, 'repeat');
        target.fillStyle = pattern;
        target.fillRect(0, 0, W, H);
        target.globalAlpha = alpha * (0.05 + amount * 0.12);
        target.fillStyle = '#9ad4ff';
        const bandY = (time * 90) % H;
        target.fillRect(0, bandY, W, H * 0.06);
        break;
      }
      case 'leak': {
        const gradient = target.createLinearGradient(0, 0, W, H);
        gradient.addColorStop(0, `rgba(255,140,60,${0.1 + amount * 0.35})`);
        gradient.addColorStop(0.55, 'rgba(255,90,60,0)');
        gradient.addColorStop(1, `rgba(255,220,160,${0.06 + amount * 0.2})`);
        target.globalCompositeOperation = 'screen';
        target.fillStyle = gradient;
        target.fillRect(0, 0, W, H);
        break;
      }
      default:
        break;
    }
    target.restore();
  }

  function paintClip(target, clip, time, options = {}) {
    const W = project().width;
    const H = project().height;
    const evalTime = Math.min(time, clipEnd(clip) - 0.0001);
    const tr = transformAt(clip, evalTime);
    const alpha = (options.alpha ?? 1) * tr.opacity;
    if (alpha <= 0.001) return;
    const effect = clip.effect || { id: 'none', amount: 0.5 };
    const amount = effect.amount ?? 0.5;

    let dx = options.dx || 0;
    let dy = options.dy || 0;
    let scaleMul = options.scaleMul || 1;
    let rotExtra = options.rotExtra || 0;
    let extraFilter = options.extraFilter || '';

    if (!store.state.compare && effect.id === 'shake') {
      const intensity = amount * 26;
      dx += Math.sin(evalTime * 41.3) * intensity;
      dy += Math.cos(evalTime * 37.7) * intensity;
    }
    if (!store.state.compare && effect.id === 'pulse') {
      scaleMul *= 1 + Math.sin(evalTime * 5.2) * 0.035 * (amount * 2);
    }
    if (!store.state.compare && effect.id === 'blur') {
      extraFilter = `${extraFilter} blur(${(amount * 8).toFixed(2)}px)`.trim();
    }

    target.save();
    if (options.wipe !== null && options.wipe !== undefined) {
      target.beginPath();
      target.rect(0, 0, W * clamp(options.wipe, 0, 1), H);
      target.clip();
    }
    target.translate(W / 2 + tr.x * W + dx, H / 2 + tr.y * H + dy);
    target.rotate(((tr.rotation + rotExtra) * Math.PI) / 180);
    target.scale(tr.scale * scaleMul * (tr.flipH ? -1 : 1), tr.scale * scaleMul * (tr.flipV ? -1 : 1));
    target.globalAlpha = alpha;
    applyFilter(target, clip, evalTime, extraFilter);

    if (clip.kind !== 'text') {
      if (effect.id === 'mirror' && !store.state.compare) {
        const halfW = W / 2;
        target.save();
        target.beginPath();
        target.rect(-halfW, -H / 2, halfW, H);
        target.clip();
        paintBase(target, clip, time);
        target.restore();
        target.save();
        target.scale(-1, 1);
        target.beginPath();
        target.rect(-halfW, -H / 2, halfW, H);
        target.clip();
        paintBase(target, clip, time);
        target.restore();
      } else if ((effect.id === 'glow' || effect.id === 'chroma') && !store.state.compare) {
        paintBase(target, clip, time);
        target.save();
        target.globalCompositeOperation = 'screen';
        if (effect.id === 'glow') {
          target.filter = `blur(${(6 + amount * 18).toFixed(1)}px) brightness(1.25)`;
          target.globalAlpha = alpha * (0.5 + amount * 0.4);
          paintBase(target, clip, time);
        } else {
          const shift = 2 + amount * 10;
          target.filter = 'hue-rotate(-25deg) saturate(1.6)';
          target.globalAlpha = alpha * 0.45;
          target.translate(-shift, 0);
          paintBase(target, clip, time);
          target.translate(shift, 0);
          target.filter = 'hue-rotate(25deg) saturate(1.6)';
          target.translate(shift, 0);
          paintBase(target, clip, time);
        }
        target.restore();
      } else if (effect.id === 'pixelate' && !store.state.compare) {
        pixelatePass(target, clip, time, amount, alpha);
      } else {
        paintBase(target, clip, time);
      }
    } else {
      paintBase(target, clip, time);
    }

    target.restore();
    paintEffectOverlay(target, clip, Math.min(time, clipEnd(clip)), alpha, null);
  }

  const pixelBuffer = document.createElement('canvas');
  function pixelatePass(target, clip, time, amount, alpha) {
    const W = project().width;
    const H = project().height;
    const factor = 1 / Math.max(3, Math.round(6 + amount * 26));
    pixelBuffer.width = Math.max(2, Math.round(W * factor));
    pixelBuffer.height = Math.max(2, Math.round(H * factor));
    const bufferCtx = pixelBuffer.getContext('2d');
    bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
    bufferCtx.clearRect(0, 0, pixelBuffer.width, pixelBuffer.height);
    const matrix = target.getTransform();
    bufferCtx.setTransform(
      matrix.a * factor,
      matrix.b * factor,
      matrix.c * factor,
      matrix.d * factor,
      matrix.e * factor,
      matrix.f * factor,
    );
    bufferCtx.globalAlpha = 1;
    bufferCtx.filter = target.filter;
    paintBase(bufferCtx, clip, time);
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = alpha;
    target.imageSmoothingEnabled = false;
    target.drawImage(pixelBuffer, 0, 0, W, H);
    target.restore();
  }

  // ---------------------------------------------------------------- transitions

  function paintTransition(target, outgoing, incoming, time, progress, type) {
    const W = project().width;
    const H = project().height;
    const p = clamp(progress, 0, 1);
    const ease = p * p * (3 - 2 * p);
    switch (type) {
      case 'dipblack':
      case 'dipwhite': {
        const color = type === 'dipblack' ? '#000000' : '#ffffff';
        if (p < 0.5) {
          paintClip(target, outgoing, time, {});
        } else {
          paintClip(target, incoming, time, {});
        }
        const darkness = 1 - Math.abs(p - 0.5) * 2;
        target.save();
        target.setTransform(1, 0, 0, 1, 0, 0);
        target.globalAlpha = darkness;
        target.fillStyle = color;
        target.fillRect(0, 0, W, H);
        target.restore();
        break;
      }
      case 'slideleft':
        paintClip(target, outgoing, time, { dx: -W * ease });
        paintClip(target, incoming, time, { dx: W * (1 - ease) });
        break;
      case 'slideright':
        paintClip(target, outgoing, time, { dx: W * ease });
        paintClip(target, incoming, time, { dx: -W * (1 - ease) });
        break;
      case 'slideup':
        paintClip(target, outgoing, time, { dy: -H * ease });
        paintClip(target, incoming, time, { dy: H * (1 - ease) });
        break;
      case 'zoomin':
        paintClip(target, outgoing, time, { scaleMul: 1 + ease * 0.3 });
        paintClip(target, incoming, time, { alpha: ease, scaleMul: 0.7 + ease * 0.3 });
        break;
      case 'zoomout':
        paintClip(target, outgoing, time, { alpha: 1 - ease, scaleMul: 1 + ease * 0.25 });
        paintClip(target, incoming, time, { scaleMul: 1.3 - ease * 0.3 });
        break;
      case 'blur':
        paintClip(target, outgoing, time, { alpha: 1 - ease, extraFilter: `blur(${(ease * 22).toFixed(1)}px)` });
        paintClip(target, incoming, time, { alpha: ease, extraFilter: `blur(${((1 - ease) * 22).toFixed(1)}px)` });
        break;
      case 'wipe':
        paintClip(target, outgoing, time, {});
        paintClip(target, incoming, time, { wipe: ease });
        break;
      case 'spin':
        paintClip(target, outgoing, time, { alpha: 1 - ease, rotExtra: ease * 25, scaleMul: 1 + ease * 0.1 });
        paintClip(target, incoming, time, { alpha: ease, rotExtra: -(1 - ease) * 45, scaleMul: 0.6 + ease * 0.4 });
        break;
      case 'crossfade':
      default:
        paintClip(target, outgoing, time, { alpha: 1 - ease });
        paintClip(target, incoming, time, { alpha: ease });
        break;
    }
  }

  // ------------------------------------------------------------------- frame draw

  function paintBackground(target, time) {
    const { width: W, height: H, background } = project();
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
    target.filter = 'none';
    target.fillStyle = background?.color || '#07080b';
    target.fillRect(0, 0, W, H);

    if (background?.type === 'blur') {
      const top = topmostActiveVideo(time);
      if (top) {
        const el = elementFor(top);
        if (el) {
          const box = sourceBox(el, null);
          if (box) {
            const cover = Math.max(W / box.sw, H / box.sh) * 1.08;
            target.filter = `blur(${background.blur || 28}px) brightness(0.55)`;
            try {
              target.drawImage(el, box.sx, box.sy, box.sw, box.sh, (W - box.sw * cover) / 2, (H - box.sh * cover) / 2, box.sw * cover, box.sh * cover);
            } catch {
              /* not ready */
            }
            target.filter = 'none';
          }
        }
      }
    }
    target.restore();
  }

  function topmostActiveVideo(time) {
    for (const track of project().tracks) {
      if (track.kind === 'audio' || track.hidden) continue;
      for (const clip of track.clips) {
        if (clip.kind === 'video' && time >= clip.start && time < clipEnd(clip)) return clip;
      }
    }
    return null;
  }

  function paintGuides(target) {
    if (!store.state.showGuides) return;
    const W = project().width;
    const H = project().height;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.strokeStyle = 'rgba(255,255,255,0.22)';
    target.lineWidth = Math.max(1, W / 1600);
    const inset = 0.06;
    target.strokeRect(W * inset, H * inset, W * (1 - inset * 2), H * (1 - inset * 2));
    target.strokeStyle = 'rgba(255,92,57,0.5)';
    target.beginPath();
    target.moveTo(W / 2, 0);
    target.lineTo(W / 2, H);
    target.moveTo(0, H / 2);
    target.lineTo(W, H / 2);
    target.stroke();
    target.restore();
  }

  function draw(time, options = {}) {
    const { width: W, height: H } = project();
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    paintBackground(ctx, time);
    const tracks = project().tracks;
    for (let i = tracks.length - 1; i >= 0; i -= 1) {
      paintTrack(ctx, tracks[i], time);
    }
    if (options.guides !== false) paintGuides(ctx);
  }

  function paintTrack(target, track, time) {
    if (track.kind === 'audio' || track.hidden) return;
    const clips = track.clips;
    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index];
      if (time < clip.start || time >= clipEnd(clip)) continue;
      const transition = clip.transition || { id: 'none', duration: 0 };
      const duration = transition.duration || 0;
      if (transition.id !== 'none' && duration > 0 && index > 0 && time < clip.start + duration) {
        const previous = clips[index - 1];
        const progress = (time - clip.start) / duration;
        paintTransition(target, previous, clip, time, progress, transition.id);
      } else {
        paintClip(target, clip, time, {});
      }
    }
  }

  // ---------------------------------------------------------------- audio + sync

  function sync(time, playing) {
    if (exportMode) {
      syncExport(time, playing);
      return;
    }
    const tracks = project().tracks;
    for (const track of tracks) {
      for (const clip of track.clips) {
        if (!clip.mediaKey || clip.kind === 'text') continue;
        const media = mediaFor(clip);
        if (!media || media.kind === 'image') continue;
        const el = elementFor(clip);
        const entry = pools.get(clip.id);
        if (!el || !entry) continue;
        const active = time >= clip.start - 0.02 && time < clipEnd(clip) + 0.02;
        if (!active) {
          if (!el.paused) el.pause();
          continue;
        }
        const source = sourceTimeAt(clip, time);
        const rate = clamp(clip.speed || 1, 0.0625, 16);
        if (Math.abs((el.currentTime || 0) - source) > 0.3) {
          try {
            el.currentTime = source;
          } catch {
            /* seeking unsupported */
          }
        }
        if (Math.abs((el.playbackRate || 1) - rate) > 0.01) el.playbackRate = rate;
        const gainValue = track.muted || clip.muted ? 0 : volumeAt(clip, time);
        el.volume = clamp(gainValue * masterVolume, 0, 1);
        el.muted = gainValue <= 0.0001;
        if (playing && el.paused) {
          const promise = el.play();
          if (promise && promise.catch) promise.catch(() => {});
        }
        if (!playing && !el.paused) el.pause();
      }
    }
  }

  /** Drive the export mixer, which plays its own blob-backed copies of each clip's media. */
  function syncExport(time, playing) {
    for (const track of project().tracks) {
      for (const clip of track.clips) {
        if (!clip.mediaKey || clip.kind === 'text') continue;
        const voice = exportPool.get(clip.mediaKey);
        if (!voice) continue;
        const el = voice.el;
        const active = time >= clip.start - 0.02 && time < clipEnd(clip) + 0.02;
        if (!active) {
          if (!el.paused) el.pause();
          voice.gain.gain.value = 0;
          continue;
        }
        const source = sourceTimeAt(clip, time);
        if (Math.abs((el.currentTime || 0) - source) > 0.25) {
          try {
            el.currentTime = source;
          } catch {
            /* seeking unsupported */
          }
        }
        const rate = clamp(clip.speed || 1, 0.0625, 16);
        if (Math.abs((el.playbackRate || 1) - rate) > 0.01) el.playbackRate = rate;
        const gainValue = track.muted || clip.muted ? 0 : volumeAt(clip, time);
        voice.gain.gain.value = clamp(gainValue, 0, 2);
        if (playing && el.paused) {
          const promise = el.play();
          if (promise && promise.catch) promise.catch(() => {});
        }
        if (!playing && !el.paused) el.pause();
      }
    }
  }

  /**
   * Build the rendering mixer. Each clip's media is fetched once and played from a
   * same-origin blob URL, so the Web Audio graph is not tainted and the recording keeps
   * its sound (asset-protocol sources would record silence).
   */
  async function beginExportAudio() {
    await endExportAudio();
    const context = ensureAudio();
    if (!context) return null;
    if (masterGain) masterGain.gain.value = masterVolume;
    const destination = audioDestination();
    resumeAudio();
    for (const media of project().media.filter((item) => item.kind !== 'image')) {
      let url = fileUrl(media.path);
      let blobUrl = null;
      try {
        const response = await fetch(url);
        if (response.ok) {
          const blob = await response.blob();
          if (blob.size > 0) {
            blobUrl = URL.createObjectURL(blob);
            url = blobUrl;
          }
        }
      } catch {
        /* the asset URL still plays; the mixer just stays silent for this clip */
      }
      const el = document.createElement(media.kind === 'audio' ? 'audio' : 'video');
      el.preload = 'auto';
      el.playsInline = true;
      el.muted = false;
      let gain = null;
      try {
        const source = context.createMediaElementSource(el);
        gain = context.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(masterGain);
      } catch {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        continue;
      }
      el.src = url;
      exportPool.set(media.key, { el, gain, blobUrl });
    }
    exportMode = true;
    return destination;
  }

  async function endExportAudio() {
    exportMode = false;
    for (const voice of exportPool.values()) {
      try {
        voice.el.pause();
      } catch {
        /* already stopped */
      }
      try {
        voice.gain.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        voice.el.removeAttribute('src');
        voice.el.load();
      } catch {
        /* element already torn down */
      }
      if (voice.blobUrl) URL.revokeObjectURL(voice.blobUrl);
    }
    exportPool.clear();
  }

  function tick(time, playing) {
    sync(time, playing);
    draw(time);
  }

  function audioDestination() {
    const context = ensureAudio();
    if (!context) return null;
    if (!exportDest) exportDest = context.createMediaStreamDestination();
    if (masterGain) {
      try {
        masterGain.connect(exportDest);
      } catch {
        /* already connected */
      }
    }
    return exportDest;
  }

  function pauseAll() {
    for (const entry of pools.values()) {
      if (entry.el && entry.el.pause && !entry.el.paused) entry.el.pause();
    }
    for (const voice of exportPool.values()) {
      if (voice.el && !voice.el.paused) voice.el.pause();
    }
  }

  function dispose() {
    pauseAll();
    endExportAudio();
    invalidate();
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  return {
    draw,
    sync,
    tick,
    invalidate,
    prune: prunePool,
    pauseAll,
    audioDestination,
    beginExportAudio,
    endExportAudio,
    resumeAudio,
    setMasterVolume,
    measureClipBox,
    elementFor,
    drawTextClip,
    get context() {
      return ctx;
    },
  };
}

function buildNoiseTile() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(128, 128);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 110 + Math.random() * 90;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function buildScanTile() {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 6;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, 4, 6);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, 4, 2);
  return canvas;
}
