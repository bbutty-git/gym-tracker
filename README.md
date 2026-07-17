# Gym To Google Sheets Formatter Pro

A phone-first workout logger. Log exercises, sets, and set-tags (warm-up, max set, drop sets, etc.),
then sync each finished workout to your own Google Sheet + Google Doc.

- **Single self-contained file** — `index.html`, no build step, no server.
- **Data stays on your device** (browser localStorage). Sync is an optional one-way push to Google.
- **No secrets in this repo:** your Google Doc/Sheet URLs and the Apps Script "bridge" URL are entered
  in the app's Settings screen at runtime and stored only in your browser — never in this code.

## Use it

Open the published page and add it to your home screen. Then in **Settings → Apps Script bridge → "? Set up"**,
follow the 2-minute walkthrough to connect your Google Sheet and Doc.

## Hosting

Served as a static page via GitHub Pages from `index.html` at the repo root.
