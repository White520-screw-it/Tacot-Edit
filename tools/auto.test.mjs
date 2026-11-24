// Tests for the automation helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTION_STYLES,
  chunkSegments,
  captionClips,
  silenceRanges,
  normalizeGain,
  beatMarkers,
  sceneMarkers,
  suggestColorAdjust,
  dedupeMarkers,
  createMarker,
  captionStyle,
} from '../ui/js/auto-model.js';

test('chunkSegments splits long speech into caption-sized pieces', () => {
  const segments = [
    {
      start: 0,
      end: 8,
      text: 'this is a very long line of narration that should absolutely be broken into several readable caption chunks for the viewer',
    },
  ];
  const chunks = chunkSegments(segments, { maxChars: 30, maxDuration: 3 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 34, `chunk too long: ${chunk.text}`);
    assert.ok(chunk.end > chunk.start);
  }
  assert.equal(chunks[0].start, 0);
  assert.ok(chunks[chunks.length - 1].end <= 8.01);
});

test('chunkSegments keeps separate short lines apart when the pause is long', () => {
  const chunks = chunkSegments(
    [
      { start: 0, end: 1.2, text: 'first line' },
      { start: 4, end: 5, text: 'second line' },
    ],
    {},
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'first line');
  assert.equal(chunks[1].text, 'second line');
});

test('chunkSegments enforces a minimum on-screen duration', () => {
  const chunks = chunkSegments([{ start: 2, end: 2.05, text: 'hi' }], { minDuration: 0.8 });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].end - chunks[0].start >= 0.8 - 1e-9);
});

test('captionClips builds styled text clips at the right timeline offsets', () => {
  const style = captionStyle('bold');
  const clips = captionClips([{ start: 1, end: 3, text: 'hello there' }], style, 10, 30);
  assert.equal(clips.length, 1);
  const clip = clips[0];
  assert.equal(clip.kind, 'text');
  assert.equal(clip.start, 11);
  assert.equal(clip.out, 2);
  assert.equal(clip.text.content, 'HELLO THERE');
  assert.equal(clip.text.weight, style.weight);
  assert.equal(clip.text.animation, 'pop');
});

test('every caption style is complete enough to render', () => {
  for (const style of CAPTION_STYLES) {
    for (const key of ['id', 'label', 'font', 'size', 'weight', 'color', 'animation', 'maxWidth']) {
      assert.ok(style[key] !== undefined, `${style.id} missing ${key}`);
    }
  }
});

test('silenceRanges finds long quiet stretches only', () => {
  const peaks = [0.5, 0.5, 0.01, 0.01, 0.01, 0.01, 0.5, 0.4, 0.01, 0.5];
  const ranges = silenceRanges(peaks, 10, { threshold: 0.05, minLength: 0.4 });
  assert.equal(ranges.length, 2);
  assert.ok(Math.abs(ranges[0].start - 2) < 0.001);
  assert.ok(Math.abs(ranges[0].end - 6) < 0.001);
  assert.equal(silenceRanges([0.5, 0.4], 10, {}).length, 0);
  assert.equal(silenceRanges([], 10, {}).length, 0);
});

test('normalizeGain raises quiet audio and clamps loud audio', () => {
  const quiet = Array.from({ length: 50 }, () => 0.02);
  const loud = Array.from({ length: 50 }, () => 0.9);
  const quietGain = normalizeGain(quiet, 0.16);
  const loudGain = normalizeGain(loud, 0.16);
  assert.ok(quietGain > 1.5);
  assert.ok(loudGain < 0.5);
  assert.ok(quietGain <= 3);
  assert.ok(loudGain >= 0.25);
  assert.equal(normalizeGain([], 0.16), 1);
  assert.equal(normalizeGain([0, 0, 0], 0.16), 1);
});

test('beatMarkers returns increasing times at energy jumps', () => {
  const peaks = [];
  for (let i = 0; i < 64; i += 1) peaks.push(i % 16 === 0 ? 0.9 : 0.12);
  const markers = beatMarkers(peaks, 32);
  assert.ok(markers.length >= 3);
  for (let i = 1; i < markers.length; i += 1) assert.ok(markers[i] > markers[i - 1]);
  assert.ok(markers.every((time) => time >= 0 && time <= 32));
});

test('sceneMarkers respects the threshold and spacing', () => {
  const scores = [0.02, 0.4, 0.03, 0.5, 0.02];
  const markers = sceneMarkers(scores, 1, { threshold: 0.3 });
  assert.deepEqual(markers, [1, 3]);
  assert.deepEqual(sceneMarkers([0.01, 0.02], 1, { threshold: 0.3 }), []);
});

test('suggestColorAdjust brightens dark frames and calms oversaturation', () => {
  const dark = suggestColorAdjust({ meanLuma: 0.12, contrast: 0.3, meanSaturation: 0.5, balance: { r: 1, g: 1, b: 1 } });
  assert.ok(dark.exposure > 1.1);
  const bright = suggestColorAdjust({ meanLuma: 0.8, contrast: 0.6, meanSaturation: 0.4, balance: { r: 1, g: 1, b: 1 } });
  assert.ok(bright.exposure < 1);
  const warm = suggestColorAdjust({ meanLuma: 0.5, contrast: 0.5, meanSaturation: 0.4, balance: { r: 1.2, g: 1, b: 0.8 } });
  assert.ok(warm.temperature < 0);
  for (const value of Object.values(dark)) assert.ok(Number.isFinite(value));
});

test('dedupeMarkers drops near-duplicates and sorts', () => {
  const markers = [createMarker(5, 'b'), createMarker(1, 'a'), createMarker(1.05, 'c'), createMarker(9, 'd')];
  const out = dedupeMarkers(markers);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((marker) => marker.time), [1, 5, 9]);
});
