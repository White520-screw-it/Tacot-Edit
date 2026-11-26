// App bootstrap: wiring, playback clock, import pipeline, project persistence, shortcuts.
import { createStore } from './store.js';
import { createEngine } from './engine.js';
import { createTimeline } from './timeline.js';
import { createPanels } from './panels.js';
import * as platform from './platform.js';
import { renderToFile, renderStill } from './exporter.js';
import { createPreviewControls } from './preview-controls.js';
import { createAutomation } from './auto.js';
import { createMarker } from './auto-model.js';
import {
  ASPECTS,
  createClip,
  createProject,
  clipDuration,
  clipEnd,
  deleteClip,
  displayDuration,
  duplicateClip,
  formatTimecode,
  rippleClose,
  sequenceDuration,
  splitClip,
  trackKindFor,
  clamp,
  rangeWindow,
  sortTracks,
  transformAt,
  trimClip,
} from './model.js';

const store = createStore(createProject('Untitled Project'));
const canvas = document.getElementById('canvas');
const engine = createEngine({ canvas, store });
const automation = createAutomation({ store, engine });
bindMonitorClicks();

let timeline = null;
let panels = { render: () => {}, renderInspector: () => {} };
/** Topmost text clip under a point in the program monitor, if any. */
function textClipAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const px = (clientX - rect.left) / (rect.width / project().width);
  const py = (clientY - rect.top) / (rect.height / project().height);
  const time = store.state.playhead;
  let hit = null;
  for (const track of project().tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'text' || !clip.text) continue;
      if (time < clip.start || time >= clipEnd(clip)) continue;
      const tr = transformAt(clip, time);
      const box = engine.measureClipBox(clip);
      const halfWidth = (box.width * tr.scale) / 2;
      const halfHeight = (box.height * tr.scale) / 2;
      const cx = project().width / 2 + tr.x * project().width;
      const cy = project().height / 2 + tr.y * project().height;
      if (Math.abs(px - cx) <= halfWidth && Math.abs(py - cy) <= halfHeight) hit = { clip, track };
    }
  }
  return hit;
}

function bindMonitorClicks() {
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const hit = textClipAt(event.clientX, event.clientY);
    if (hit) store.select(hit.clip.id, hit.track.id);
  });
  canvas.addEventListener('dblclick', (event) => {
    const hit = textClipAt(event.clientX, event.clientY);
    if (!hit) return;
    store.select(hit.clip.id, hit.track.id);
    panels.focusText?.(hit.clip.id);
  });
  document.addEventListener('tacot:edit-text', (event) => {
    const id = event.detail && event.detail.clipId;
    const entry = store.findClip(id);
    if (!entry) return;
    store.select(entry.clip.id, entry.track.id);
    panels.focusText?.(entry.clip.id);
  });
}

const previewControls = createPreviewControls({
  store,
  engine,
  frame: document.querySelector('.preview-frame'),
});

const ui = {
  nameInput: document.getElementById('projectName'),
  aspectSelect: document.getElementById('aspectSelect'),
  fpsSelect: document.getElementById('fpsSelect'),
  saveState: document.getElementById('saveState'),
  undoBtn: document.getElementById('undoBtn'),
  redoBtn: document.getElementById('redoBtn'),
  playBtn: document.getElementById('playBtn'),
  timecode: document.getElementById('timecode'),
  duration: document.getElementById('durationLabel'),
  emptyState: document.getElementById('emptyState'),
  toastStack: document.getElementById('toastStack'),
  dropOverlay: document.getElementById('dropOverlay'),
  stats: document.getElementById('stageStats'),
};

const palette = {
  root: document.getElementById('palette'),
  input: document.getElementById('paletteInput'),
  list: document.getElementById('paletteList'),
  btn: document.getElementById('paletteBtn'),
};

// --------------------------------------------------------------------- toasts

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  ui.toastStack.appendChild(node);
  requestAnimationFrame(() => node.classList.add('is-in'));
  setTimeout(() => {
    node.classList.remove('is-in');
    setTimeout(() => node.remove(), 260);
  }, 3400);
}

// ------------------------------------------------------------------- playback

let lastFrame = performance.now();
let ticking = false;

function setPlaying(playing) {
  if (store.state.exportBusy) return;
  const duration = sequenceDuration(store.state.project);
  if (playing && store.state.playhead >= duration - 0.02) store.state.playhead = 0;
  store.state.playing = playing;
  if (playing) engine.resumeAudio();
  else engine.pauseAll();
  ui.playBtn.classList.toggle('is-playing', playing);
  ui.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  store.notify('transport');
}

function loop(now) {
  const dt = Math.min(0.2, (now - lastFrame) / 1000);
  lastFrame = now;
  if (store.state.playing) {
    const window = rangeWindow(store.state.project);
    const startAt = window.active ? window.start : 0;
    const duration = window.active ? window.end : sequenceDuration(store.state.project);
    let next = store.state.playhead + dt;
    if (next >= duration) {
      if (store.state.loop) next = startAt;
      else {
        next = duration;
        setPlaying(false);
      }
    }
    store.state.playhead = next;
    store.notify('playhead');
  }
  engine.tick(store.state.playhead, store.state.playing);
  requestAnimationFrame(loop);
}

// -------------------------------------------------------------------- helpers

function project() {
  return store.state.project;
}

function extOf(name) {
  const parts = String(name).split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : 'bin';
}

function serializeMedia(media) {
  return {
    key: media.key,
    name: media.name,
    kind: media.kind,
    ext: extOf(media.name),
    path: media.path,
    duration: media.duration || 0,
    width: media.width || 0,
    height: media.height || 0,
    bytes: media.bytes || 0,
  };
}

// --------------------------------------------------------------------- import

async function ingestPaths(paths) {
  if (!paths || !paths.length) return;
  for (const path of paths) {
    try {
      // Browser File objects are read locally; desktop paths use the native importer.
      // eslint-disable-next-line no-await-in-loop
      const stored = typeof File !== 'undefined' && path instanceof File ? await platform.importFile(path) : await platform.importPath(path);
      // eslint-disable-next-line no-await-in-loop
      const described = await platform.describeMedia(stored);
      addMedia(described);
    } catch (err) {
      toast(`Could not add ${String(path).split(/[\\/]/).pop()}: ${err.message}`, 'error');
    }
  }
}

function addMedia(media) {
  store.state.media.set(media.key, media);
  store.mutate('add media', (draft) => {
    if (!draft.media.some((item) => item.key === media.key)) {
      draft.media.push(serializeMedia(media));
    }
  });
  const clip = createClip(trackKindFor(media.kind), {
    name: media.name,
    mediaKey: media.key,
    ext: extOf(media.name),
    out: Math.max(0.3, media.duration || 5),
    start: 0,
  });
  timeline.appendClip(clip);
  toast(`Added ${media.name}`, 'success');
}

async function importMedia() {
  const paths = await platform.openMediaDialog();
  if (paths === null) {
    toast('Native file picker unavailable — drag files into the window instead', 'error');
    return;
  }
  await ingestPaths(paths);
}

// --------------------------------------------------------------------- project

let autosaveTimer = null;

async function saveProject() {
  try {
    const json = JSON.stringify(store.state.project);
    const path = await platform.saveProject(project().name || 'Untitled Project', json);
    store.markSaved();
    toast(`Saved to ${path.split(/[\\/]/).pop()}`, 'success');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
}

async function listProjects() {
  return platform.listProjects();
}

async function loadProject(name) {
  try {
    const json = await platform.loadProject(name);
    await hydrate(JSON.parse(json));
    toast(`Opened ${name}`, 'success');
  } catch (err) {
    toast(`Could not open ${name}: ${err.message}`, 'error');
  }
}

async function deleteProject(name) {
  try {
    await platform.deleteProject(name);
    toast(`Deleted ${name}`, 'info');
    panels.render();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

async function hydrate(raw) {
  store.setProject(raw);
  engine.invalidate();
  store.state.media.clear();
  for (const media of project().media) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const described = await platform.describeMedia({ ...media, name: media.name });
      store.state.media.set(media.key, described);
    } catch {
      /* media missing on disk: clip still shows on the timeline */
    }
  }
  reflectProject();
}

function newProject() {
  const fresh = createProject('Untitled Project');
  store.setProject(fresh);
  engine.invalidate();
  store.state.media.clear();
  reflectProject();
  toast('New project', 'info');
}

/** Size the program monitor to the largest box that fits, preserving the canvas ratio. */
function fitPreview() {
  const wrap = document.querySelector('.preview-wrap');
  const frame = document.querySelector('.preview-frame');
  if (!wrap || !frame) return;
  const availableWidth = Math.max(160, wrap.clientWidth - 36);
  const availableHeight = Math.max(90, wrap.clientHeight - 36);
  const ratio = project().width / project().height || 16 / 9;
  let width = availableWidth;
  let height = width / ratio;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * ratio;
  }
  frame.style.width = `${Math.round(width)}px`;
  frame.style.height = `${Math.round(height)}px`;
}

function reflectProject() {
  ui.nameInput.value = project().name;
  ui.aspectSelect.value = project().aspect;
  ui.fpsSelect.value = String(project().fps);
  document.documentElement.style.setProperty('--aspect-ratio', `${project().width} / ${project().height}`);
  ui.duration.textContent = displayDuration(sequenceDuration(project()));
  const statusProject = document.getElementById('statusProject');
  if (statusProject) {
    const clips = project().tracks.reduce((total, track) => total + track.clips.length, 0);
    statusProject.textContent = `${project().width}×${project().height} · ${project().fps} fps · ${displayDuration(
      sequenceDuration(project()),
    )} · ${clips} clip${clips === 1 ? '' : 's'}`;
  }
  ui.saveState.textContent = store.state.saveState === 'dirty' ? 'Unsaved changes' : 'All changes saved';
  ui.saveState.className = `save-state ${store.state.saveState}`;
  ui.emptyState.classList.toggle('is-hidden', project().tracks.some((track) => track.clips.length > 0));
  ui.undoBtn.disabled = !store.canUndo();
  ui.redoBtn.disabled = !store.canRedo();
  ui.stats.textContent = `${project().width}×${project().height} · ${project().fps} fps`;
  fitPreview();
}

// ------------------------------------------------------------------ selection

function splitAtPlayhead() {
  const selected = store.selected();
  if (!selected) return toast('Select a clip first');
  store.mutate('split clip', () => splitClip(store.state.project, selected.clip.id, store.state.playhead));
}

function duplicateSelected() {
  const selected = store.selected();
  if (!selected) return toast('Select a clip first');
  const ids = store.selectedIds();
  const copies = store.mutate('duplicate clip', (draft) =>
    ids.map((id) => duplicateClip(draft, id)).filter(Boolean),
  );
  if (copies && copies.length) store.select(copies[copies.length - 1].id, selected.track.id);
}

function deleteSelected() {
  const ids = store.selectedIds();
  if (!ids.length) return;
  store.mutate('delete clip', (draft) => {
    for (const id of ids) deleteClip(draft, id);
  });
  store.select(null, null);
  previewControls.update();
}

function rippleDeleteSelected() {
  const selected = store.selected();
  if (!selected) return;
  store.mutate('ripple delete', () => rippleClose(store.state.project, selected.track.id, selected.clip.start));
  store.select(null, null);
}

function addText(preset) {
  const clip = timeline.addTextClip(preset?.text || 'Your headline');
  if (!clip) return;
  if (preset) {
    const entry = store.findClip(clip.id);
    if (entry) {
      store.mutate('text preset', () => {
        Object.assign(entry.clip.text, {
          font: preset.font ?? entry.clip.text.font,
          size: preset.size ?? entry.clip.text.size,
          weight: preset.weight ?? entry.clip.text.weight,
          color: preset.color ?? entry.clip.text.color,
          animation: preset.animation ?? entry.clip.text.animation,
          background: preset.background ?? entry.clip.text.background,
          align: preset.align ?? entry.clip.text.align,
          maxWidth: preset.maxWidth ?? entry.clip.text.maxWidth,
          letterSpacing: preset.letterSpacing ?? entry.clip.text.letterSpacing,
          bgColor: preset.bgColor ?? entry.clip.text.bgColor,
          bgOpacity: preset.bgOpacity ?? entry.clip.text.bgOpacity,
        });
        entry.clip.name = preset.name;
      });
    }
  }
  store.select(clip.id);
  panels.render();
}

// --------------------------------------------------------------------- export

let exportCancel = { cancelled: false };

function syncRangeOptions() {
  const select = document.getElementById('exportRangeSelect');
  const window = rangeWindow(project());
  const option = select.querySelector('option[value="range"]');
  if (!option) return;
  option.disabled = !window.active;
  option.textContent = window.active
    ? `In / Out · ${formatTimecode(window.start, project().fps)} → ${formatTimecode(window.end, project().fps)}`
    : 'In / Out · none set (press I and O)';
  if (!window.active && select.value === 'range') select.value = 'whole';
  document.getElementById('exportRange').textContent = window.active
    ? `${displayDuration(window.end - window.start)} (${select.value === 'range' ? 'range' : 'whole sequence'})`
    : `Whole sequence · ${displayDuration(sequenceDuration(project()))}`;
}

async function saveStill() {
  const status = document.getElementById('exportStatus');
  try {
    status.textContent = 'Rendering still…';
    const saved = await renderStill({
      engine,
      canvas,
      store,
      name: `${project().name || 'Tacot Edit'} still`,
    });
    status.textContent = `Still saved · ${saved.path}`;
    toast('Still frame exported', 'success');
  } catch (err) {
    status.textContent = `Still export failed: ${err.message}`;
    toast(`Still export failed: ${err.message}`, 'error');
  }
}

function openExportDialog() {
  const dialog = document.getElementById('exportModal');
  const ffmpeg = store.state.ffmpeg.found;
  dialog.classList.add('is-open');
  syncRangeOptions();
  document.getElementById('exportName').value = `${project().name || 'Tacot Edit Export'}`;
  const formatSelect = document.getElementById('exportFormat');
  formatSelect.innerHTML = '<option value="webm">WebM · VP9</option>';
  if (ffmpeg) formatSelect.innerHTML += '<option value="mp4">MP4 · H.264</option>';
  document.getElementById('exportResolution').textContent = `${project().width}×${project().height} @ ${project().fps} fps`;
  document.getElementById('exportProgress').style.width = '0%';
  document.getElementById('exportStatus').textContent = 'Ready';
  document.getElementById('exportResult').classList.remove('is-visible');
  document.getElementById('exportStart').disabled = false;
}

function closeExportDialog() {
  document.getElementById('exportModal').classList.remove('is-open');
}

async function startExport() {
  const name = document.getElementById('exportName').value.trim() || 'Tacot Edit Export';
  const format = document.getElementById('exportFormat').value;
  const quality = document.getElementById('exportQuality').value;
  const bitrates = { draft: 4_000_000, standard: 10_000_000, high: 18_000_000, master: 32_000_000 };
  const progress = document.getElementById('exportProgress');
  const status = document.getElementById('exportStatus');
  const result = document.getElementById('exportResult');
  const startButton = document.getElementById('exportStart');

  exportCancel = { cancelled: false };
  store.state.exportBusy = true;
  startButton.disabled = true;
  setPlaying(false);
  const window = rangeWindow(project());
  const useRange = document.getElementById('exportRangeSelect').value === 'range' && window.active;
  const startAt = useRange ? window.start : 0;
  store.state.playhead = startAt;
  store.notify('playhead');

  try {
    const saved = await renderToFile({
      store,
      engine,
      canvas,
      fps: project().fps,
      bitrate: bitrates[quality] || 10_000_000,
      format,
      name,
      startAt,
      duration: useRange ? window.end - window.start : sequenceDuration(project()),
      shouldCancel: () => exportCancel.cancelled,
      onProgress: (ratio) => {
        progress.style.width = `${Math.round(ratio * 100)}%`;
      },
      onStatus: (text) => {
        status.textContent = text;
      },
    });
    progress.style.width = '100%';
    status.textContent = saved.format === 'mp4' ? 'MP4 ready' : 'WebM ready';
    result.innerHTML = `<div class="export-path"></div><div class="export-note"></div><button class="btn btn-ghost export-reveal" type="button">Show in folder</button>`;
    result.querySelector('.export-path').textContent = saved.path;
    result.querySelector('.export-note').textContent =
      saved.note || `${(saved.bytes / 1024 / 1024).toFixed(1)} MB · ${saved.format.toUpperCase()}`;
    result.querySelector('.export-reveal').addEventListener('click', () => {
      platform.command('export_reveal', { path: saved.path }).catch(() => toast('Could not open the folder', 'error'));
    });
    result.classList.add('is-visible');
    toast('Export finished', 'success');
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
    toast(`Export failed: ${err.message}`, 'error');
  } finally {
    store.state.exportBusy = false;
    startButton.disabled = false;
    store.state.playhead = startAt;
    store.notify('playhead');
  }
}

// ----------------------------------------------------------------- short cuts

function isTyping(target) {
  return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

// ------------------------------------------------------------- command palette

let paletteOpen = false;
let paletteItems = [];
let paletteIndex = 0;

function commandRegistry() {
  const click = (id) => () => document.getElementById(id).click();
  const panelTabs = [
    ['media', 'Media'],
    ['auto', 'Automation'],
    ['text', 'Text'],
    ['effects', 'Effects'],
    ['transitions', 'Transitions'],
    ['filters', 'Filters'],
    ['projects', 'Projects'],
  ];
  return [
    { label: 'Import media', hint: 'Video, audio or images', run: importMedia },
    { label: 'Export sequence', hint: 'Render the timeline to a file', run: openExportDialog },
    { label: 'Save current frame as PNG', hint: 'A still of the program monitor', run: saveStill },
    { label: 'Auto subtitles', hint: 'Listen to the audio and write captions', run: async () => {
      toast('Listening to the timeline…', 'info');
      const result = await automation.autoSubtitles({});
      toast(`${result.count} captions added · ${result.engine}`, 'success');
    } },
    { label: 'Add a title', hint: 'Text at the playhead', keys: 'T', run: () => addText() },
    { label: 'Save project', keys: 'Ctrl S', run: saveProject },
    { label: 'New project', run: newProject },
    { label: 'Split at playhead', keys: 'Ctrl B', run: splitAtPlayhead },
    { label: 'Duplicate selected clip', keys: 'Ctrl D', run: duplicateSelected },
    { label: 'Delete selected clip', keys: 'Del', run: deleteSelected },
    { label: 'Add marker', keys: 'M', run: () => {
      store.mutate('add marker', (draft) => {
        if (!Array.isArray(draft.markers)) draft.markers = [];
        draft.markers = [...draft.markers, createMarker(store.state.playhead, 'Marker')];
      });
      toast('Marker added', 'info');
    } },
    { label: 'Auto colour', hint: 'Balance the selected clip to this frame', run: () => {
      const result = automation.autoColor();
      toast(`Auto colour · exposure ${result.exposure}×`, 'success');
    } },
    { label: 'Auto loudness', hint: 'Normalise the selected clip', run: () => {
      const gain = automation.autoLoudness();
      toast(`Volume set to ${Math.round(gain * 100)}%`, 'success');
    } },
    { label: 'Find silences', hint: 'Mark quiet gaps, no cuts', run: () => {
      const count = automation.findSilences();
      toast(count ? `${count} silence markers` : 'No long silences found', 'info');
    } },
    { label: 'Beat markers', hint: 'Mark rhythmic hits', run: () => {
      const count = automation.beats();
      toast(count ? `${count} beat markers` : 'No clear beats found', 'info');
    } },
    { label: 'Scene changes', hint: 'Scan the selected clip for cuts', run: async () => {
      const count = await automation.scenes();
      toast(count ? `${count} scene markers` : 'No scene changes found', 'info');
    } },
    { label: 'Toggle guides', run: click('guidesBtn') },
    { label: 'Toggle loop playback', run: click('loopBtn') },
    { label: 'Toggle compare (bypass effects)', run: click('compareBtn') },
    { label: 'Toggle snapping', run: click('tlSnap') },
    { label: 'Toggle razor tool', run: click('tlRazor') },
    { label: 'Add a track', run: click('tlAddTrack') },
    { label: 'Zoom in', keys: '+', run: click('tlZoomIn') },
    { label: 'Zoom out', keys: '-', run: click('tlZoomOut') },
    ...panelTabs.map(([id, name]) => ({
      label: `Go to ${name}`,
      hint: 'Panel',
      run: () => panels.setTab(id),
    })),
  ];
}

function highlightPalette() {
  const rows = palette.list.children;
  for (let index = 0; index < rows.length; index += 1) {
    rows[index].classList.toggle('is-active', index === paletteIndex);
  }
  const active = rows[paletteIndex];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function renderPalette() {
  const query = palette.input.value.trim().toLowerCase();
  paletteItems = commandRegistry().filter((item) => {
    const haystack = `${item.label} ${item.hint || ''}`.toLowerCase();
    return !query || query.split(/\s+/).every((word) => haystack.includes(word));
  });
  if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(0, paletteItems.length - 1);
  palette.list.replaceChildren();
  if (!paletteItems.length) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = 'Nothing matches that';
    palette.list.appendChild(empty);
    return;
  }
  paletteItems.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `palette-row${index === paletteIndex ? ' is-active' : ''}`;
    row.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = item.label;
    row.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'palette-hint';
      hint.textContent = item.hint;
      row.appendChild(hint);
    }
    if (item.keys) {
      const keys = document.createElement('kbd');
      keys.textContent = item.keys;
      row.appendChild(keys);
    }
    row.addEventListener('mouseenter', () => {
      paletteIndex = index;
      highlightPalette();
    });
    row.addEventListener('click', () => runPaletteItem(item));
    palette.list.appendChild(row);
  });
}

function runPaletteItem(item) {
  closePalette();
  try {
    const result = item.run();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => toast(err.message || 'That action failed', 'error'));
    }
  } catch (err) {
    toast(err.message || 'That action failed', 'error');
  }
}

function openPalette() {
  paletteOpen = true;
  paletteIndex = 0;
  palette.input.value = '';
  palette.root.classList.add('is-open');
  renderPalette();
  palette.input.focus();
  requestAnimationFrame(() => {
    if (paletteOpen && document.activeElement !== palette.input) palette.input.focus();
  });
}

function closePalette() {
  paletteOpen = false;
  palette.root.classList.remove('is-open');
  palette.input.blur();
}

function togglePalette() {
  if (paletteOpen) closePalette();
  else openPalette();
}

if (palette.input) {
  palette.input.addEventListener('input', () => {
    paletteIndex = 0;
    renderPalette();
  });
  palette.input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1);
      highlightPalette();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      paletteIndex = Math.max(0, paletteIndex - 1);
      highlightPalette();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = paletteItems[paletteIndex];
      if (item) runPaletteItem(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
    }
  });
  palette.root.addEventListener('click', (event) => {
    if (event.target === palette.root) closePalette();
  });
}

// ------------------------------------------------------------- optional update

// Public releases on GitHub are the source of truth; the old page feed stays as a fallback.
const UPDATE_FEEDS = [
  'https://api.github.com/repos/White520-screw-it/Tacot-Edit/releases/latest',
  'https://editor.tacot.org/updates.json',
];
let updateChecked = false;

function compareVersions(a, b) {
  const left = String(a || '').split('.').map((part) => parseInt(part, 10) || 0);
  const right = String(b || '').split('.').map((part) => parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Latest published release, or null when nothing answers. */
async function latestRelease() {
  for (const feed of UPDATE_FEEDS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(feed, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) continue;
      const data = await response.json();
      const version = String(data.version || data.tag_name || '').replace(/^v/, '');
      if (!version) continue;
      return {
        version,
        url: data.html_url || data.url || 'https://github.com/White520-screw-it/Tacot-Edit/releases',
        notes: data.body || '',
      };
    } catch {
      /* this feed is unreachable: try the next one */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Ask the release feed whether a newer build exists. Purely optional: nothing
 * installs itself, and a newer version only lights up a chip the user can
 * click or ignore.
 */
async function checkForUpdate(options = {}) {
  const chip = document.getElementById('updateChip');
  try {
    let current = '0.0.0';
    try {
      current = await platform.command('app_version');
    } catch {
      /* preview build without the desktop shell: still allow the check */
    }
    const info = await latestRelease();
    if (!info) return null;
    updateChecked = true;
    if (compareVersions(info.version, current) <= 0) {
      if (chip) chip.hidden = true;
      return null;
    }
    if (chip) {
      const label = document.getElementById('updateLabel');
      if (label) label.textContent = `v${info.version} available`;
      chip.hidden = false;
      chip.onclick = () => {
        platform
          .command('open_url', { url: info.url || 'https://editor.tacot.org/' })
          .catch(() => toast('Could not open the download page', 'error'));
      };
    }
    if (options.announce) toast(`Tacot Edit ${info.version} is available`, 'info');
    return info;
  } catch {
    return null;
  }
}

function nudgeSelectedClip(delta) {
  const entry = store.selected();
  if (!entry) {
    toast('Select a clip to nudge', 'info');
    return;
  }
  store.mutate('nudge clip', () => {
    entry.clip.start = Math.max(0, entry.clip.start + delta);
  });
}

function trimSelectedToPlayhead(edge) {
  const entry = store.selected();
  if (!entry) {
    toast('Select a clip first', 'info');
    return;
  }
  const time = store.state.playhead;
  const span = clipDuration(entry.clip);
  if (time <= entry.clip.start + 0.05 || time >= entry.clip.start + span - 0.05) {
    toast('Park the playhead inside the clip to trim it', 'info');
    return;
  }
  store.mutate('trim clip', () => {
    trimClip(entry.clip, edge, time, 0.1);
  });
  toast(edge === 'start' ? 'Trimmed the start to the playhead' : 'Trimmed the end to the playhead', 'info');
}

function bindKeys() {
  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      togglePalette();
      return;
    }
    if (isTyping(event.target)) {
      if (event.key === 'Escape') {
        if (paletteOpen) closePalette();
        else event.target.blur();
      }
      return;
    }
    const frame = 1 / project().fps;
    switch (event.key) {
      case ' ':
        event.preventDefault();
        setPlaying(!store.state.playing);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (event.altKey) {
          nudgeSelectedClip(-(event.shiftKey ? 10 : 1) / project().fps);
          break;
        }
        store.seek(store.state.playhead - (event.shiftKey ? 1 : frame));
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (event.altKey) {
          nudgeSelectedClip((event.shiftKey ? 10 : 1) / project().fps);
          break;
        }
        store.seek(store.state.playhead + (event.shiftKey ? 1 : frame));
        break;
      case 'q':
      case 'Q':
        if (!mod) {
          event.preventDefault();
          trimSelectedToPlayhead('start');
        }
        break;
      case 'w':
      case 'W':
        if (!mod) {
          event.preventDefault();
          trimSelectedToPlayhead('end');
        }
        break;
      case 'Home':
        store.seek(0);
        break;
      case 'End':
        store.seek(sequenceDuration(project()));
        break;
      case '[':
        event.preventDefault();
        trimSelectedToPlayhead('start');
        break;
      case ']':
        event.preventDefault();
        trimSelectedToPlayhead('end');
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        if (event.shiftKey) rippleDeleteSelected();
        else deleteSelected();
        break;
      case 'm':
      case 'M':
        if (!mod) {
          store.mutate('add marker', (draft) => {
            if (!Array.isArray(draft.markers)) draft.markers = [];
            draft.markers = [...draft.markers, createMarker(store.state.playhead, 'Marker')];
          });
          toast('Marker added', 'info');
        }
        break;
      case 'i':
      case 'I':
        if (!mod) {
          store.mutate('mark in', (draft) => {
            draft.range.in = event.shiftKey ? null : store.state.playhead;
            if (draft.range.in === null) draft.range.out = null;
          });
          toast(event.shiftKey ? 'Range cleared' : 'In point set', 'info');
        }
        break;
      case 'o':
      case 'O':
        if (!mod) {
          store.mutate('mark out', (draft) => {
            draft.range.out = event.shiftKey ? null : store.state.playhead;
          });
          toast(event.shiftKey ? 'Out point cleared' : 'Out point set', 'info');
        }
        break;
      case 's':
      case 'S':
        if (mod) {
          event.preventDefault();
          saveProject();
        }
        break;
      case 'z':
      case 'Z':
        if (mod) {
          event.preventDefault();
          if (event.shiftKey) store.redo();
          else store.undo();
          reflectProject();
        }
        break;
      case 'y':
      case 'Y':
        if (mod) {
          event.preventDefault();
          store.redo();
          reflectProject();
        }
        break;
      case 'b':
      case 'B':
        if (mod) {
          event.preventDefault();
          splitAtPlayhead();
        }
        break;
      case 'd':
      case 'D':
        if (mod) {
          event.preventDefault();
          duplicateSelected();
        }
        break;
      case 'c':
      case 'C':
        if (mod) {
          const selected = store.selected();
          if (selected) {
            store.state.clipboard = JSON.parse(JSON.stringify(selected.clip));
            toast('Clip copied', 'info');
          }
        }
        break;
      case 'v':
      case 'V':
        if (mod && store.state.clipboard) {
          event.preventDefault();
          const source = store.state.clipboard;
          store.mutate('paste clip', (draft) => {
            const track = draft.tracks.find((item) => item.id === store.state.selection.trackId) || draft.tracks[0];
            const copy = JSON.parse(JSON.stringify(source));
            copy.id = `clip_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            copy.start = store.state.playhead;
            track.clips = track.clips.filter((item) => item.id !== copy.id);
            track.clips.push(copy);
            track.clips.sort((a, b) => a.start - b.start);
            store.state.pendingSelect = copy.id;
          });
          if (store.state.pendingSelect) store.select(store.state.pendingSelect);
        }
        break;
      case '=':
      case '+':
        store.state.zoom = Math.min(420, store.state.zoom * 1.2);
        store.notify('zoom');
        break;
      case '-':
        store.state.zoom = Math.max(14, store.state.zoom / 1.2);
        store.notify('zoom');
        break;
      case 'Escape':
        document.getElementById('exportModal').classList.remove('is-open');
        store.select(null, null);
        break;
      default:
        break;
    }
  });
}

// --------------------------------------------------------------------- layout

function bindTopBar() {
  ui.nameInput.addEventListener('input', () => {
    store.live((draft) => {
      draft.name = ui.nameInput.value;
    });
    reflectProject();
  });

  ui.aspectSelect.innerHTML = Object.entries(ASPECTS)
    .map(([id, value]) => `<option value="${id}">${value.label}</option>`)
    .join('');
  ui.aspectSelect.addEventListener('change', () => {
    const value = ASPECTS[ui.aspectSelect.value];
    store.mutate('change aspect', (draft) => {
      draft.aspect = ui.aspectSelect.value;
      draft.width = value.width;
      draft.height = value.height;
    });
    reflectProject();
  });

  ui.fpsSelect.addEventListener('change', () => {
    store.mutate('change fps', (draft) => {
      draft.fps = Number(ui.fpsSelect.value);
    });
    reflectProject();
  });

  document.getElementById('undoBtn').addEventListener('click', () => {
    store.undo();
    reflectProject();
  });
  document.getElementById('redoBtn').addEventListener('click', () => store.redo());
  document.getElementById('saveBtn').addEventListener('click', saveProject);
  document.getElementById('exportBtn').addEventListener('click', openExportDialog);
  document.getElementById('newBtn').addEventListener('click', newProject);
  document.getElementById('importBtn').addEventListener('click', importMedia);
  if (palette.btn) palette.btn.addEventListener('click', openPalette);
  document.getElementById('emptyImport').addEventListener('click', importMedia);
  document.getElementById('emptyText').addEventListener('click', () => addText());
  document.getElementById('emptySubtitles').addEventListener('click', async () => {
    try {
      toast('Listening to the timeline…', 'info');
      const result = await automation.autoSubtitles({});
      toast(`${result.count} captions added · ${result.engine}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  ui.playBtn.addEventListener('click', () => setPlaying(!store.state.playing));

  document.getElementById('prevFrame').addEventListener('click', () => store.seek(store.state.playhead - 1 / project().fps));
  document.getElementById('nextFrame').addEventListener('click', () => store.seek(store.state.playhead + 1 / project().fps));
  document.getElementById('loopBtn').addEventListener('click', (event) => {
    store.state.loop = !store.state.loop;
    event.currentTarget.classList.toggle('is-on', store.state.loop);
  });
  document.getElementById('guidesBtn').addEventListener('click', (event) => {
    store.state.showGuides = !store.state.showGuides;
    event.currentTarget.classList.toggle('is-on', store.state.showGuides);
  });
  document.getElementById('compareBtn').addEventListener('click', (event) => {
    store.state.compare = !store.state.compare;
    event.currentTarget.classList.toggle('is-on', store.state.compare);
  });

  const volume = document.getElementById('masterVolume');
  if (volume) {
    volume.addEventListener('input', () => {
      const value = Number(volume.value) / 100;
      store.state.masterVolume = value;
      engine.setMasterVolume(value);
    });
  }

  const rangeSelect = document.getElementById('exportRangeSelect');
  if (rangeSelect) rangeSelect.addEventListener('change', syncRangeOptions);

  document.getElementById('exportStill').addEventListener('click', saveStill);

  document.getElementById('exportClose').addEventListener('click', closeExportDialog);
  document.getElementById('exportCancel').addEventListener('click', () => {
    exportCancel.cancelled = true;
  });
  document.getElementById('exportStart').addEventListener('click', startExport);
  document.getElementById('exportModal').addEventListener('click', (event) => {
    if (event.target.id === 'exportModal') closeExportDialog();
  });

  store.subscribe((state, reason) => {
    if (reason === 'playhead') {
      ui.timecode.textContent = formatTimecode(state.playhead, project().fps);
      return;
    }
    if (reason === 'transport') {
      ui.timecode.textContent = formatTimecode(state.playhead, project().fps);
      return;
    }
    reflectProject();
    if (reason === 'selection' || reason === 'mutate' || reason === 'project' || reason === 'history') {
      panels.renderInspector();
    }
  });
}

async function bindFileDrop() {
  if (!platform.hasTauri) {
    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault(); dragDepth += 1; ui.dropOverlay.classList.add('is-visible');
    });
    window.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    });
    window.addEventListener('dragleave', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) ui.dropOverlay.classList.remove('is-visible');
    });
    window.addEventListener('drop', async (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault(); dragDepth = 0; ui.dropOverlay.classList.remove('is-visible');
      await ingestPaths([...event.dataTransfer.files]);
    });
    return;
  }
  const { listen } = await import('./tauri.js');
  await listen('tauri://drag-enter', () => ui.dropOverlay.classList.add('is-visible'));
  await listen('tauri://drag-leave', () => ui.dropOverlay.classList.remove('is-visible'));
  await listen('tauri://drag-drop', async (event) => {
    ui.dropOverlay.classList.remove('is-visible');
    const paths = event?.payload?.paths || [];
    await ingestPaths(paths);
  });
}

async function boot() {
  await platform.initBrowserStorage?.();
  document.getElementById('driveButton')?.addEventListener('click', () => {
    platform.setDriveProject?.(JSON.stringify(store.state.project));
  });
  timeline = createTimeline({
    store,
    onSeek: (time) => store.seek(time),
    onSelect: (clipId) => store.select(clipId),
  });
  const app = {
    importMedia,
    addMediaToTimeline: (media) => {
      const clip = createClip(trackKindFor(media.kind), {
        name: media.name,
        mediaKey: media.key,
        ext: extOf(media.name),
        out: Math.max(0.3, media.duration || 5),
      });
      timeline.appendClip(clip);
    },
    addText,
    splitAtPlayhead,
    duplicateSelected,
    deleteSelected,
    toast,
    newProject,
    listProjects,
    loadProject,
    deleteProject,
    checkForUpdate,
  };
  window.__tacot = { store, engine, timeline, app, automation, previewControls };

  panels = createPanels({ store, engine, timeline, app, auto: automation });
  window.__tacotPanels = panels;

  bindTopBar();
  bindKeys();
  window.addEventListener('resize', fitPreview);
  if (window.ResizeObserver) {
    const wrap = document.querySelector('.preview-wrap');
    if (wrap) new ResizeObserver(() => fitPreview()).observe(wrap);
  }
  fitPreview();
  await bindFileDrop();

  store.state.ffmpeg = await platform.checkFfmpeg();
  reflectProject();

  const autosaved = await platform.readAutosave();
  if (autosaved) {
    try {
      const raw = JSON.parse(autosaved);
      if (raw && Array.isArray(raw.tracks) && raw.tracks.some((track) => track.clips?.length)) {
        await hydrate(raw);
        toast('Restored your last session', 'info');
      }
    } catch {
      /* ignore corrupt autosave */
    }
  }

  reflectProject();
  panels.render();
  timeline.render();

  autosaveTimer = setInterval(async () => {
    if (store.state.exportBusy) return;
    try {
      await platform.autosave(JSON.stringify(store.state.project));
      store.state.autosaveAt = Date.now();
      if (store.state.saveState === 'dirty') {
        ui.saveState.textContent = 'Autosaved';
      }
    } catch {
      /* non-fatal */
    }
  }, 20000);

  reflectEngineStatus();
  checkForUpdate().catch(() => {});
  setInterval(() => {
    if (!updateChecked) checkForUpdate().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  const splash = document.getElementById('splash');
  if (splash) {
    setTimeout(() => {
      splash.classList.add('is-gone');
      setTimeout(() => splash.remove(), 700);
    }, 820);
  }

  lastFrame = performance.now();
  requestAnimationFrame(loop);
}

async function reflectEngineStatus() {
  const node = document.getElementById('statusEngine');
  if (!node) return;
  try {
    const info = await platform.command('transcribe_engine');
    node.textContent = `Speech: ${info.engine}`;
    node.title = info.detail || '';
  } catch {
    node.textContent = 'Speech: desktop app only';
  }
}

boot().catch((err) => {
  console.error(err);
  toast(`Startup problem: ${err.message}`, 'error');
});
