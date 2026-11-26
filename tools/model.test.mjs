// Unit tests for the pure editor model. Run: node --test tools/model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject,
  createTrack,
  createClip,
  clipDuration,
  clipEnd,
  sequenceDuration,
  sourceTimeAt,
  splitClip,
  placeClip,
  moveClipToTrack,
  deleteClip,
  duplicateClip,
  trimClip,
  rippleShift,
  rollTrim,
  slipClip,
  upsertKeyframe,
  removeKeyframe,
  keyedValue,
  transformAt,
  volumeAt,
  fadeGain,
  snapCandidates,
  snapTime,
  formatTimecode,
  parseTimecode,
  normalizeProject,
  setAspect,
  cssFilterFor,
  projectStats,
  rippleClose,
  localTimeOf,
  sortTracks,
  rangeWindow,
  keyframeTimes,
} from '../ui/js/model.js';

function projectWithClip(overrides = {}) {
  const project = createProject('Test');
  const track = project.tracks.find((t) => t.kind === 'video');
  const clip = createClip('video', { start: 0, in: 0, out: 10, name: 'A', ...overrides });
  track.clips.push(clip);
  return { project, track, clip };
}

test('clip duration respects speed', () => {
  assert.equal(clipDuration(createClip('video', { in: 0, out: 10 })), 10);
  assert.equal(clipDuration(createClip('video', { in: 0, out: 10, speed: 2 })), 5);
  assert.equal(clipDuration(createClip('video', { in: 4, out: 10, speed: 2 })), 3);
});

test('source time maps timeline offset through speed and clamps', () => {
  const clip = createClip('video', { start: 5, in: 2, out: 12, speed: 2 });
  assert.equal(sourceTimeAt(clip, 5), 2);
  assert.equal(sourceTimeAt(clip, 6), 4);
  assert.ok(sourceTimeAt(clip, 100) <= 12);
  assert.equal(localTimeOf(clip, 5), 0);
});

test('sequence duration is the furthest clip end', () => {
  const project = createProject();
  const track = project.tracks.find((t) => t.kind === 'video');
  track.clips.push(createClip('video', { start: 2, out: 3 }));
  track.clips.push(createClip('video', { start: 10, out: 4 }));
  assert.equal(sequenceDuration(project), 14);
});

test('split produces two clips with continuous source ranges', () => {
  const { project, clip } = projectWithClip({ start: 2, in: 4, out: 14 });
  const right = splitClip(project, clip.id, 7);
  assert.ok(right);
  assert.equal(clip.start, 2);
  assert.equal(clip.out, 9);
  assert.equal(right.start, 7);
  assert.equal(right.in, 9);
  assert.equal(right.out, 14);
  assert.equal(clipEnd(clip), 7);
});

test('split refuses at clip edges', () => {
  const { project, clip } = projectWithClip({ start: 0, out: 5 });
  assert.equal(splitClip(project, clip.id, 0), null);
  assert.equal(splitClip(project, clip.id, 5), null);
});

test('split shifts keyframes into the right-hand clip', () => {
  const { project, clip } = projectWithClip({ start: 0, out: 10 });
  upsertKeyframe(clip, 'scale', 8, 1.5);
  const right = splitClip(project, clip.id, 6);
  assert.equal(right.keyframes.scale[0].t, 2);
});

test('overwrite placement trims the clip it lands on', () => {
  const { project, track, clip } = projectWithClip({ start: 0, out: 10 });
  const drop = createClip('video', { start: 6, out: 4 });
  placeClip(track, drop);
  assert.equal(track.clips.length, 2);
  assert.equal(clipEnd(clip), 6);
  assert.equal(track.clips[1].start, 6);
});

test('overwrite placement splits a fully covered clip in two', () => {
  const { track, clip } = projectWithClip({ start: 0, out: 20 });
  const drop = createClip('video', { start: 5, out: 5 });
  placeClip(track, drop);
  const starts = track.clips.map((c) => c.start).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 5, 10]);
  const head = track.clips.find((c) => c.start === 0);
  assert.equal(head.out, 5);
  const tail = track.clips.find((c) => c.start === 10);
  assert.equal(tail.out, 20);
  assert.equal(tail.in, 10);
  assert.notEqual(tail.id, clip.id);
});

test('deleting a clip removes it and leaves neighbours alone', () => {
  const { project, track, clip } = projectWithClip({ start: 0, out: 4 });
  const second = createClip('video', { start: 4, out: 4 });
  track.clips.push(second);
  deleteClip(project, clip.id);
  assert.equal(track.clips.length, 1);
  assert.equal(track.clips[0].id, second.id);
  assert.equal(track.clips[0].start, 4);
});

test('duplicate lands directly after the original', () => {
  const { project, clip } = projectWithClip({ start: 1, out: 3 });
  const copy = duplicateClip(project, clip.id);
  assert.equal(copy.start, 4);
  assert.equal(clipEnd(copy), 7);
});

test('moving across tracks preserves clip content', () => {
  const { project, clip } = projectWithClip({ start: 2, out: 5 });
  const overlay = project.tracks.find((t) => t.kind === 'overlay');
  const moved = moveClipToTrack(project, clip.id, overlay.id, 9);
  assert.ok(moved);
  assert.equal(moved.start, 9);
  assert.equal(overlay.clips.length, 1);
  assert.equal(project.tracks.find((t) => t.kind === 'video').clips.length, 0);
});

test('trim start moves in-point in source time', () => {
  const clip = createClip('video', { start: 4, in: 2, out: 12 });
  trimClip(clip, 'start', 6);
  assert.equal(clip.start, 6);
  assert.equal(clip.in, 4);
  assert.equal(clipDuration(clip), 8);
});

test('trim end clamps to a minimum duration', () => {
  const clip = createClip('video', { start: 0, in: 0, out: 10 });
  trimClip(clip, 'end', -5);
  assert.ok(clipDuration(clip) >= 0.1);
  assert.ok(clip.out > 0);
});

test('trim end respects speed', () => {
  const clip = createClip('video', { start: 0, in: 0, out: 10, speed: 2 });
  trimClip(clip, 'end', 1);
  assert.equal(clip.out, 2);
  assert.equal(clipDuration(clip), 1);
});

test('keyframes interpolate linearly and honour easing', () => {
  const clip = createClip('video', { start: 2, out: 10 });
  upsertKeyframe(clip, 'scale', 0, 1);
  upsertKeyframe(clip, 'scale', 4, 3);
  assert.equal(keyedValue(clip, 'scale', 1, 2), 1);
  assert.equal(keyedValue(clip, 'scale', 1, 4), 2);
  assert.equal(keyedValue(clip, 'scale', 1, 6), 3);
  clip.keyframes.scale[0].ease = 'easeIn';
  assert.ok(keyedValue(clip, 'scale', 1, 4) < 2);
});

test('keyframe upsert replaces a nearby frame instead of stacking', () => {
  const clip = createClip('video', { out: 10 });
  upsertKeyframe(clip, 'opacity', 3, 0.5);
  upsertKeyframe(clip, 'opacity', 3.01, 0.25);
  assert.equal(clip.keyframes.opacity.length, 1);
  assert.equal(clip.keyframes.opacity[0].v, 0.25);
});

test('removing the last keyframe drops the property', () => {
  const clip = createClip('video', { out: 10 });
  upsertKeyframe(clip, 'rotation', 2, 30);
  removeKeyframe(clip, 'rotation', 2);
  assert.equal(clip.keyframes.rotation, undefined);
});

test('transformAt merges keyframes with static values', () => {
  const clip = createClip('video', { out: 10 });
  clip.transform.scale = 1.2;
  upsertKeyframe(clip, 'rotation', 5, 45);
  const early = transformAt(clip, 0);
  assert.equal(early.rotation, 45);
  assert.equal(early.scale, 1.2);
});

test('fades shape volume at the clip edges', () => {
  const clip = createClip('video', { start: 0, out: 10, fadeIn: 2, fadeOut: 2, volume: 0.8 });
  assert.equal(fadeGain(clip, 0), 0);
  assert.equal(fadeGain(clip, 1), 0.5);
  assert.equal(fadeGain(clip, 5), 1);
  assert.ok(volumeAt(clip, 9.5) < 0.8);
});

test('snapping picks the nearest candidate inside the threshold', () => {
  const { project, clip } = projectWithClip({ start: 3, out: 2 });
  const candidates = snapCandidates(project, null);
  assert.ok(candidates.includes(3));
  assert.ok(candidates.includes(5));
  const snapped = snapTime(3.08, candidates, 0.15);
  assert.equal(snapped.time, 3);
  const free = snapTime(3.08, candidates, 0.01);
  assert.equal(free.time, 3.08);
  assert.equal(snapTime(9, candidates, 0.1).time, 9);
  assert.equal(clip.start, 3);
});

test('timecode formats and parses round-trip', () => {
  assert.equal(formatTimecode(0, 30), '00:00:00:00');
  assert.equal(formatTimecode(65.5, 30), '00:01:05:15');
  assert.equal(formatTimecode(3725, 30), '01:02:05:00');
  assert.ok(Math.abs(parseTimecode('00:01:05:15') - 65.5) < 0.001);
  assert.equal(parseTimecode('01:30'), 90);
  assert.equal(parseTimecode('nope'), null);
});

test('normalizeProject repairs junk without throwing', () => {
  const project = normalizeProject({
    name: 'Recovered',
    width: 'wide',
    fps: 3,
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'x', kind: 'video', start: -4, in: 5, out: 2, speed: 0, name: 'broken' },
          null,
          { id: 'nope', kind: 'mystery' },
        ],
      },
      { kind: 'bogus' },
    ],
  });
  assert.equal(project.name, 'Recovered');
  assert.equal(project.width, 1920);
  assert.equal(project.fps, 30);
  assert.equal(project.tracks.length, 1);
  const clip = project.tracks[0].clips[0];
  assert.equal(clip.start, 0);
  assert.equal(clip.speed, 1);
  assert.ok(clip.out > clip.in);
  assert.equal(project.tracks[0].clips.length, 2);
});

test('normalizeProject keeps a valid project intact', () => {
  const original = createProject('Keep');
  const track = original.tracks.find((t) => t.kind === 'video');
  track.clips.push(createClip('video', { start: 1, in: 0, out: 6, filter: 'noir' }));
  const again = normalizeProject(JSON.parse(JSON.stringify(original)));
  assert.equal(again.name, 'Keep');
  assert.equal(again.tracks.find((t) => t.kind === 'video').clips[0].filter, 'noir');
  assert.equal(again.tracks.find((t) => t.kind === 'video').clips[0].out, 6);
});

test('aspect switching updates canvas dimensions', () => {
  const project = createProject();
  setAspect(project, '9:16');
  assert.equal(project.width, 1080);
  assert.equal(project.height, 1920);
  setAspect(project, '21:9');
  assert.equal(project.width, 2560);
  assert.equal(project.height, 1080);
});

test('cssFilterFor combines preset and manual adjustments', () => {
  const clip = createClip('video', { out: 4 });
  clip.filter = 'noir';
  clip.adjust.contrast = 1.2;
  const css = cssFilterFor(clip, 0);
  assert.ok(css.includes('grayscale(1)'));
  assert.ok(css.includes('contrast(1.200)'));
  const clean = createClip('video', { out: 4 });
  assert.equal(cssFilterFor(clean, 0), 'none');
});

test('ripple close removes the clip and shifts followers left', () => {
  const project = createProject();
  const track = project.tracks.find((t) => t.kind === 'video');
  const first = createClip('video', { start: 0, out: 2 });
  const second = createClip('video', { start: 2, out: 3 });
  track.clips.push(first, second);
  rippleClose(project, track.id, 0);
  assert.equal(track.clips.length, 1);
  assert.equal(track.clips[0].start, 0);
  assert.equal(track.clips[0].id, second.id);
});

test('new project has overlay, video and audio tracks', () => {
  const project = createProject();
  assert.deepEqual(project.tracks.map((t) => t.kind), ['overlay', 'video', 'audio']);
  assert.equal(project.width, 1920);
});

test('track order keeps text above overlay above video above audio', () => {
  const project = createProject();
  project.tracks = [createTrack('audio'), createTrack('video'), createTrack('text'), createTrack('overlay')];
  sortTracks(project);
  assert.deepEqual(project.tracks.map((track) => track.kind), ['text', 'overlay', 'video', 'audio']);
  const before = project.tracks.map((track) => track.id);
  sortTracks(project);
  assert.deepEqual(project.tracks.map((track) => track.id), before);
});

test('normalizeProject reorders loaded tracks into paint order', () => {
  const project = normalizeProject({
    tracks: [
      { kind: 'audio', clips: [] },
      { kind: 'text', clips: [] },
      { kind: 'video', clips: [] },
    ],
  });
  assert.deepEqual(project.tracks.map((track) => track.kind), ['text', 'video', 'audio']);
});

test('rangeWindow ignores unset or inverted ranges', () => {
  const { project } = projectWithClip({ start: 0, out: 10 });
  assert.deepEqual(rangeWindow(project), { start: 0, end: 10, active: false });
  project.range = { in: 2, out: 6 };
  assert.deepEqual(rangeWindow(project), { start: 2, end: 6, active: true });
  project.range = { in: 6, out: 5 };
  assert.equal(rangeWindow(project).active, false);
  project.range = { in: 0, out: 10 };
  assert.equal(rangeWindow(project).active, false);
});

test('a trim stops at the end of the footage instead of freezing a frame', () => {
  const clip = createClip('video', { start: 0, out: 5 });
  trimClip(clip, 'end', 9, 0.1, 5);
  assert.equal(clip.out, 5);
  trimClip(clip, 'end', 3, 0.1, 5);
  assert.equal(clip.out, 3);
});

test('ripple shift closes a gap without touching the edited clip', () => {
  const track = createTrack('video');
  const first = createClip('video', { start: 0, out: 4 });
  const second = createClip('video', { start: 4, out: 4 });
  const third = createClip('video', { start: 8, out: 4 });
  track.clips.push(first, second, third);
  trimClip(first, 'end', 3, 0.1);
  rippleShift(track, first.id, clipEnd(first), -1);
  assert.equal(clipEnd(first), 3);
  assert.equal(second.start, 3);
  assert.equal(third.start, 7);
});

test('slip moves the source window only, and never before frame zero', () => {
  const clip = createClip('video', { start: 4, out: 4 });
  const shift = slipClip(clip, 0.5, 10);
  assert.equal(shift, 0.5);
  assert.equal(clip.in, 0.5);
  assert.equal(clip.out, 4.5);
  assert.equal(clip.start, 4);
  assert.equal(slipClip(clip, -9, 10), -0.5);
  assert.equal(clip.in, 0);
});

test('roll keeps the pair length and refuses a non-adjacent cut', () => {
  const left = createClip('video', { start: 0, out: 4 });
  const right = createClip('video', { start: 4, out: 4 });
  right.in = 1;
  right.out = 5;
  assert.equal(rollTrim(left, right, 4.6, 0.1), true);
  assert.equal(clipEnd(left), 4.6);
  assert.equal(right.start, 4.6);
  assert.equal(clipEnd(right), 8);
  const apart = createClip('video', { start: 9, out: 4 });
  assert.equal(rollTrim(left, apart, 5, 0.1), false);
});

test('keyframeTimes lists each keyed instant once, in order', () => {
  const clip = createClip('video', { out: 10 });
  upsertKeyframe(clip, 'scale', 3, 1.5);
  upsertKeyframe(clip, 'opacity', 1, 0.5);
  upsertKeyframe(clip, 'scale', 1, 2);
  assert.deepEqual(keyframeTimes(clip), [1, 3]);
  assert.deepEqual(keyframeTimes(createClip('video', { out: 4 })), []);
});

test('projectStats counts clip kinds, duration and keyframes', () => {
  const { project, track, clip } = projectWithClip({ start: 0, out: 6 });
  upsertKeyframe(clip, 'scale', 1, 1.2);
  track.clips.push(createClip('audio', { start: 0, out: 3 }));
  const textTrack = createTrack('text');
  project.tracks.push(textTrack);
  textTrack.clips.push(createClip('text', { start: 0, duration: 2 }));
  const stats = projectStats(project);
  assert.equal(stats.video, 1);
  assert.equal(stats.audio, 1);
  assert.equal(stats.text, 1);
  assert.equal(stats.keyframes, 1);
  assert.equal(stats.duration, 6);
});
