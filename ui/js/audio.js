// Audio extraction for transcription: decode in the webview, downmix, resample and encode WAV.
import { fileUrl } from './platform.js';

const TARGET_RATE = 16000;
const MAX_SECONDS = 45 * 60;

function downmix(buffer) {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const output = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) output[index] += data[index] / channels;
  }
  return output;
}

function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const before = Math.floor(position);
    const after = Math.min(samples.length - 1, before + 1);
    const fraction = position - before;
    output[index] = samples[before] * (1 - fraction) + samples[after] * fraction;
  }
  return output;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function peaksFrom(samples, bars = 240) {
  const peaks = [];
  const step = Math.floor(samples.length / bars) || 1;
  for (let index = 0; index < bars; index += 1) {
    let peak = 0;
    for (let inner = 0; inner < step; inner += 1) {
      const value = Math.abs(samples[index * step + inner] || 0);
      if (value > peak) peak = value;
    }
    peaks.push(Math.min(1, peak * 3.2));
  }
  return peaks;
}

/** Decode a media file's first audio track into a 16 kHz mono WAV. */
export async function extractWav(media) {
  const response = await fetch(fileUrl(media.path));
  if (!response.ok) throw new Error('could not read the media file');
  const bytes = await response.arrayBuffer();
  const Ctor = window.AudioContext || window.webkitAudioContext;
  const context = new Ctor();
  let buffer;
  try {
    buffer = await context.decodeAudioData(bytes.slice(0));
  } catch {
    context.close().catch(() => {});
    throw new Error('this file has no decodable audio track');
  }
  context.close().catch(() => {});
  const limited = Math.min(buffer.length, Math.floor(buffer.sampleRate * MAX_SECONDS));
  const mono = downmix({ numberOfChannels: buffer.numberOfChannels, length: limited, getChannelData: (channel) => buffer.getChannelData(channel).subarray(0, limited) });
  const target = resample(mono, buffer.sampleRate, TARGET_RATE);
  return {
    wav: encodeWav(target, TARGET_RATE),
    duration: limited / buffer.sampleRate,
    peaks: peaksFrom(target),
  };
}
