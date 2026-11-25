// Interactive multi-track timeline: ruler, tracks, drag/trim/razor, snapping, zoom.
import {
  clipDuration,
  clipEnd,
  createClip,
  createTrack,
  moveClipToTrack,
  placeClip,
  snapCandidates,
  snapTime,
  splitClip,
  trimClip,
  sequenceDuration,
  displayDuration,
  formatTimecode,
  keyframeTimes,
  sortTracks,
} from './model.js';
import { effectAmountLabel } from './labels.js';

const TRACK_HEIGHT = 62;
const HEADER_WIDTH = 132;

export function createTimeline({ store, onSelect, onSeek }) {
  const root = document.getElementById('timeline');
  const scroll = document.getElementById('tlScroll');
  const content = document.getElementById('tlContent');
  const ruler = document.getElementById('tlRuler');
  const tracksEl = document.getElementById('tlTracks');
  const playhead = document.getElementById('tlPlayhead');
  const zoomLabel = document.getElementById('tlZoomLabel');
  const rangeEl = document.createElement('div');
  rangeEl.className = 'tl-range';
  const markersEl = document.createElement('div');
  markersEl.className = 'tl-markers';
  const snapButton = document.getElementById('tlSnap');
  const razorButton = document.getElementById('tlRazor');
  const durationLabel = document.getElementById('tlDuration');

  let dragging = null;

  function zoom() {
    return store.state.zoom;
  }

  function widthFor(seconds) {
    return Math.max(360, seconds * zoom());
  }

  function totalWidth() {
    return widthFor(sequenceDuration(store.state.project) + 6);
  }

  function timestamp() {
    const relative = store.state.playhead;
    return formatTimecode(relative, store.state.project.fps);
  }

  function renderRuler() {
    const width = totalWidth();
    const perSecond = zoom();
    let step = 1;
    if (perSecond < 24) step = 5;
    if (perSecond < 10) step = 10;
    if (perSecond < 4) step = 30;
    const labelStep = perSecond < 26 ? step * 2 : step;
    ruler.style.width = `${width}px`;
    const fragment = document.createDocumentFragment();
    const end = Math.ceil(width / perSecond);
    for (let second = 0; second <= end; second += step) {
      const major = second % (labelStep) === 0;
      const tick = document.createElement('div');
      tick.className = major ? 'tl-tick tl-tick-major' : 'tl-tick';
      tick.style.left = `${second * perSecond}px`;
      if (major) {
        const label = document.createElement('span');
        label.className = 'tl-tick-label';
        label.textContent = displayDuration(second);
        tick.appendChild(label);
      }
      fragment.appendChild(tick);
    }
    ruler.replaceChildren(fragment);
  }

  function waveform(canvas, clip) {
    const peaks = store.state.media.get(clip.mediaKey)?.peaks || [];
    const ctx = canvas.getContext('2d');
    const width = Math.max(2, Math.floor(clipDuration(clip) * zoom()));
    const height = TRACK_HEIGHT - 26;
    canvas.width = Math.min(6000, width);
    canvas.height = height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!peaks.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, height / 2 - 1, canvas.width, 2);
      return;
    }
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(255,138,96,0.95)');
    gradient.addColorStop(1, 'rgba(255,92,57,0.55)');
    ctx.fillStyle = gradient;
    const barWidth = 2;
    const gap = 1;
    const count = Math.max(1, Math.floor(canvas.width / (barWidth + gap)));
    for (let i = 0; i < count; i += 1) {
      const peak = peaks[Math.floor((i / count) * peaks.length)] || 0;
      const barHeight = Math.max(2, peak * (height - 6));
      ctx.fillRect(i * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight);
    }
  }

  function clipNode(clip, track) {
    const node = document.createElement('div');
    const selected = store.selectedIds().includes(clip.id);
    node.className = `clip clip-${clip.kind}${selected ? ' is-selected' : ''}${clip.muted ? ' is-muted' : ''}`;
    node.dataset.clipId = clip.id;
    node.dataset.trackId = track.id;
    node.style.left = `${clip.start * zoom()}px`;
    node.style.width = `${Math.max(14, clipDuration(clip) * zoom())}px`;

    const cached = store.state.media.get(clip.mediaKey);
    if (clip.kind === 'video' && cached?.frames?.length) {
      const strip = document.createElement('div');
      strip.className = 'clip-strip';
      strip.style.backgroundImage = `url("${cached.frames[Math.min(2, cached.frames.length - 1)]}")`;
      node.appendChild(strip);
    }
    if (clip.kind === 'audio' || (clip.kind === 'video' && (cached?.peaks?.length || 0) > 0)) {
      const canvas = document.createElement('canvas');
      canvas.className = 'clip-wave';
      if (clip.kind === 'video') canvas.classList.add('is-under');
      node.appendChild(canvas);
      requestAnimationFrame(() => waveform(canvas, clip));
    }

    const marks = keyframeTimes(clip);
    if (marks.length) {
      const wrap = document.createElement('div');
      wrap.className = 'clip-keys';
      for (const local of marks) {
        const key = document.createElement('span');
        key.className = 'clip-key';
        key.style.left = `${Math.max(2, local * zoom())}px`;
        wrap.appendChild(key);
      }
      node.appendChild(wrap);
    }
    if (clip.kind === 'text') {
      const preview = document.createElement('div');
      preview.className = 'clip-text-preview';
      preview.textContent = clip.text?.content || 'Text';
      node.appendChild(preview);
    }

    const shade = document.createElement('div');
    shade.className = 'clip-shade';
    node.appendChild(shade);

    const label = document.createElement('div');
    label.className = 'clip-label';
    const kindIcon = clip.kind === 'audio' ? '♪' : clip.kind === 'text' ? 'T' : '▸';
    label.innerHTML = `<span class="clip-kind">${kindIcon}</span><span class="clip-name"></span>`;
    label.querySelector('.clip-name').textContent = clip.name || 'Clip';
    node.appendChild(label);

    const badges = document.createElement('div');
    badges.className = 'clip-badges';
    if (clip.speed !== 1) badges.appendChild(badge(`${clip.speed.toFixed(2).replace(/\.?0+$/, '')}×`, 'speed'));
    if (clip.filter && clip.filter !== 'none') badges.appendChild(badge('FIL', 'filter'));
    const fxLabel = effectAmountLabel(clip.effect);
    if (fxLabel) badges.appendChild(badge(fxLabel, 'fx'));
    if (clip.transition && clip.transition.id !== 'none') badges.appendChild(badge('↔', 'transition'));
    const keyCount = Object.values(clip.keyframes || {}).reduce((sum, list) => sum + list.length, 0);
    if (keyCount) badges.appendChild(badge(`◆${keyCount}`, 'keys'));
    if (badges.childElementCount) node.appendChild(badges);

    if (clip.transition && clip.transition.id !== 'none') {
      const t = document.createElement('div');
      t.className = 'clip-transition';
      t.style.width = `${Math.max(8, clip.transition.duration * zoom())}px`;
      node.appendChild(t);
    }

    const left = document.createElement('div');
    left.className = 'clip-handle clip-handle-left';
    left.title = 'Drag to trim the clip start';
    left.setAttribute('aria-label', 'Trim clip start');
    const right = document.createElement('div');
    right.className = 'clip-handle clip-handle-right';
    right.title = 'Drag to trim the clip end';
    right.setAttribute('aria-label', 'Trim clip end');
    node.append(left, right);
    return node;
  }

  function badge(text, kind) {
    const span = document.createElement('span');
    span.className = `clip-badge clip-badge-${kind}`;
    span.textContent = text;
    return span;
  }

  function trackHeader(track) {
    const header = document.createElement('div');
    header.className = 'track-header';
    header.style.height = `${TRACK_HEIGHT}px`;
    header.innerHTML = `
      <span class="track-kind">${track.kind === 'audio' ? 'AUDIO' : track.kind === 'text' ? 'TEXT' : track.kind === 'overlay' ? 'OVERLAY' : 'VIDEO'}</span>
      <span class="track-name"></span>
      <div class="track-actions">
        <button class="track-btn" data-action="mute" title="Mute track">${track.muted ? '⊘' : '◉'}</button>
        <button class="track-btn" data-action="lock" title="Lock track">${track.locked ? '▣' : '▢'}</button>
        <button class="track-btn" data-action="hide" title="Hide track">${track.hidden ? '◌' : '◍'}</button>
        <button class="track-btn track-btn-delete" data-action="delete" title="Delete track">×</button>
      </div>`;
    header.querySelector('.track-name').textContent = track.name;
    header.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'delete') {
        const sameKind = store.state.project.tracks.filter((item) => item.kind === track.kind).length;
        if ((track.kind === 'video' || track.kind === 'audio') && sameKind <= 1) return;
        store.mutate('delete track', (draft) => {
          draft.tracks = draft.tracks.filter((item) => item.id !== track.id);
        });
        return;
      }
      store.mutate(`track-${action}`, () => {
        if (action === 'mute') track.muted = !track.muted;
        if (action === 'lock') track.locked = !track.locked;
        if (action === 'hide') track.hidden = !track.hidden;
      });
    });
    return header;
  }

  function updateRange(project) {
    const range = project.range || {};
    const start = Number.isFinite(range.in) ? Math.max(0, range.in) : 0;
    const end = Number.isFinite(range.out) ? range.out : sequenceDuration(project);
    if (end - start < 0.05) {
      rangeEl.classList.remove('is-visible');
      return;
    }
    rangeEl.classList.add('is-visible');
    rangeEl.style.left = `${start * zoom()}px`;
    rangeEl.style.width = `${Math.max(2, (end - start) * zoom())}px`;
  }

  function renderMarkers(project) {
    const fragment = document.createDocumentFragment();
    for (const marker of project.markers || []) {
      const lane = document.createElement('div');
      lane.className = 'tl-marker';
      lane.style.left = `${marker.time * zoom()}px`;
      const flag = document.createElement('button');
      flag.type = 'button';
      flag.className = 'tl-marker-flag';
      flag.style.background = marker.color || '#2ad6c4';
      flag.title = `${marker.label} · ${formatTimecode(marker.time, project.fps)}`;
      flag.addEventListener('click', (event) => {
        event.stopPropagation();
        onSeek(marker.time);
      });
      lane.appendChild(flag);
      fragment.appendChild(lane);
    }
    markersEl.replaceChildren(fragment);
    if (!markersEl.isConnected) content.insertBefore(markersEl, content.firstChild);
  }

  function render() {
    const project = store.state.project;
    const width = totalWidth();
    content.style.width = `${width}px`;
    renderRuler();
    updateRange(project);
    renderMarkers(project);
    if (!rangeEl.isConnected) content.insertBefore(rangeEl, content.firstChild);

    const fragment = document.createDocumentFragment();
    for (const track of project.tracks) {
      const row = document.createElement('div');
      row.className = 'track';
      row.style.height = `${TRACK_HEIGHT}px`;
      row.dataset.trackId = track.id;
      row.appendChild(trackHeader(track));
      const lane = document.createElement('div');
      lane.className = 'track-lane';
      lane.dataset.trackId = track.id;
      lane.style.width = `${width}px`;
      for (const clip of track.clips) lane.appendChild(clipNode(clip, track));
      row.appendChild(lane);
      fragment.appendChild(row);
    }
    tracksEl.replaceChildren(fragment);

    durationLabel.textContent = `${displayDuration(sequenceDuration(project))} · ${project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} clips`;
    zoomLabel.textContent = `${Math.round(zoom())} px/s`;
    snapButton.classList.toggle('is-on', store.state.snap);
    razorButton.classList.toggle('is-on', store.state.tool === 'razor');
    syncPlayhead();
  }

  function syncPlayhead() {
    const x = store.state.playhead * zoom();
    playhead.style.transform = `translateX(${x}px)`;
    document.getElementById('tlTime').textContent = timestamp();
  }

  function timeAt(clientX) {
    const rect = content.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / zoom());
  }

  function trackAt(clientY) {
    const rows = [...tracksEl.querySelectorAll('.track')];
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) return row.dataset.trackId;
    }
    return null;
  }

  function beginDrag(event, clip, track, mode) {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    // `currentTarget` is the timeline container because the listener is
    // delegated. Use the actual clip under the pointer so trim previews resize
    // the clip itself instead of stretching the entire timeline.
    const node = event.target.closest('.clip');
    if (!node) return;
    const group =
      mode === 'move'
        ? store
            .selectedClips()
            .map(({ clip: item, track: itemTrack }) => ({ id: item.id, trackId: itemTrack.id, start: item.start }))
        : [];
    dragging = {
      mode,
      clipId: clip.id,
      trackId: track.id,
      startX,
      startY,
      originStart: clip.start,
      originEnd: clipEnd(clip),
      originIn: clip.in,
      originOut: clip.out,
      width: node.offsetWidth,
      moved: false,
      ghostTrack: track.id,
      ghostStart: clip.start,
      node,
      group,
    };
    node.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function onPointerMove(event) {
    if (!dragging) return;
    const dx = event.clientX - dragging.startX;
    const dy = event.clientY - dragging.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragging.moved = true;
    const deltaSeconds = dx / zoom();

    if (dragging.mode === 'move') {
      const targetTrack = trackAt(event.clientY) || dragging.trackId;
      const track = store.state.project.tracks.find((item) => item.id === targetTrack);
      const candidates = snapCandidates(store.state.project, dragging.clipId);
      const raw = Math.max(0, dragging.originStart + deltaSeconds);
      const snapped = snapTime(raw, candidates, 8 / zoom(), store.state.snap);
      const snappedEnd = snapTime(raw + (dragging.originEnd - dragging.originStart), candidates, 8 / zoom(), store.state.snap);
      const useEnd = Math.abs(snappedEnd.time - (raw + dragging.originEnd - dragging.originStart)) <
        Math.abs(snapped.time - raw);
      const nextStart = Math.max(0, useEnd ? snappedEnd.time - (dragging.originEnd - dragging.originStart) : snapped.time);
      dragging.ghostStart = nextStart;
      dragging.node.style.transform = `translateX(${(nextStart - dragging.originStart) * zoom()}px)`;
      dragging.node.classList.toggle('is-detached', Boolean(track && track.id !== dragging.trackId));
      showSnapGuide(useEnd ? snappedEnd.snapped : snapped.snapped);
    } else {
      const candidates = snapCandidates(store.state.project, dragging.clipId);
      const time = timeAt(event.clientX);
      const snapped = snapTime(time, candidates, 8 / zoom(), store.state.snap);
      showSnapGuide(snapped.snapped);
      if (dragging.mode === 'trim-start') {
        const maxStart = dragging.originEnd - 0.1;
        const nextStart = Math.max(0, Math.min(snapped.time, maxStart));
        dragging.node.style.transform = 'none';
        dragging.node.style.left = `${nextStart * zoom()}px`;
        dragging.node.style.width = `${Math.max(14, (dragging.originEnd - nextStart) * zoom())}px`;
        dragging.pendingTrim = nextStart;
      } else if (dragging.mode === 'trim-end') {
        const nextEnd = Math.max(dragging.originStart + 0.1, snapped.time);
        dragging.node.style.width = `${Math.max(14, (nextEnd - dragging.originStart) * zoom())}px`;
        dragging.pendingTrim = nextEnd;
      }
    }
  }

  function showSnapGuide(time) {
    const guide = document.getElementById('tlSnapGuide');
    if (time === null || time === undefined) {
      guide.classList.remove('is-visible');
      return;
    }
    guide.style.transform = `translateX(${time * zoom()}px)`;
    guide.classList.add('is-visible');
  }

  function onPointerUp(event) {
    window.removeEventListener('pointermove', onPointerMove);
    showSnapGuide(null);
    if (!dragging) return;
    const drag = dragging;
    dragging = null;
    if (!drag.moved) return;

    const clipEntry = store.findClip(drag.clipId);
    if (!clipEntry) return;

    if (drag.mode === 'move') {
      const targetTrack = trackAt(event.clientY) || drag.trackId;
      const start = Math.max(0, drag.ghostStart);
      const delta = start - drag.originStart;
      store.mutate('move clips', () => {
        const others = (drag.group || []).filter((item) => item.id !== drag.clipId);
        for (const member of others) {
          const entry = store.findClip(member.id);
          if (!entry) continue;
          entry.track.clips = entry.track.clips.filter((item) => item.id !== member.id);
          entry.clip.start = Math.max(0, member.start + delta);
          placeClip(entry.track, entry.clip);
        }
        if (targetTrack !== drag.trackId) {
          moveClipToTrack(store.state.project, drag.clipId, targetTrack, start);
        } else {
          const track = store.state.project.tracks.find((item) => item.id === drag.trackId);
          const clip = track.clips.find((item) => item.id === drag.clipId);
          if (!clip) return;
          track.clips = track.clips.filter((item) => item.id !== drag.clipId);
          clip.start = start;
          placeClip(track, clip);
        }
      });
      render();
    } else if (drag.pendingTrim !== undefined) {
      store.mutate('trim clip', () => {
        const clip = clipEntry.clip;
        trimClip(clip, drag.mode === 'trim-start' ? 'start' : 'end', drag.pendingTrim, 0.1);
      });
      render();
    }
  }

  function onClick(event) {
    const clipEl = event.target.closest('.clip');
    const trackRow = event.target.closest('.track');
    if (!clipEl) {
      if (trackRow) {
        const time = timeAt(event.clientX);
        onSeek(time);
        store.select(null, trackRow.dataset.trackId);
      }
      return;
    }
    const clipId = clipEl.dataset.clipId;
    const trackId = clipEl.dataset.trackId;
    store.select(clipId, trackId, { additive: event.shiftKey });
    const time = timeAt(event.clientX);
    if (store.state.tool === 'razor') {
      store.mutate('split clip', () => splitClip(store.state.project, clipId, time));
      return;
    }
    onSeek(time);
  }

  function onDoubleClick(event) {
    const clipEl = event.target.closest('.clip');
    if (!clipEl) return;
    const entry = store.findClip(clipEl.dataset.clipId);
    if (!entry) return;
    onSeek(entry.clip.start);
    onSelect(entry.clip.id);
  }

  function bind() {
    content.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('.clip-handle');
      const clipEl = event.target.closest('.clip');
      if (clipEl && !clipEl.dataset.trackId) return;
      if (!clipEl) return;
      const entry = store.findClip(clipEl.dataset.clipId);
      if (!entry) return;
      const track = store.state.project.tracks.find((item) => item.id === clipEl.dataset.trackId);
      if (!track || track.locked) return;
      if (event.button !== 0) return;
      if (!event.shiftKey) store.select(entry.clip.id, track.id);
      if (store.state.tool === 'razor' && !handle) return;
      if (handle) beginDrag(event, entry.clip, track, handle.classList.contains('clip-handle-left') ? 'trim-start' : 'trim-end');
      else beginDrag(event, entry.clip, track, 'move');
    });
    content.addEventListener('click', onClick);
    content.addEventListener('dblclick', onDoubleClick);

    ruler.addEventListener('pointerdown', (event) => {
      const seek = (clientX) => onSeek(Math.max(0, timeAt(clientX)));
      seek(event.clientX);
      const move = (ev) => seek(ev.clientX);
      const up = () => {
        window.removeEventListener('pointermove', move);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
    });

    scroll.addEventListener('wheel', (event) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const rect = content.getBoundingClientRect();
        const anchorTime = Math.max(0, (event.clientX - rect.left) / zoom());
        const next = Math.max(14, Math.min(420, zoom() * (event.deltaY < 0 ? 1.12 : 0.89)));
        store.state.zoom = next;
        render();
        scroll.scrollLeft = Math.max(0, anchorTime * next - (event.clientX - scroll.getBoundingClientRect().left));
      }
    }, { passive: false });

    snapButton?.addEventListener('click', () => {
      store.state.snap = !store.state.snap;
      render();
    });
    razorButton?.addEventListener('click', () => {
      store.state.tool = store.state.tool === 'razor' ? 'select' : 'razor';
      render();
    });

    document.getElementById('tlZoomIn')?.addEventListener('click', () => {
      store.state.zoom = Math.min(420, zoom() * 1.25);
      render();
    });
    document.getElementById('tlZoomOut')?.addEventListener('click', () => {
      store.state.zoom = Math.max(14, zoom() / 1.25);
      render();
    });
    document.getElementById('tlAddTrack')?.addEventListener('click', () => {
      store.mutate('add track', (draft) => {
        const overlayCount = draft.tracks.filter((track) => track.kind === 'overlay').length;
        const track = createTrack('overlay', `Overlay ${overlayCount + 1}`);
        draft.tracks.push(track);
        sortTracks(draft);
      });
    });

    let queued = false;
    store.subscribe((state, reason) => {
      if (reason === 'playhead') {
        syncPlayhead();
        return;
      }
      // Editing gestures (slider drags) are throttled; structural changes render at once.
      if (reason === 'live' || reason === 'zoom') {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          render();
        });
        return;
      }
      render();
    });
  }

  function addClipToTrack(trackId, clip) {
    store.mutate('add clip', () => {
      const track = store.state.project.tracks.find((item) => item.id === trackId);
      if (!track) return;
      track.clips.push(clip);
      track.clips.sort((a, b) => a.start - b.start);
    });
  }

  function selectedTrackFor(kind) {
    const tracks = store.state.project.tracks;
    if (kind === 'audio') return tracks.find((track) => track.kind === 'audio') || tracks[tracks.length - 1];
    return tracks.find((track) => track.kind === 'video') || tracks[0];
  }

  function appendClip(clip, trackId) {
    const targetTrack = trackId || selectedTrackFor(clip.kind).id;
    const track = store.state.project.tracks.find((item) => item.id === targetTrack);
    const end = track.clips.reduce((max, item) => Math.max(max, clipEnd(item)), 0);
    clip.start = end;
    addClipToTrack(targetTrack, clip);
    store.select(clip.id, targetTrack);
    onSeek(clip.start);
    return clip;
  }

  function addTextClip(text = 'Your headline') {
    let textTrack = store.state.project.tracks.find((track) => track.kind === 'text');
    if (!textTrack) {
      textTrack = createTrack('text', 'Text 1');
      store.mutate('add text track', (draft) => {
        draft.tracks.push(textTrack);
        sortTracks(draft);
      });
    }
    const clip = createClip('text', { start: store.state.playhead, duration: 4, name: text.slice(0, 22) });
    clip.text.content = text;
    appendClip(clip, textTrack.id);
    return clip;
  }


  bind();
  return { render, syncPlayhead, appendClip, addTextClip, selectedTrackFor, TRACK_HEIGHT, HEADER_WIDTH };
}
