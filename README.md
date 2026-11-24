# Tacot Edit

A multi-track timeline video editor for Windows. Free, offline, no account, no watermark.

Built with Tauri v2: a Rust shell around a plain HTML/CSS/JS editor, so the whole interface is
web technology and the native layer is small.

## Layout

```
ui/            the editor: index.html, app.css, js/ (model, engine, timeline, panels, export)
src-tauri/     the Rust shell: commands for media import, project files, ffmpeg export
tools/         small node scripts: icon generation, previews, model tests
package.json   scripts: dev, build, installer, icons, test
```

## Running it

```bash
npm install                      # only needs @tauri-apps/cli
npm run dev                      # opens the editor in a Tauri window
npm test                         # runs the model tests with node --test
npm run installer                # builds the Windows installer
```

The Rust toolchain and Node 20+ are required. `npm run dev` uses the Tauri CLI from
`node_modules`, so run `npm install` first.

## The editor

* Multi-track timeline with clips, trims, fades, speed and transitions
* Inspector for transform, crop, colour, text and audio
* Frame-accurate preview with scrubbing and filmstrips
* Auto-captions and an automated edit pass (`js/auto.js`, `js/auto-model.js`)
* Export to WebM through the browser encoder, and MP4 when ffmpeg is available on the machine

## Browser build

The UI already runs in a plain browser — `js/tauri.js` degrades to a no-op when the Tauri global is
absent — but importing media, saving projects and exporting are Tauri commands. `CODEX-PROMPT.md`
is the brief for making those work in the browser with 7-day project storage.

## Licence

See `src-tauri/LICENSE.txt`.
