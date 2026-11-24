# Brief: a browser build of Tacot Edit

## Goal

`ui/` should open in a normal browser and be usable without installing anything: import media,
edit on the timeline, preview, and export a video file. No accounts, no sign-in, no uploads to a
server.

Today the UI loads in a browser but the platform layer (`ui/js/platform.js`) calls Tauri commands
for everything that touches the disk, so importing, saving and exporting fail.

## What to build

1. **A browser platform layer.** Add `ui/web/platform-web.js` exporting the same surface as
   `ui/js/platform.js` (`importFile`, `importPath`, `describeMedia`, `thumbnailFor`, `saveProject`,
   `loadProject`, `listProjects`, `deleteProject`, `autosave`, `readAutosave`, `checkFfmpeg`,
   `exportDir`, `fileUrl`, `command`, `openMediaDialog`, `kindOf`, `mimeFor`, `ACCEPTED`).
   Wire it in through an import map in `ui/index.html` so the editor modules stay untouched:

   ```html
   <script type="importmap">
   { "imports": { "./js/platform.js": "./web/platform-web.js" } }
   </script>
   ```

   If the import map proves unreliable, the fallback is a `hasTauri` branch inside
   `ui/js/platform.js` — but keep the Tauri path byte-for-byte behaviourally identical.

2. **Media in the browser.** `importFile(file)` stores the `File` in IndexedDB and returns
   `{ id, path, name, kind }` where `path` is an object URL. `describeMedia` decodes duration,
   dimensions, filmstrip frames and waveform peaks with `<video>`, `<canvas>` and
   `AudioContext.decodeAudioData` — the same logic `platform.js` already uses for its fallbacks.

3. **Projects with 7-day storage.** Projects and their media live in IndexedDB
   (database `tacot-edit-web`, stores `projects`, `media`, `meta`). Every write stamps
   `expiresAt = now + 7 days` and a `lastOpenedAt`. On boot, delete everything whose `expiresAt`
   has passed and show a small badge: “Saves kept for 7 days”. Touching a project refreshes it.

4. **Optional Google Drive.** A “Keep forever with Drive” button next to the badge starts Google
   Identity Services with the `drive.file` scope and saves project JSON plus media into the user’s
   `appDataFolder`. While a Drive connection is active, skip expiry entirely. The client ID comes
   from `window.TACOT_DRIVE_CLIENT_ID`; when it is missing the button explains that Drive is not
   configured instead of failing silently. Never store tokens in the project files, never send them
   anywhere but Drive.

5. **Export without ffmpeg.** Record the canvas plus the audio graph with `MediaRecorder` to WebM
   (VP9/Opus when supported), then download with a `<a download>` element. Keep the existing ffmpeg
   path working when it is available. MP4 export in the browser is out of scope unless it can be
   done with `VideoEncoder`/`mp4-muxer` without a bundler.

## Constraints

* No accounts, no backend, no telemetry. Media never leaves the browser unless Drive is connected.
* Do not change the Tauri build: `npm run dev` and `npm run build` must keep working.
* Everything must run from static files — no bundler, no build step, ES modules only.
* Keep the existing visual design; this is a platform port, not a redesign.

## Acceptance

* Open `ui/index.html` over `http://` (not `file://`, because of IndexedDB and module CORS).
* Drag three files in (a video, an image, an audio file): they appear on the timeline with
  filmstrips and waveforms.
* Reload the page: the project is still there, with its media.
* Export produces a playable WebM.
* With the storage clock faked past 7 days, old projects are gone and new ones remain.
* `npm test` still passes.
