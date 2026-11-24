// Short human labels for badges and library cards.
import { EFFECTS, FILTERS, TRANSITIONS } from './model.js';

export function effectLabel(id) {
  return EFFECTS.find((item) => item.id === id)?.label || 'None';
}

export function effectAmountLabel(effect) {
  if (!effect || effect.id === 'none') return null;
  const short = {
    grain: 'GRN',
    vignette: 'VIG',
    glow: 'GLW',
    chroma: 'RGB',
    pixelate: 'PIX',
    mirror: 'MIR',
    vhs: 'VHS',
    scanlines: 'SCN',
    leak: 'LEK',
    shake: 'SHK',
    pulse: 'PLS',
    blur: 'BLR',
  }[effect.id] || 'FX';
  return short;
}

export function filterLabel(id) {
  return FILTERS.find((item) => item.id === id)?.label || 'Original';
}

export function transitionLabel(id) {
  return TRANSITIONS.find((item) => item.id === id)?.label || 'None';
}

export function bytesLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
