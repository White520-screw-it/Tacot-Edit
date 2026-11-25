# Browser editor hosting

The public browser editor is served from the existing `editor.tacot.org` Worker at
`/editor/`. The site root and installer downloads continue through their existing
routes.

Build the static files from the repository root:

```sh
npm run build:web
```

The build writes `dist/editor/` and injects the browser platform import map into
that copy of the app. It does not alter the Tauri app entry point.

To deploy, load the existing Cloudflare token from `Tacot/.env` in the shell,
then use Wrangler. The token stays out of the repository:

```sh
while IFS= read -r line; do
  case "$line" in CLOUDFLARE_API_TOKEN=*) export "$line" ;; esac
done < ../Tacot/.env
../Tacot/node_modules/.bin/wrangler deploy --config hosting/wrangler.toml
```

The Worker uses the existing `DOWNLOADS` KV namespace for installer delivery and
adds a static `ASSETS` binding backed by `dist/`. It redirects `/editor` to
`/editor/`; all other site and installer paths retain the current pass-through
behavior.

Google Drive persistence is optional. Set `window.TACOT_DRIVE_CLIENT_ID` before
the app module loads and configure that OAuth client for the hosted origin. If it
is absent, the button explains that Drive is not configured. Browser edits and
exports otherwise remain local to the user's browser.
