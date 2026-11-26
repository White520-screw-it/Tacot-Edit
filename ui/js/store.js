// Central editor state: project, selection, playhead, undo/redo, pub/sub.
import { createProject, normalizeProject } from './model.js';

export function createStore(project = createProject()) {
  const state = {
    project: normalizeProject(project),
    selection: { clipId: null, trackId: null, extra: [] },
    playhead: 0,
    playing: false,
    playRate: 1,
    zoom: 72,
    snap: true,
    tool: 'select',
    loop: false,
    showGuides: true,
    compare: false,
    saveState: 'saved',
    lastSavedAt: null,
    autosaveAt: null,
    exportBusy: false,
    autoKey: false,
    masterVolume: 1,
    ffmpeg: { found: false, path: '', version: '' },
    media: new Map(),
  };

  const subscribers = new Set();
  const history = { past: [], future: [], limit: 80, label: '' };

  function snapshot() {
    return JSON.stringify(state.project);
  }

  function notify(reason = 'change') {
    for (const subscriber of subscribers) subscriber(state, reason);
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  function touch() {
    state.project.updatedAt = Date.now();
    state.saveState = 'dirty';
  }

  /** Run a mutation as one undoable step. */
  function mutate(label, fn, options = {}) {
    const before = snapshot();
    const result = fn(state.project);
    const after = snapshot();
    if (before !== after) {
      history.past.push({ json: before, label });
      if (history.past.length > history.limit) history.past.shift();
      history.future.length = 0;
      touch();
    }
    notify(options.reason || 'mutate');
    return result;
  }

  /** Coalesced mutation for drag gestures: no history entry, but marked dirty. */
  function live(fn, reason = 'live') {
    const result = fn(state.project);
    touch();
    notify(reason);
    return result;
  }

  function undo() {
    const entry = history.past.pop();
    if (!entry) return false;
    history.future.push({ json: snapshot(), label: entry.label });
    state.project = normalizeProject(JSON.parse(entry.json));
    ensureSelection();
    touch();
    notify('history');
    return true;
  }

  function redo() {
    const entry = history.future.pop();
    if (!entry) return false;
    history.past.push({ json: snapshot(), label: entry.label });
    state.project = normalizeProject(JSON.parse(entry.json));
    ensureSelection();
    touch();
    notify('history');
    return true;
  }

  function canUndo() {
    return history.past.length > 0;
  }

  function canRedo() {
    return history.future.length > 0;
  }

  function ensureSelection() {
    if (!state.selection.clipId) return;
    const found = findClip(state.selection.clipId);
    if (!found) {
      state.selection.clipId = null;
      state.selection.trackId = null;
    } else {
      state.selection.trackId = found.track.id;
    }
  }

  function findClip(clipId) {
    for (const track of state.project.tracks) {
      const clip = track.clips.find((item) => item.id === clipId);
      if (clip) return { clip, track };
    }
    return null;
  }

  function selected() {
    return state.selection.clipId ? findClip(state.selection.clipId) : null;
  }

  function select(clipId, trackId = null, options = {}) {
    if (options.additive && clipId) {
      const extra = new Set(state.selection.extra);
      if (state.selection.clipId === clipId) {
        const next = [...extra].filter((id) => id !== clipId);
        state.selection.clipId = next.pop() || null;
        state.selection.extra = next;
      } else if (extra.has(clipId)) {
        extra.delete(clipId);
        state.selection.extra = [...extra];
      } else {
        if (state.selection.clipId) extra.add(state.selection.clipId);
        extra.delete(clipId);
        state.selection.clipId = clipId;
        state.selection.extra = [...extra];
      }
      state.selection.trackId = trackId;
      notify('selection');
      return;
    }
    state.selection.clipId = clipId;
    state.selection.trackId = trackId;
    state.selection.extra = options.keepExtra ? state.selection.extra : [];
    notify('selection');
  }

  /** Every selected clip id, primary first. */
  function selectedIds() {
    const ids = [];
    if (state.selection.clipId) ids.push(state.selection.clipId);
    for (const id of state.selection.extra) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  function selectedClips() {
    return selectedIds()
      .map((id) => findClip(id))
      .filter(Boolean);
  }

  function setProject(next, options = {}) {
    state.project = normalizeProject(next);
    state.playhead = Math.min(state.playhead, 100000);
    history.past.length = 0;
    history.future.length = 0;
    state.saveState = options.saved ? 'saved' : 'dirty';
    ensureSelection();
    notify('project');
  }

  /** Slider/drag gestures: snapshot on pointerdown, commit once on release. */
  function gestureStart() {
    return snapshot();
  }

  function gestureEnd(label, before) {
    const after = snapshot();
    if (before === after) return false;
    history.past.push({ json: before, label });
    if (history.past.length > history.limit) history.past.shift();
    history.future.length = 0;
    touch();
    notify('mutate');
    return true;
  }

  function markSaved(at = Date.now()) {
    state.saveState = 'saved';
    state.lastSavedAt = at;
    notify('saved');
  }

  function seek(time, options = {}) {
    const duration = Math.max(1, sequenceEnd());
    state.playhead = Math.max(0, Math.min(time, options.allowBeyond ? time : duration));
    notify('playhead');
  }

  function sequenceEnd() {
    let end = 0;
    for (const track of state.project.tracks) {
      for (const clip of track.clips) {
        const speed = clip.speed > 0 ? clip.speed : 1;
        end = Math.max(end, clip.start + Math.max(0.05, (clip.out - clip.in) / (clip.kind === 'text' ? 1 : speed)));
      }
    }
    return end;
  }

  return {
    state,
    subscribe,
    notify,
    mutate,
    live,
    undo,
    redo,
    canUndo,
    canRedo,
    findClip,
    selected,
    selectedIds,
    selectedClips,
    select,
    setProject,
    markSaved,
    gestureStart,
    gestureEnd,
    seek,
    sequenceEnd,
    historySize: () => history.past.length,
    resetHistory() {
      history.past.length = 0;
      history.future.length = 0;
    },
  };
}
