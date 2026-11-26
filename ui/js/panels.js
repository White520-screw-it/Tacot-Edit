// Left library rail and right inspector.
import {
  ASPECTS,
  EFFECTS,
  FILTERS,
  FONTS,
  TEXT_ANIMATIONS,
  TRANSITIONS,
  clamp,
  createClip,
  defaultAdjust,
  formatTimecode,
  displayDuration,
  keyedValue,
  removeKeyframe,
  sequenceDuration,
  upsertKeyframe,
  clipDuration,
  deleteClip,
  duplicateClip,
  splitClip,
  rippleClose,
  trimClip,
} from './model.js';
import { bytesLabel, effectLabel } from './labels.js';
import { CAPTION_STYLES } from './auto-model.js';

const TABS = [
  { id: 'media', label: 'Media', icon: '▦' },
  { id: 'auto', label: 'Auto', icon: '⚡' },
  { id: 'text', label: 'Text', icon: 'T' },
  { id: 'effects', label: 'Effects', icon: '✦' },
  { id: 'transitions', label: 'Transitions', icon: '↔' },
  { id: 'filters', label: 'Filters', icon: '◐' },
  { id: 'projects', label: 'Projects', icon: '▤' },
];

const TEXT_PRESETS = [
  { name: 'Headline', text: 'YOUR STORY', font: 'display', size: 118, weight: 700, color: '#ffffff', animation: 'fade', background: 'none' },
  { name: 'Subtitle', text: 'Every detail matters', font: 'sans', size: 54, weight: 500, color: '#f4f4f6', animation: 'slideup', background: 'none' },
  { name: 'Lower Third', text: 'Jordan Vale\nDirector of Photography', font: 'sans', size: 44, weight: 600, color: '#ffffff', animation: 'slideup', background: 'box', align: 'left', maxWidth: 0.55 },
  { name: 'Title Card', text: 'CHAPTER ONE', font: 'mono', size: 96, weight: 700, color: '#ff8a60', animation: 'typewriter', background: 'none', letterSpacing: 10 },
  { name: 'Quote', text: '“The edit is where the story is written.”', font: 'display', size: 62, weight: 600, color: '#ffffff', animation: 'word', background: 'none', maxWidth: 0.7 },
  { name: 'Caption', text: 'New drop — link in bio', font: 'rounded', size: 46, weight: 700, color: '#0b0c0f', animation: 'pop', background: 'box', bgColor: '#ffffff', bgOpacity: 0.92 },
];

export function createPanels({ store, engine, timeline, app, auto }) {
  let captionStyleId = 'bold';
  let captionLanguage = 'en';
  const railEl = document.getElementById('rail');
  const bodyEl = document.getElementById('panelBody');
  const inspectorEl = document.getElementById('inspector');
  let activeTab = 'media';

  // ------------------------------------------------------------------ helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function gestureField({ label, value, min, max, step, format, onInput, disabled = false }) {
    const wrap = el('div', 'field');
    const head = el('div', 'field-head');
    head.appendChild(el('span', 'field-label', label));
    const readout = el('span', 'field-value', format ? format(value) : String(value));
    head.appendChild(readout);
    wrap.appendChild(head);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.disabled = disabled;
    let before = null;
    input.addEventListener('pointerdown', () => {
      before = store.gestureStart();
    });
    input.addEventListener('input', () => {
      const next = Number(input.value);
      readout.textContent = format ? format(next) : String(next);
      onInput(next);
    });
    input.addEventListener('change', () => {
      if (before) store.gestureEnd(label.toLowerCase(), before);
      before = null;
    });
    wrap.appendChild(input);
    return wrap;
  }

  function selectField(label, options, value, onChange) {
    const wrap = el('div', 'field field-inline');
    wrap.appendChild(el('span', 'field-label', label));
    const select = document.createElement('select');
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.id;
      node.textContent = option.label;
      if (option.id === value) node.selected = true;
      select.appendChild(node);
    }
    select.addEventListener('change', () => onChange(select.value));
    wrap.appendChild(select);
    return wrap;
  }

  function colorField(label, value, onChange) {
    const wrap = el('div', 'field field-inline');
    wrap.appendChild(el('span', 'field-label', label));
    const input = document.createElement('input');
    input.type = 'color';
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    wrap.appendChild(input);
    return wrap;
  }

  function toggleField(label, value, onChange) {
    const wrap = el('div', 'field field-inline');
    wrap.appendChild(el('span', 'field-label', label));
    const button = el('button', `switch${value ? ' is-on' : ''}`);
    button.type = 'button';
    button.innerHTML = '<span></span>';
    button.addEventListener('click', () => {
      button.classList.toggle('is-on');
      onChange(button.classList.contains('is-on'));
    });
    wrap.appendChild(button);
    return wrap;
  }

  function section(title, openDefault = true) {
    const details = document.createElement('details');
    details.className = 'section';
    details.open = openDefault;
    const summary = document.createElement('summary');
    summary.innerHTML = `<span>${title}</span><span class="chev">▾</span>`;
    details.appendChild(summary);
    const inner = el('div', 'section-body');
    details.appendChild(inner);
    return { details, inner };
  }

  function iconButton(label, title, onClick, variant = '') {
    const button = el('button', `btn ${variant}`.trim(), label);
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', onClick);
    return button;
  }

  // --------------------------------------------------------------------- rail

  function renderRail() {
    const fragment = document.createDocumentFragment();
    for (const tab of TABS) {
      const button = el('button', `rail-btn${activeTab === tab.id ? ' is-active' : ''}`);
      button.type = 'button';
      button.innerHTML = `<span class="rail-icon">${tab.icon}</span><span class="rail-label">${tab.label}</span>`;
      button.addEventListener('click', () => {
        activeTab = tab.id;
        renderRail();
        renderBody();
      });
      fragment.appendChild(button);
    }
    railEl.replaceChildren(fragment);
  }

  function renderBody() {
    const builders = {
      media: renderMediaPanel,
      auto: renderAutoPanel,
      text: renderTextPanel,
      effects: renderEffectsPanel,
      transitions: renderTransitionsPanel,
      filters: renderFiltersPanel,
      projects: renderProjectsPanel,
    };
    bodyEl.replaceChildren(builders[activeTab]());
  }

  function renderMediaPanel() {
    const wrap = el('div', 'panel');
    const head = el('div', 'panel-head');
    head.appendChild(el('h2', null, 'Media Pool'));
    head.appendChild(iconButton('+ Import', 'Add video, audio or images', () => app.importMedia(), 'btn-accent'));
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'panel-hint', 'Drop files anywhere in the window, or import from disk. Everything stays on this computer.'));

    const project = store.state.project;
    if (project.media.length === 0) {
      const empty = el('div', 'empty-card');
      empty.innerHTML = '<div class="empty-icon">▦</div><div>No media yet</div><span>Import a clip to start cutting</span>';
      empty.addEventListener('click', () => app.importMedia());
      wrap.appendChild(empty);
      return wrap;
    }

    const grid = el('div', 'media-grid');
    for (const media of project.media) {
      const card = el('div', 'media-card');
      const thumb = store.state.media.get(media.key);
      const preview = el('div', 'media-thumb');
      if (thumb?.frames?.length) preview.style.backgroundImage = `url("${thumb.frames[0]}")`;
      else preview.classList.add('is-audio');
      preview.innerHTML += `<span class="media-badge">${media.kind}</span>`;
      card.appendChild(preview);
      const meta = el('div', 'media-meta');
      meta.appendChild(el('span', 'media-name', media.name));
      meta.appendChild(el('span', 'media-info', `${displayDuration(media.duration || 0)} · ${bytesLabel(media.bytes || 0)}`));
      card.appendChild(meta);
      card.addEventListener('click', () => app.addMediaToTimeline(media));
      card.addEventListener('dblclick', () => app.addMediaToTimeline(media));
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function actionRow(label, hint, handler) {
    const row = el('div', 'auto-action');
    const button = el('button', 'btn btn-ghost', label);
    button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await handler();
      } catch (err) {
        app.toast(err.message || String(err), 'error');
      } finally {
        button.disabled = false;
      }
    });
    row.appendChild(button);
    row.appendChild(el('span', 'auto-note', hint));
    return row;
  }

  function timeLabel(seconds) {
    const total = Math.max(0, seconds || 0);
    const minutes = Math.floor(total / 60);
    const rest = total - minutes * 60;
    return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
  }

  function renderAutoPanel() {
    const wrap = el('div', 'panel');
    wrap.appendChild(el('h2', null, 'Automation'));
    wrap.appendChild(
      el('p', 'panel-hint', 'One-click helpers. None of them cut, split or reorder a clip — they add captions, settings and markers.'),
    );

    const subtitles = section('Auto subtitles', true);
    const engineLine = el('div', 'engine-line', 'Checking recogniser…');
    subtitles.inner.appendChild(engineLine);
    auto
      .engineInfo()
      .then((info) => {
        engineLine.textContent = `${info.engine} · ${info.detail}`;
      })
      .catch(() => {
        engineLine.textContent = 'Recogniser unavailable';
      });
    subtitles.inner.appendChild(
      selectField(
        'Caption style',
        CAPTION_STYLES.map((style) => ({ id: style.id, label: style.label })),
        captionStyleId,
        (value) => {
          captionStyleId = value;
        },
      ),
    );
    subtitles.inner.appendChild(
      selectField(
        'Language',
        [
          { id: 'en', label: 'English' },
          { id: 'es', label: 'Spanish' },
          { id: 'fr', label: 'French' },
          { id: 'de', label: 'German' },
          { id: 'pt', label: 'Portuguese' },
          { id: 'auto', label: 'Detect' },
        ],
        captionLanguage,
        (value) => {
          captionLanguage = value;
        },
      ),
    );
    const status = el('p', 'panel-hint', 'Select a clip to caption just that clip, or nothing to caption everything.');
    const generate = el('button', 'btn btn-accent', 'Generate subtitles');
    generate.type = 'button';
    generate.addEventListener('click', async () => {
      generate.disabled = true;
      status.textContent = 'Preparing audio…';
      try {
        const result = await auto.autoSubtitles({
          style: captionStyleId,
          language: captionLanguage,
          onProgress: (message, progress) => {
            status.textContent = `${message} ${Math.round((progress || 0) * 100)}%`;
          },
        });
        status.textContent = `${result.count} captions on the Captions track · ${result.engine}`;
        app.toast(`${result.count} captions added`, 'success');
      } catch (err) {
        status.textContent = err.message;
        app.toast(err.message, 'error');
      } finally {
        generate.disabled = false;
      }
    });
    subtitles.inner.appendChild(generate);
    subtitles.inner.appendChild(status);
    subtitles.inner.appendChild(
      el(
        'p',
        'panel-hint',
        'Fully offline — the audio never leaves this PC. Captions are written by the speech model that ships with the app, so there is nothing extra to install.',
      ),
    );
    wrap.appendChild(subtitles.details);

    const captionsSection = section('Edit captions', true);
    captionsSection.inner.appendChild(
      el('p', 'panel-hint', 'Type over a line to fix a word — it saves as you go. Click a time to jump there.'),
    );
    const captionList = el('div', 'caption-list');
    const rows = auto.captions();
    if (!rows.length) {
      captionList.appendChild(el('p', 'panel-hint', 'No captions yet — generate them above, or add one manually.'));
    }
    for (const clip of rows) {
      const row = el('div', 'caption-row');
      const jump = el('button', 'caption-time', timeLabel(clip.start));
      jump.type = 'button';
      jump.title = 'Jump to this caption';
      jump.addEventListener('click', () => store.seek(clip.start));
      const area = document.createElement('textarea');
      area.className = 'caption-text';
      area.rows = 2;
      area.value = clip.text.content;
      let before = null;
      area.addEventListener('focus', () => {
        before = store.gestureStart();
      });
      area.addEventListener('input', () =>
        store.live(() => {
          clip.text.content = area.value;
          clip.name = area.value.slice(0, 28) || 'Caption';
        }),
      );
      area.addEventListener('blur', () => {
        if (before) store.gestureEnd('caption text', before);
        before = null;
      });
      const remove = el('button', 'caption-remove', '\u00d7');
      remove.type = 'button';
      remove.title = 'Delete this caption';
      remove.addEventListener('click', () => auto.removeCaption(clip.id));
      row.append(jump, area, remove);
      captionList.appendChild(row);
    }
    captionsSection.inner.appendChild(captionList);
    captionsSection.inner.appendChild(
      actionRow('Add caption', 'Insert an editable caption at the playhead', () => {
        auto.addCaptionAt(store.state.playhead, captionStyleId);
        app.toast('Caption added', 'success');
      }),
    );
    wrap.appendChild(captionsSection.details);

    const enhance = section('Auto enhance', true);
    enhance.inner.appendChild(
      actionRow('Auto colour', 'Balance exposure, contrast and warmth from this frame', () => {
        const suggestion = auto.autoColor();
        app.toast(`Auto colour · exposure ${suggestion.exposure}× · contrast ${suggestion.contrast}×`, 'success');
      }),
    );
    enhance.inner.appendChild(
      actionRow('Auto loudness', 'Normalise the selected clip\u2019s volume', () => {
        const gain = auto.autoLoudness();
        app.toast(`Volume set to ${Math.round(gain * 100)}%`, 'success');
      }),
    );
    wrap.appendChild(enhance.details);

    const markers = section('Auto markers', true);
    markers.inner.appendChild(
      actionRow('Find silences', 'Mark quiet gaps so you can find them (no cuts)', () => {
        const count = auto.findSilences();
        app.toast(count ? `${count} silence markers` : 'No long silences found', count ? 'success' : 'info');
      }),
    );
    markers.inner.appendChild(
      actionRow('Beat markers', 'Mark rhythmic hits from the audio', () => {
        const count = auto.beats();
        app.toast(count ? `${count} beat markers` : 'No clear beats found', count ? 'success' : 'info');
      }),
    );
    markers.inner.appendChild(
      actionRow('Scene changes', 'Scan the clip for visual cuts', async () => {
        const count = await auto.scenes();
        app.toast(count ? `${count} scene markers` : 'No scene changes found', count ? 'success' : 'info');
      }),
    );
    markers.inner.appendChild(
      actionRow('Clear markers', 'Remove every marker from the timeline', () => {
        const count = auto.clearMarkers();
        app.toast(count ? `Removed ${count} markers` : 'No markers to clear', 'info');
      }),
    );
    wrap.appendChild(markers.details);

    const textAuto = section('Text automation', false);
    textAuto.inner.appendChild(
      actionRow('Animate this text', 'Keyframe a fade and rise on the selected text', () => {
        auto.animateText();
        app.toast('Text animated', 'success');
      }),
    );
    wrap.appendChild(textAuto.details);

    return wrap;
  }

  function renderTextPanel() {
    const wrap = el('div', 'panel');
    wrap.appendChild(el('h2', null, 'Text & Titles'));
    wrap.appendChild(el('p', 'panel-hint', 'Adds a title at the playhead on the text track.'));
    const list = el('div', 'preset-list');
    for (const preset of TEXT_PRESETS) {
      const card = el('button', 'preset-card');
      card.type = 'button';
      card.innerHTML = `<span class="preset-sample" style="font-family:${
        (FONTS.find((font) => font.id === preset.font) || FONTS[0]).stack
      }">${preset.text.split('\n')[0]}</span><span class="preset-name">${preset.name}</span>`;
      card.addEventListener('click', () => app.addText(preset));
      list.appendChild(card);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function selectionHint(wrap) {
    const selected = store.selected();
    if (!selected) {
      wrap.appendChild(el('p', 'panel-hint', 'Select a clip in the timeline to apply.'));
    }
    return selected;
  }

  function renderEffectsPanel() {
    const wrap = el('div', 'panel');
    wrap.appendChild(el('h2', null, 'Effects'));
    const entries = [];
    for (const effect of EFFECTS) {
      const card = el('button', `fx-card${effect.id === 'none' ? ' is-plain' : ''}`);
      card.type = 'button';
      card.innerHTML = `<span class="fx-preview fx-${effect.id}"></span><span class="fx-name">${effect.label}</span>`;
      card.addEventListener('click', () => {
        const selected = store.selected();
        if (!selected) return app.toast('Select a clip first');
        store.mutate('apply effect', () => {
          selected.clip.effect = { id: effect.id, amount: selected.clip.effect?.amount ?? 0.6 };
        });
      });
      entries.push(card);
    }
    const grid = el('div', 'fx-grid');
    entries.forEach((card) => grid.appendChild(card));
    wrap.appendChild(grid);
    selectionHint(wrap);
    return wrap;
  }

  function renderTransitionsPanel() {
    const wrap = el('div', 'panel');
    wrap.appendChild(el('h2', null, 'Transitions'));
    const grid = el('div', 'fx-grid fx-grid-compact');
    for (const transition of TRANSITIONS) {
      if (transition.id === 'none') continue;
      const card = el('button', 'fx-card');
      card.type = 'button';
      card.innerHTML = `<span class="fx-preview tr-${transition.id}"></span><span class="fx-name">${transition.label}</span>`;
      card.addEventListener('click', () => {
        const selected = store.selected();
        if (!selected) return app.toast('Select a clip first');
        store.mutate('apply transition', () => {
          selected.clip.transition = { id: transition.id, duration: selected.clip.transition?.duration || 0.6 };
        });
      });
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    wrap.appendChild(el('p', 'panel-hint', 'Transitions blend a clip with the clip before it on the same track.'));
    return wrap;
  }

  function renderFiltersPanel() {
    const wrap = el('div', 'panel');
    wrap.appendChild(el('h2', null, 'Filters'));
    const grid = el('div', 'filter-grid');
    for (const filter of FILTERS) {
      const card = el('button', 'filter-card');
      card.type = 'button';
      const preview = el('span', 'filter-preview');
      preview.style.background = 'linear-gradient(135deg,#ff8a60,#7c5cff 55%,#2ad6c4)';
      preview.style.filter = filter.css || 'none';
      card.appendChild(preview);
      card.appendChild(el('span', 'filter-name', filter.label));
      card.addEventListener('click', () => {
        const selected = store.selected();
        if (!selected) return app.toast('Select a clip first');
        store.mutate('apply filter', () => {
          selected.clip.filter = filter.id;
        });
      });
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function renderProjectsPanel() {
    const wrap = el('div', 'panel');
    const head = el('div', 'panel-head');
    head.appendChild(el('h2', null, 'Projects'));
    head.appendChild(iconButton('New', 'Start an empty project', () => app.newProject()));
    wrap.appendChild(head);
    const list = el('div', 'project-list');
    list.appendChild(el('div', 'project-loading', 'Loading saved projects…'));
    wrap.appendChild(list);
    app.listProjects().then((projects) => {
      list.replaceChildren();
      if (!projects.length) {
        list.appendChild(el('p', 'panel-hint', 'Nothing saved yet. Press Save in the top bar.'));
        return;
      }
      for (const project of projects) {
        const row = el('div', 'project-row');
        const info = el('div', 'project-info');
        info.appendChild(el('span', 'project-name', project.name));
        info.appendChild(
          el('span', 'project-meta', `${bytesLabel(project.bytes)} · ${new Date(project.modified * 1000).toLocaleString()}`),
        );
        row.appendChild(info);
        const actions = el('div', 'project-actions');
        actions.appendChild(iconButton('Open', 'Load project', () => app.loadProject(project.name)));
        actions.appendChild(iconButton('Delete', 'Delete project', () => app.deleteProject(project.name), 'btn-danger'));
        row.appendChild(actions);
        list.appendChild(row);
      }
    });
    return wrap;
  }

  // ---------------------------------------------------------------- inspector

  let textFocusId = null;

  function renderInspector() {
    const selected = store.selected();
    inspectorEl.replaceChildren(selected ? clipInspector(selected) : projectInspector());
    if (!textFocusId) return;
    const pending = textFocusId;
    textFocusId = null;
    if (!selected || selected.clip.id !== pending) return;
    requestAnimationFrame(() => {
      const area = inspectorEl.querySelector('.text-area');
      if (!area) return;
      const panel = area.closest('details');
      if (panel) panel.open = true;
      area.focus();
      area.select();
    });
  }

  /** Put the caret in a text clip's content field, ready to type over it. */
  function focusText(clipId) {
    textFocusId = clipId;
    renderInspector();
  }

  function projectInspector() {
    const wrap = el('div', 'inspector-inner');
    const project = store.state.project;
    wrap.appendChild(el('h2', 'inspector-title', 'Project'));

    const nameInput = document.createElement('input');
    nameInput.className = 'text-input';
    nameInput.value = project.name;
    nameInput.addEventListener('input', () => store.live((draft) => { draft.name = nameInput.value; }));
    const nameField = el('div', 'field');
    nameField.appendChild(el('span', 'field-label', 'Name'));
    nameField.appendChild(nameInput);
    wrap.appendChild(nameField);

    wrap.appendChild(
      selectField(
        'Aspect',
        Object.entries(ASPECTS).map(([id, value]) => ({ id, label: value.label })),
        project.aspect,
        (value) => {
          store.mutate('change aspect', (draft) => {
            draft.aspect = value;
            draft.width = ASPECTS[value].width;
            draft.height = ASPECTS[value].height;
          });
        },
      ),
    );

    wrap.appendChild(
      selectField(
        'Frame rate',
        [24, 25, 30, 50, 60].map((fps) => ({ id: String(fps), label: `${fps} fps` })),
        String(project.fps),
        (value) => store.mutate('change fps', (draft) => { draft.fps = Number(value); }),
      ),
    );

    const bg = section('Canvas');
    bg.inner.appendChild(
      selectField(
        'Background',
        [
          { id: 'color', label: 'Solid colour' },
          { id: 'blur', label: 'Blurred video' },
        ],
        project.background.type,
        (value) => store.mutate('change background', (draft) => { draft.background.type = value; }),
      ),
    );
    bg.inner.appendChild(colorField('Colour', project.background.color, (value) => store.live((draft) => { draft.background.color = value; })));
    bg.inner.appendChild(
      gestureField({
        label: 'Blur',
        value: project.background.blur,
        min: 4,
        max: 80,
        step: 1,
        format: (value) => `${Math.round(value)}px`,
        onInput: (value) => store.live((draft) => { draft.background.blur = value; }),
      }),
    );
    wrap.appendChild(bg.details);

    const stats = section('Sequence');
    const duration = sequenceDuration(project);
    const clipCount = project.tracks.reduce((sum, track) => sum + track.clips.length, 0);
    stats.inner.innerHTML = `
      <div class="stat-row"><span>Duration</span><strong>${formatTimecode(duration, project.fps)}</strong></div>
      <div class="stat-row"><span>Clips</span><strong>${clipCount}</strong></div>
      <div class="stat-row"><span>Tracks</span><strong>${project.tracks.length}</strong></div>
      <div class="stat-row"><span>Resolution</span><strong>${project.width}×${project.height}</strong></div>`;
    wrap.appendChild(stats.details);

    if (store.state.ffmpeg.found) {
      const tools = section('Export tooling', false);
      tools.inner.innerHTML = `<div class="stat-row"><span>MP4 encoder</span><strong class="ok">ready</strong></div>
        <p class="panel-hint">H.264 export is included, so nothing extra needs installing.</p>`;
      wrap.appendChild(tools.details);
    } else {
      const tools = section('Export tooling', false);
      tools.inner.innerHTML = `<p class="panel-hint">Export renders a WebM in-app. The MP4 encoder is missing from this install — reinstall Tacot Edit to restore it.</p>`;
      wrap.appendChild(tools.details);
    }

    return wrap;
  }

  function clipInspector({ clip, track }) {
    const wrap = el('div', 'inspector-inner');
    const multi = store.selectedIds();
    if (multi.length > 1) {
      const banner = el('div', 'multi-banner');
      banner.innerHTML = `<strong>${multi.length} clips selected</strong><span>Editing “${clip.name}” · drag any clip in the timeline to move them together</span>`;
      wrap.appendChild(banner);
    }
    const head = el('div', 'inspector-head');
    head.appendChild(el('span', `kind-pill kind-${clip.kind}`, clip.kind.toUpperCase()));
    const nameInput = document.createElement('input');
    nameInput.className = 'text-input inspector-name';
    nameInput.value = clip.name || 'Clip';
    nameInput.addEventListener('input', () => store.live(() => { clip.name = nameInput.value; }));
    head.appendChild(nameInput);
    wrap.appendChild(head);

    const media = store.state.project.media.find((item) => item.key === clip.mediaKey);
    if (media) {
      wrap.appendChild(
        el(
          'p',
          'inspector-sub',
          `${media.name} · ${media.width || '?' }×${media.height || '?'} · ${displayDuration(media.duration || 0)}`,
        ),
      );
    }
    wrap.appendChild(
      el('p', 'inspector-sub', `${formatTimecode(clip.start, store.state.project.fps)} → ${formatTimecode(clip.start + clipDuration(clip), store.state.project.fps)}`),
    );

    // A title's words are the first thing you want, so that section leads the inspector.
    if (clip.kind === 'text') wrap.appendChild(textSection(clip));

    const timing = section('Timing');
    timing.inner.appendChild(
      gestureField({
        label: 'Start',
        value: clip.start,
        min: 0,
        max: Math.max(30, sequenceDuration(store.state.project) + 10),
        step: 0.01,
        format: (value) => `${value.toFixed(2)}s`,
        onInput: (value) => store.live(() => { clip.start = Number(value.toFixed(2)); }),
      }),
    );
    if (clip.kind !== 'text') {
      const sourceLimit = media && media.kind !== 'image' && media.duration > 0 ? media.duration : 3600;
      timing.inner.appendChild(
        gestureField({
          label: 'Speed',
          value: clip.speed,
          min: 0.1,
          max: 4,
          step: 0.01,
          format: (value) => `${value.toFixed(2)}×`,
          onInput: (value) => store.live(() => { clip.speed = value; }),
        }),
      );
      const speeds = el('div', 'speed-chips');
      for (const rate of [0.25, 0.5, 1, 1.5, 2, 4]) {
        const chip = el('button', `chip-btn${Math.abs(clip.speed - rate) < 0.01 ? ' is-on' : ''}`, `${rate}×`);
        chip.type = 'button';
        chip.addEventListener('click', () => store.mutate('clip speed', () => { clip.speed = rate; }));
        speeds.appendChild(chip);
      }
      timing.inner.appendChild(speeds);
      timing.inner.appendChild(
        gestureField({
          label: 'In point',
          value: clip.in,
          min: 0,
          max: Math.max(1, sourceLimit - 0.1),
          step: 0.01,
          format: (value) => `${value.toFixed(2)}s`,
          onInput: (value) => store.live(() => { clip.in = Math.min(value, clip.out - 0.1); }),
        }),
      );
      timing.inner.appendChild(
        gestureField({
          label: 'Out point',
          value: clip.out,
          min: clip.in + 0.1,
          max: Math.max(clip.in + 0.2, sourceLimit),
          step: 0.01,
          format: (value) => `${value.toFixed(2)}s`,
          onInput: (value) => store.live(() => { clip.out = Math.max(value, clip.in + 0.1); }),
        }),
      );
    } else {
      timing.inner.appendChild(
        gestureField({
          label: 'Duration',
          value: clipDuration(clip),
          min: 0.2,
          max: 30,
          step: 0.1,
          format: (value) => `${value.toFixed(1)}s`,
          onInput: (value) => store.live(() => { clip.out = clip.in + value; }),
        }),
      );
    }
    const trimRow = el('div', 'speed-chips');
    const playheadNow = store.state.playhead;
    const insideClip =
      playheadNow > clip.start + 0.05 && playheadNow < clip.start + clipDuration(clip) - 0.05;
    const trimTo = (edge) => {
      store.mutate('trim clip', () => {
        trimClip(clip, edge, store.state.playhead, 0.1);
      });
    };
    const addTrim = (label, title, run, disabled = false) => {
      const button = el('button', `chip-btn${disabled ? ' is-off' : ''}`, label);
      button.type = 'button';
      button.title = title;
      button.disabled = disabled;
      button.addEventListener('click', run);
      trimRow.appendChild(button);
    };
    addTrim('⇤ start', 'Trim the clip start to the playhead ( [ )', () => trimTo('start'), !insideClip);
    addTrim('end ⇥', 'Trim the clip end to the playhead ( ] )', () => trimTo('end'), !insideClip);
    const rate = clip.speed > 0 ? clip.speed : 1;
    addTrim('−1s', 'Cut one second off the end', () =>
      store.mutate('shorten clip', () => {
        clip.out = Math.max(clip.in + 0.1, clip.out - (clip.kind === 'text' ? 1 : rate));
      }),
    );
    addTrim('+1s', 'Add one second to the end', () =>
      store.mutate('lengthen clip', () => {
        clip.out = clip.in + Math.max(0.1, clipDuration(clip) + 1) * (clip.kind === 'text' ? 1 : rate);
      }),
    );
    timing.inner.appendChild(trimRow);
    wrap.appendChild(timing.details);

    const transform = section('Transform');
    transform.inner.appendChild(
      gestureField({
        label: 'Position X',
        value: clip.transform.x * 100,
        min: -100,
        max: 100,
        step: 0.5,
        format: (value) => `${value.toFixed(1)}%`,
        onInput: (value) => store.live(() => { clip.transform.x = value / 100; }),
      }),
    );
    transform.inner.appendChild(
      gestureField({
        label: 'Position Y',
        value: clip.transform.y * 100,
        min: -100,
        max: 100,
        step: 0.5,
        format: (value) => `${value.toFixed(1)}%`,
        onInput: (value) => store.live(() => { clip.transform.y = value / 100; }),
      }),
    );
    transform.inner.appendChild(
      gestureField({
        label: 'Scale',
        value: clip.transform.scale,
        min: 0.1,
        max: 3,
        step: 0.01,
        format: (value) => `${Math.round(value * 100)}%`,
        onInput: (value) => store.live(() => { clip.transform.scale = value; }),
      }),
    );
    transform.inner.appendChild(
      gestureField({
        label: 'Rotation',
        value: clip.transform.rotation,
        min: -180,
        max: 180,
        step: 1,
        format: (value) => `${Math.round(value)}°`,
        onInput: (value) => store.live(() => { clip.transform.rotation = value; }),
      }),
    );
    transform.inner.appendChild(
      gestureField({
        label: 'Opacity',
        value: clip.transform.opacity * 100,
        min: 0,
        max: 100,
        step: 1,
        format: (value) => `${Math.round(value)}%`,
        onInput: (value) => store.live(() => { clip.transform.opacity = value / 100; }),
      }),
    );
    const flipRow = el('div', 'row-buttons');
    flipRow.appendChild(
      iconButton('Flip H', 'Mirror horizontally', () => store.mutate('flip', () => { clip.transform.flipH = !clip.transform.flipH; })),
    );
    flipRow.appendChild(
      iconButton('Flip V', 'Mirror vertically', () => store.mutate('flip', () => { clip.transform.flipV = !clip.transform.flipV; })),
    );
    flipRow.appendChild(
      iconButton('Reset', 'Reset transform', () =>
        store.mutate('reset transform', () => {
          clip.transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false };
        }),
      ),
    );
    transform.inner.appendChild(flipRow);
    wrap.appendChild(transform.details);

    if (clip.kind !== 'text') {
      const crop = section('Crop', false);
      for (const edge of ['top', 'right', 'bottom', 'left']) {
        crop.inner.appendChild(
          gestureField({
            label: edge[0].toUpperCase() + edge.slice(1),
            value: (clip.crop[edge] || 0) * 100,
            min: 0,
            max: 45,
            step: 1,
            format: (value) => `${Math.round(value)}%`,
            onInput: (value) => store.live(() => { clip.crop[edge] = value / 100; }),
          }),
        );
      }
      wrap.appendChild(crop.details);
    }

    const color = section('Colour');
    for (const [key, label, min, max, step] of [
      ['exposure', 'Exposure', 0.2, 2, 0.01],
      ['contrast', 'Contrast', 0.4, 2, 0.01],
      ['saturation', 'Saturation', 0, 2.5, 0.01],
      ['temperature', 'Temperature', -1, 1, 0.01],
      ['tint', 'Tint', -1, 1, 0.01],
      ['sharpen', 'Sharpen', 0, 1, 0.01],
      ['vignette', 'Vignette', 0, 1, 0.01],
    ]) {
      color.inner.appendChild(
        gestureField({
          label,
          value: clip.adjust[key],
          min,
          max,
          step,
          format: (value) => `${Math.round(value * 100)}%`,
          onInput: (value) => store.live(() => { clip.adjust[key] = value; }),
        }),
      );
    }
    color.inner.appendChild(
      iconButton('Reset colour', 'Reset all colour adjustments', () =>
        store.mutate('reset colour', () => { clip.adjust = defaultAdjust(); }),
      ),
    );
    wrap.appendChild(color.details);

    if (clip.kind !== 'text') {
      const audio = section('Audio', clip.kind === 'audio');
      audio.inner.appendChild(
        gestureField({
          label: 'Volume',
          value: clip.volume * 100,
          min: 0,
          max: 200,
          step: 1,
          format: (value) => `${Math.round(value)}%`,
          onInput: (value) => store.live(() => { clip.volume = value / 100; }),
        }),
      );
      audio.inner.appendChild(
        gestureField({
          label: 'Fade in',
          value: clip.fadeIn,
          min: 0,
          max: 5,
          step: 0.05,
          format: (value) => `${value.toFixed(2)}s`,
          onInput: (value) => store.live(() => { clip.fadeIn = value; }),
        }),
      );
      audio.inner.appendChild(
        gestureField({
          label: 'Fade out',
          value: clip.fadeOut,
          min: 0,
          max: 5,
          step: 0.05,
          format: (value) => `${value.toFixed(2)}s`,
          onInput: (value) => store.live(() => { clip.fadeOut = value; }),
        }),
      );
      audio.inner.appendChild(toggleField('Mute clip', clip.muted, (value) => store.mutate('mute', () => { clip.muted = value; })));
      wrap.appendChild(audio.details);
    }

    const transition = section('Transition & Effect', false);
    transition.inner.appendChild(
      selectField('Transition', TRANSITIONS, clip.transition.id, (value) =>
        store.mutate('transition', () => { clip.transition.id = value; }),
      ),
    );
    transition.inner.appendChild(
      gestureField({
        label: 'Transition length',
        value: clip.transition.duration,
        min: 0.1,
        max: 2.5,
        step: 0.05,
        format: (value) => `${value.toFixed(2)}s`,
        onInput: (value) => store.live(() => { clip.transition.duration = value; }),
      }),
    );
    transition.inner.appendChild(
      selectField('Effect', EFFECTS, clip.effect.id, (value) =>
        store.mutate('effect', () => { clip.effect.id = value; }),
      ),
    );
    transition.inner.appendChild(
      gestureField({
        label: 'Effect amount',
        value: clip.effect.amount,
        min: 0,
        max: 1,
        step: 0.01,
        format: (value) => `${Math.round(value * 100)}%`,
        onInput: (value) => store.live(() => { clip.effect.amount = value; }),
      }),
    );
    wrap.appendChild(transition.details);

    wrap.appendChild(keyframeSection(clip));

    const actions = el('div', 'row-buttons inspector-actions');
    actions.appendChild(iconButton('Split', 'Split at playhead (Ctrl+B)', () => app.splitAtPlayhead()));
    actions.appendChild(iconButton('Duplicate', 'Duplicate clip (Ctrl+D)', () => app.duplicateSelected()));
    actions.appendChild(iconButton('Delete', 'Delete clip (Del)', () => app.deleteSelected(), 'btn-danger'));
    wrap.appendChild(actions);

    return wrap;
  }

  const KEY_PROPERTIES = [
    { id: 'opacity', label: 'Opacity', fallback: (clip) => clip.transform.opacity, min: 0, max: 1, step: 0.01 },
    { id: 'scale', label: 'Scale', fallback: (clip) => clip.transform.scale, min: 0.1, max: 3, step: 0.01 },
    { id: 'x', label: 'Position X', fallback: (clip) => clip.transform.x, min: -1, max: 1, step: 0.01 },
    { id: 'y', label: 'Position Y', fallback: (clip) => clip.transform.y, min: -1, max: 1, step: 0.01 },
    { id: 'rotation', label: 'Rotation', fallback: (clip) => clip.transform.rotation, min: -180, max: 180, step: 1 },
    { id: 'volume', label: 'Volume', fallback: (clip) => clip.volume, min: 0, max: 2, step: 0.01 },
    { id: 'exposure', label: 'Exposure', fallback: (clip) => clip.adjust.exposure, min: 0.2, max: 2, step: 0.01 },
  ];

  function keyframeSection(clip) {
    const { details, inner } = section('Keyframes', false);
    inner.appendChild(
      toggleField('Auto-keyframe', store.state.autoKey, (value) => {
        store.state.autoKey = value;
        app.toast(value ? 'Auto-keyframe on: changing a value records a keyframe' : 'Auto-keyframe off', 'info');
      }),
    );
    inner.appendChild(el('p', 'panel-hint', 'With auto-keyframe on, transform and colour sliders record a keyframe at the playhead.'));
    const local = Math.max(0, Math.min(store.state.playhead - clip.start, clipDuration(clip)));
    const row = el('div', 'keyframe-add');
    const select = document.createElement('select');
    for (const property of KEY_PROPERTIES) {
      const option = document.createElement('option');
      option.value = property.id;
      option.textContent = property.label;
      select.appendChild(option);
    }
    row.appendChild(select);
    row.appendChild(
      iconButton('◆ Add at playhead', 'Record a keyframe', () => {
        const property = KEY_PROPERTIES.find((item) => item.id === select.value);
        const current = keyedValue(clip, property.id, property.fallback(clip), store.state.playhead);
        store.mutate('add keyframe', () => {
          upsertKeyframe(clip, property.id, local, Number(current.toFixed(3)));
        });
      }, 'btn-accent'),
    );
    inner.appendChild(row);

    const entries = Object.entries(clip.keyframes || {});
    if (!entries.length) {
      inner.appendChild(el('p', 'panel-hint', 'No keyframes yet. Move the playhead, then record a value.'));
      return details;
    }
    inner.appendChild(
      iconButton('Clear all keyframes', 'Remove every keyframe on this clip', () => {
        store.mutate('clear keyframes', () => { clip.keyframes = {}; });
      }, 'btn-ghost'),
    );
    for (const [property, frames] of entries) {
      const label = KEY_PROPERTIES.find((item) => item.id === property)?.label || property;
      const list = el('div', 'keyframe-list');
      list.appendChild(el('div', 'keyframe-title', label));
      for (const frame of frames) {
        const item = el('div', 'keyframe-row');
        item.appendChild(el('span', 'keyframe-time', formatTimecode(clip.start + frame.t, store.state.project.fps)));
        item.appendChild(el('span', 'keyframe-value', frame.v.toFixed(2)));
        const ease = document.createElement('select');
        for (const option of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold']) {
          const node = document.createElement('option');
          node.value = option;
          node.textContent = option;
          if (frame.ease === option) node.selected = true;
          ease.appendChild(node);
        }
        ease.addEventListener('change', () => {
          store.mutate('keyframe ease', () => { frame.ease = ease.value; });
        });
        item.appendChild(ease);
        const remove = iconButton('×', 'Delete keyframe', () => {
          store.mutate('delete keyframe', () => removeKeyframe(clip, property, frame.t));
        }, 'btn-icon');
        item.appendChild(remove);
        list.appendChild(item);
      }
      inner.appendChild(list);
    }
    return details;
  }

  function textSection(clip) {
    const { details, inner } = section('Text', true);
    const area = document.createElement('textarea');
    area.className = 'text-area';
    area.rows = 3;
    area.value = clip.text.content;
    let before = null;
    area.addEventListener('focus', () => { before = store.gestureStart(); });
    area.addEventListener('input', () => store.live(() => { clip.text.content = area.value; }));
    area.addEventListener('blur', () => {
      if (before) store.gestureEnd('edit text', before);
      before = null;
    });
    inner.appendChild(area);

    inner.appendChild(
      selectField('Font', FONTS, clip.text.font, (value) => store.mutate('font', () => { clip.text.font = value; })),
    );
    inner.appendChild(
      gestureField({
        label: 'Size',
        value: clip.text.size,
        min: 16,
        max: 240,
        step: 1,
        format: (value) => `${Math.round(value)}px`,
        onInput: (value) => store.live(() => { clip.text.size = value; }),
      }),
    );
    inner.appendChild(
      gestureField({
        label: 'Weight',
        value: clip.text.weight,
        min: 300,
        max: 900,
        step: 100,
        format: (value) => String(Math.round(value)),
        onInput: (value) => store.live(() => { clip.text.weight = value; }),
      }),
    );
    inner.appendChild(
      gestureField({
        label: 'Letter spacing',
        value: clip.text.letterSpacing,
        min: -5,
        max: 40,
        step: 0.5,
        format: (value) => `${value}px`,
        onInput: (value) => store.live(() => { clip.text.letterSpacing = value; }),
      }),
    );
    inner.appendChild(
      gestureField({
        label: 'Line height',
        value: clip.text.lineHeight,
        min: 0.8,
        max: 2.2,
        step: 0.05,
        format: (value) => value.toFixed(2),
        onInput: (value) => store.live(() => { clip.text.lineHeight = value; }),
      }),
    );
    inner.appendChild(
      gestureField({
        label: 'Max width',
        value: clip.text.maxWidth * 100,
        min: 20,
        max: 100,
        step: 1,
        format: (value) => `${Math.round(value)}%`,
        onInput: (value) => store.live(() => { clip.text.maxWidth = value / 100; }),
      }),
    );
    inner.appendChild(colorField('Fill', clip.text.color, (value) => store.live(() => { clip.text.color = value; })));
    inner.appendChild(
      selectField(
        'Align',
        [
          { id: 'left', label: 'Left' },
          { id: 'center', label: 'Center' },
          { id: 'right', label: 'Right' },
        ],
        clip.text.align,
        (value) => store.mutate('align', () => { clip.text.align = value; }),
      ),
    );
    inner.appendChild(
      selectField('Animation', TEXT_ANIMATIONS, clip.text.animation, (value) =>
        store.mutate('text animation', () => { clip.text.animation = value; }),
      ),
    );
    inner.appendChild(
      gestureField({
        label: 'Outline',
        value: clip.text.strokeWidth,
        min: 0,
        max: 16,
        step: 0.5,
        format: (value) => `${value}px`,
        onInput: (value) => store.live(() => { clip.text.strokeWidth = value; }),
      }),
    );
    inner.appendChild(colorField('Outline colour', clip.text.strokeColor, (value) => store.live(() => { clip.text.strokeColor = value; })));
    inner.appendChild(
      gestureField({
        label: 'Shadow',
        value: clip.text.shadow * 100,
        min: 0,
        max: 100,
        step: 1,
        format: (value) => `${Math.round(value)}%`,
        onInput: (value) => store.live(() => { clip.text.shadow = value / 100; }),
      }),
    );
    inner.appendChild(
      selectField(
        'Backing',
        [
          { id: 'none', label: 'None' },
          { id: 'box', label: 'Box' },
        ],
        clip.text.background,
        (value) => store.mutate('text backing', () => { clip.text.background = value; }),
      ),
    );
    inner.appendChild(colorField('Backing colour', clip.text.bgColor, (value) => store.live(() => { clip.text.bgColor = value; })));
    return details;
  }

  function render() {
    renderRail();
    renderBody();
    renderInspector();
  }

  store.subscribe((state, reason) => {
    if (reason === 'playhead') return;
    if (reason === 'live') return;
    render();
  });

  function setTab(id) {
    if (!TABS.some((tab) => tab.id === id)) return;
    activeTab = id;
    renderRail();
    renderBody();
  }

  return { render, renderInspector, setTab, focusText };
}
