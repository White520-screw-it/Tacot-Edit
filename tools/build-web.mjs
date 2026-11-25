import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist/editor');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'ui/js'), resolve(output, 'js'), { recursive: true });
await mkdir(resolve(output, 'web'), { recursive: true });
await cp(resolve(root, 'ui/web/platform-web.js'), resolve(output, 'web/platform-web.js'));
await cp(resolve(root, 'ui/app.css'), resolve(output, 'app.css'));

let html = await readFile(resolve(root, 'ui/index.html'), 'utf8');
html = html.replace('<span id="saveState" class="save-state saved">All changes saved</span>', '<div class="storage-row">\n            <span id="saveState" class="save-state saved">All changes saved</span>\n            <span id="storageBadge" class="storage-badge" aria-live="polite">Saves kept for 7 days</span>\n            <button id="driveButton" class="btn btn-mini drive-button" type="button" title="Save a copy in your Google Drive app data">Keep forever with Drive</button>\n          </div>');
html = html.replace('    <script type="module" src="js/app.js"></script>', '    <script type="importmap">{ "imports": { "./js/platform.js": "./web/platform-web.js" } }</script>\n    <script type="module" src="js/app.js"></script>');
await writeFile(resolve(output, 'index.html'), html);
console.log(`Built static browser editor at ${output}`);
