// Rendering-only helpers shared by the compositor (text layout, animation curves).
export {
  clipDuration,
  clipEnd,
  clamp,
  cssFilterFor,
  transformAt,
  volumeAt,
  sourceTimeAt,
} from './model.js';

function easeOut(progress) {
  const p = Math.max(0, Math.min(1, progress));
  return 1 - (1 - p) * (1 - p);
}

function easeOutBack(progress) {
  const p = Math.max(0, Math.min(1, progress));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/** Animation state for a text clip at a given local time. */
export function textAnimationState(animation, local, duration) {
  const state = { mode: 'none', progress: 1, alpha: 1, dx: 0, dy: 0, scale: 1 };
  const intro = Math.min(0.9, Math.max(0.25, duration * 0.35));
  const p = Math.max(0, Math.min(1, local / intro));
  switch (animation) {
    case 'fade':
      state.alpha = easeOut(p);
      state.dy = (1 - easeOut(p)) * 18;
      break;
    case 'pop':
      state.alpha = Math.min(1, p * 2.2);
      state.scale = 0.78 + easeOutBack(p) * 0.22;
      break;
    case 'slideup':
      state.dy = (1 - easeOut(p)) * 90;
      state.alpha = Math.min(1, p * 1.6);
      break;
    case 'slidedown':
      state.dy = -(1 - easeOut(p)) * 90;
      state.alpha = Math.min(1, p * 1.6);
      break;
    case 'scale':
      state.scale = 0.35 + easeOut(p) * 0.65;
      state.alpha = Math.min(1, p * 1.4);
      break;
    case 'typewriter': {
      const span = Math.max(0.2, Math.min(duration * 0.6, 2.4));
      state.mode = 'chars';
      state.progress = Math.max(0.0001, Math.min(1, local / span));
      break;
    }
    case 'word': {
      const span = Math.max(0.2, Math.min(duration * 0.7, 2.8));
      state.mode = 'words';
      state.progress = Math.max(0.0001, Math.min(1, local / span));
      break;
    }
    default:
      break;
  }
  return state;
}

/** Word-wrap text for the canvas, honouring explicit newlines. */
export function layoutText(ctx, content, maxWidth) {
  const raw = String(content ?? '');
  const paragraphs = raw.split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}
