# Gym Tracker MCP server

A remote [MCP](https://modelcontextprotocol.io) server that lets a Claude chat — including
the mobile app — read and write your Gym Tracker log.

It talks to the same Supabase row the app syncs to, so anything Claude writes shows up in
**History** the next time the app syncs, and anything you log on your phone is immediately
visible to Claude.

## How access works

There is no shared secret and no service-role key. Claude runs a standard OAuth 2.1 + PKCE
flow against this server, and the login page asks for **the same username and password you
use in the app**. That signs you into Supabase, and every tool call afterwards runs as you,
so the row-level security policy (`auth.uid() = user_id`) is what actually protects the data.

The server keeps no database of its own. Client registrations, authorization codes and
tokens are all HMAC-signed blobs that carry their own contents, and the access token wraps
your Supabase access token so a refresh here is exactly one refresh there.

## Deploy

The repo root is the static app, so the Vercel project must be rooted at this folder.

```bash
cd mcp
npm install
npm test                       # 42 checks, no credentials needed

# a signing secret — any 32+ random characters, keep it private
openssl rand -base64 48

npx vercel deploy --prod       # or point a Vercel project at this repo, Root Directory = mcp
```

**Root Directory must be `mcp`** (Vercel → Project → Settings → Build and Deployment). Without it
Vercel builds the repo root, finds the app's `index.html`, and serves a second copy of the app
instead of this server. Changing it does not affect existing deployments — redeploy afterwards.

Then set the environment variable in **Vercel → Project → Settings → Environment Variables**:

| Variable | Required | Default |
|---|---|---|
| `OAUTH_SIGNING_SECRET` | **yes** | — (32+ chars; rotating it signs everyone out) |
| `SUPABASE_URL` | no | the app's project |
| `SUPABASE_ANON_KEY` | no | the app's publishable key |
| `PUBLIC_ORIGIN` | no | derived from the request headers |
| `USER_DOMAIN` | no | `gymtracker.app` |

Redeploy after setting it. `curl https://<your-deployment>/health` should return
`{"name":"gym-tracker-mcp","status":"ok","mcp_endpoint":"/mcp"}`.

If that 404s, hit `/api/index` — the function's own filesystem route, which answers even when the
`vercel.json` rewrite is not in effect. JSON there means the server is built and only the rewrite is
missing; a Vercel-branded 404 there means no function was built, which is a Root Directory problem.

Note there is deliberately no `build` script: Vercel's zero-config runs `npm run build` when one
exists, which would make this look like a static site and shadow the functions. Vercel compiles
`api/*.ts` itself. Use `npm run compile` locally.

## Connect it to Claude

1. On **claude.ai** (web — connectors are added on the account, not in the mobile app),
   go to **Settings → Connectors → Add custom connector**.
2. URL: `https://<your-deployment>/mcp`
3. Claude redirects you to the login page. Enter your Gym Tracker username and password.
4. The connector is now available in **any** chat on that account, mobile included.

Use the **production** URL, not a preview URL — preview deployments get a new hostname on
every push and the connector would break. A custom domain is the most stable option.

Custom connectors need a Pro, Max, Team or Enterprise plan.

## Tools

| Tool | |
|---|---|
| `list_workouts` | Recent workouts, filterable by body part, type or date range |
| `get_workout` | Every exercise and set of one workout |
| `exercise_history` | All sets of one exercise over time, with best set and estimated 1RM |
| `workout_stats` | Volume, set counts and days since each body part was trained |
| `log_workout` | Add a completed workout |
| `update_workout` | Edit a workout already in the log |
| `delete_workout` | Remove one, with the same tombstone the app writes |
| `log_bodyweight` | Add a bodyweight entry |

Things to know:

- **Only completed workouts sync.** The in-progress workout and any loaded plan live in the
  phone's `localStorage` and never reach Supabase, so Claude can't see or start a live
  session — only add finished ones.
- **Body-part stats use the tags on each workout.** The app can also infer body parts from
  exercise names; that table isn't duplicated here, so untagged workouts are reported
  separately rather than guessed at.
- **A workout's id is its `startedAt` timestamp**, which is what the app merges on.
  Writes here set `editedAt`, so the repaired copy wins the next merge instead of being
  overwritten by a stale one from the phone.

## Layout

```
api/index.ts     one entry point; routes OAuth + /mcp
src/oauth.ts     discovery, dynamic client registration, authorize, token
src/tokens.ts    HMAC-signed stateless envelopes + PKCE
src/tools.ts     the eight tools
src/store.ts     reads/writes gym_state as the signed-in user
src/gym.ts       the app's data shapes, mirrored
test/e2e.mjs     full flow against a stand-in Supabase
```
