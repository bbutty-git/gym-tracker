# Gym Tracker

A phone-first workout logger. Log exercises, sets and set-tags (warm-up, max set, drop sets,
rest/pause, half reps), review a session before recording it, and sync across devices.

- **Single self-contained file** — `index.html`, no build step, no bundler.
- **Works offline.** Everything is logged to the browser's `localStorage` first; the cloud is
  a sync layer, not a dependency. Installs to the home screen as a PWA (`sw.js`).
- **Cloud sync via Supabase.** Each account syncs one `gym_state` row, merged non-destructively:
  workouts union across devices, the most recently edited copy of a workout wins, and deletions
  are tombstoned so they stay deleted.

The Supabase project URL and **publishable** key are in `index.html` on purpose — they're safe to
publish, because row-level security (`auth.uid() = user_id`) is what protects the data. No
service-role key or password lives in this repo.

## Use it

Open the published page and add it to your home screen. Sign in with a username and password,
or tap **"Use on this device without an account"** to stay entirely local.

## Talk to your workouts from a Claude chat

`mcp/` is a remote MCP server that lets a Claude chat — mobile included — read your history and
add or edit workouts. It authenticates with the same username and password the app uses, so
Supabase's row-level security still applies. See [`mcp/README.md`](mcp/README.md) to deploy and
connect it.

## Hosting

Served as a static page via GitHub Pages from `index.html` at the repo root. The `mcp/` folder is
deployed separately (Vercel) and isn't part of the published page.
