// Direct manipulation on the program monitor: move, scale and rotate the selected clip.
import { clamp, clipEnd, transformAt, upsertKeyframe } from './model.js';

export function createPreviewControls({ store, engine, frame }) {
  const layer = document.createElement('div');
  layer.className = 'preview-gizmo';
  layer.innerHTML = `
    <div class="gizmo-guide gizmo-guide-v"></div>
    <div class="gizmo-guide gizmo-guide-h"></div>
    <div class="gizmo-box">
      <span class="gizmo-handle gizmo-nw" data-handle="nw"></span>
      <span class="gizmo-handle gizmo-ne" data-handle="ne"></span>
      <span class="gizmo-handle gizmo-sw" data-handle="sw"></span>
      <span class="gizmo-handle gizmo-se" data-handle="se"></span>
      <span class="gizmo-rotate" title="Rotate"></span>
    </div>`;
  frame.appendChild(layer);

  const box = layer.querySelector('.gizmo-box');
  const guideV = layer.querySelector('.gizmo-guide-v');
  const guideH = layer.querySelector('.gizmo-guide-h');

  let gesture = null;

  function project() {
    return store.state.project;
  }

  function selectedEntry() {
    const entry = store.selected();
    if (!entry) return null;
    const time = store.state.playhead;
    if (time < entry.clip.start - 0.001 || time > clipEnd(entry.clip) + 0.001) return null;
    return entry;
  }

  function metrics(clip) {
    const rect = frame.getBoundingClientRect();
    const project0 = project();
    return {
      rect,
      sx: rect.width / project0.width,
      sy: rect.height / project0.height,
      shift: 0,
    };
  }

  function update() {
    const entry = selectedEntry();
    if (!entry || store.state.playing || store.state.exportBusy) {
      layer.classList.remove('is-active');
      return;
    }
    const clip = entry.clip;
    const tr = transformAt(clip, store.state.playhead);
    const size = engine.measureClipBox(clip);
    const { rect, sx, sy } = metrics(clip);
    const centerX = (project().width / 2 + tr.x * project().width) * sx;
    const centerY = (project().height / 2 + tr.y * project().height) * sy;
    const width = Math.max(24, size.width * tr.scale * sx);
    const height = Math.max(18, size.height * tr.scale * sy);

    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    box.style.left = `${centerX - width / 2}px`;
    box.style.top = `${centerY - height / 2}px`;
    box.style.transform = `rotate(${tr.rotation}deg)`;
    box.style.opacity = clip.kind === 'text' ? '0.9' : '1';
    layer.classList.add('is-active');
    layer.dataset.centerX = String(centerX);
    layer.dataset.centerY = String(centerY);
    layer.dataset.scale = String(tr.scale);
    layer.dataset.rotation = String(tr.rotation);
    layer.dataset.width = String(rect.width);
  }

  function write(clip, property, value) {
    const local = Math.max(0, store.state.playhead - clip.start);
    if (store.state.autoKey || (clip.keyframes && clip.keyframes[property]?.length)) {
      upsertKeyframe(clip, property, local, Number(value.toFixed(4)));
    } else {
      clip.transform[property] = value;
    }
  }

  function startGesture(event, mode) {
    const entry = selectedEntry();
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    const { rect, sx, sy } = metrics(entry.clip);
    const centerX = rect.left + Number(layer.dataset.centerX);
    const centerY = rect.top + Number(layer.dataset.centerY);
    gesture = {
      mode,
      clip: entry.clip,
      before: store.gestureStart(),
      originX: entry.clip.transform.x,
      originY: entry.clip.transform.y,
      originScale: entry.clip.transform.scale,
      originRotation: entry.clip.transform.rotation,
      startX: event.clientX,
      startY: event.clientY,
      centerX,
      centerY,
      startDistance: Math.hypot(event.clientX - centerX, event.clientY - centerY) || 1,
      startAngle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
      sx,
      sy,
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  }

  function onMove(event) {
    if (!gesture) return;
    const clip = gesture.clip;
    const project0 = project();
    if (gesture.mode === 'move') {
      const dx = (event.clientX - gesture.startX) / gesture.sx / project0.width;
      const dy = (event.clientY - gesture.startY) / gesture.sy / project0.height;
      let nextX = gesture.originX + dx;
      let nextY = gesture.originY + dy;
      const snapX = 9 / gesture.sx / project0.width;
      const snapY = 9 / gesture.sy / project0.height;
      const snapXHit = Math.abs(nextX) < snapX;
      const snapYHit = Math.abs(nextY) < snapY;
      if (!event.altKey) {
        if (snapXHit) nextX = 0;
        if (snapYHit) nextY = 0;
      }
      guideV.classList.toggle('is-on', snapXHit);
      guideH.classList.toggle('is-on', snapYHit);
      store.live(() => {
        write(clip, 'x', clamp(nextX, -2, 2));
        write(clip, 'y', clamp(nextY, -2, 2));
      }, 'live');
    } else if (gesture.mode === 'scale') {
      const distance = Math.hypot(event.clientX - gesture.centerX, event.clientY - gesture.centerY);
      const next = clamp(gesture.originScale * (distance / gesture.startDistance), 0.05, 6);
      store.live(() => write(clip, 'scale', next), 'live');
    } else if (gesture.mode === 'rotate') {
      const angle = Math.atan2(event.clientY - gesture.centerY, event.clientX - gesture.centerX);
      let degrees = gesture.originRotation + ((angle - gesture.startAngle) * 180) / Math.PI;
      if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
      store.live(() => write(clip, 'rotation', degrees), 'live');
    }
    update();
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    guideV.classList.remove('is-on');
    guideH.classList.remove('is-on');
    if (!gesture) return;
    const { before, mode } = gesture;
    gesture = null;
    store.gestureEnd(`transform ${mode}`, before);
    update();
  }

  box.addEventListener('pointerdown', (event) => {
    if (event.target.dataset.handle) {
      startGesture(event, 'scale');
      return;
    }
    if (event.target.classList.contains('gizmo-rotate')) {
      startGesture(event, 'rotate');
      return;
    }
    startGesture(event, 'move');
  });

  /** Topmost clip under a point in the monitor (rotated boxes included). */
  function pick(clientX, clientY) {
    const rect = frame.getBoundingClientRect();
    const project0 = project();
    const sx = rect.width / project0.width;
    const sy = rect.height / project0.height;
    const x = (clientX - rect.left) / sx;
    const y = (clientY - rect.top) / sy;
    const time = store.state.playhead;
    for (const track of project0.tracks) {
      if (track.kind === 'audio' || track.hidden) continue;
      for (const clip of track.clips) {
        if (time < clip.start || time >= clipEnd(clip)) continue;
        const tr = transformAt(clip, time);
        const size = engine.measureClipBox(clip);
        const dx = x - (project0.width / 2 + tr.x * project0.width);
        const dy = y - (project0.height / 2 + tr.y * project0.height);
        const rad = (-tr.rotation * Math.PI) / 180;
        const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
        const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
        if (Math.abs(rx) <= (size.width * tr.scale) / 2 && Math.abs(ry) <= (size.height * tr.scale) / 2) {
          return { clip, track };
        }
      }
    }
    return null;
  }

  frame.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.preview-gizmo')) return;
    const hit = pick(event.clientX, event.clientY);
    if (hit) store.select(hit.clip.id, hit.track.id);
    else if (store.state.selection.clipId) store.select(null, null);
  });

  store.subscribe((state, reason) => {
    if (reason === 'playhead' || reason === 'live' || reason === 'selection' || reason === 'mutate' || reason === 'project' || reason === 'history' || reason === 'transport') {
      update();
    }
  });

  window.addEventListener('resize', update);

  return { update };
}
