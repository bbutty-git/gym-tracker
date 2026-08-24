// End-to-end: OAuth discovery -> DCR -> login -> PKCE token exchange -> MCP calls.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { startFakeSupabase, USER_ID } from './fake-supabase.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('**FAIL**  ' + label + (extra ? `\n      ${extra}` : '')); }
};

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

const SEED = {
  history: [
    { dateISO: '2026-08-18', startedAt: 1000, type: 'Hypertrophy', bodyParts: ['Back'], editedAt: 1000,
      exercises: [
        { name: 'Lat Pulldown', notes: '', sets: [
          { reps: '12', weight: '100', type: 'working', max: false, extra: null },
          { reps: '10', weight: '110', type: 'working', max: true,  extra: null }] },
        { name: 'Seated Row', notes: '', sets: [
          { reps: '10', weight: '140', type: 'working', max: false, extra: null }] }
      ] },
    { dateISO: '2026-08-15', startedAt: 900, type: 'Strength', bodyParts: ['Chest'], editedAt: 900,
      exercises: [{ name: 'Bench Press', notes: '', sets: [
        { reps: '5', weight: '185', type: 'working', max: false, extra: null }] }] }
  ],
  deleted: [],
  profile: { unit: 'lbs', profileUpdatedAt: 1 }
};

const fake = await startFakeSupabase(SEED);
process.env.SUPABASE_URL = fake.url;
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.OAUTH_SIGNING_SECRET = 'test-secret-that-is-definitely-long-enough';

const { default: handler } = await import('../dist/api/index.js');

// Vercel-style body parsing in front of the handler
const app = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  // Vercel always terminates TLS and sets this; locally we are plain http, so say so
  // rather than special-casing originOf() for tests.
  req.headers['x-forwarded-proto'] = 'http';
  const ct = req.headers['content-type'] || '';
  if (raw && ct.includes('application/json')) { try { req.body = JSON.parse(raw); } catch { req.body = raw; } }
  else if (raw) req.body = raw;
  await handler(req, res);
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.address().port}`;

/* ---------- health ---------- */
const health = await (await fetch(`${base}/health`)).json();
ok('health reports the signing secret is set', health.status === 'ok' && health.signing_secret === 'set', JSON.stringify(health));

// signingSecret() reads process.env at call time, so this exercises the real path.
const savedSecret = process.env.OAUTH_SIGNING_SECRET;
delete process.env.OAUTH_SIGNING_SECRET;
const sick = await fetch(`${base}/health`);
const sickJson = await sick.json();
ok('health reports a missing signing secret instead of looking fine',
  sick.status === 500 && sickJson.status === 'misconfigured' && /is not set/.test(sickJson.signing_secret),
  `${sick.status} ${JSON.stringify(sickJson)}`);

process.env.OAUTH_SIGNING_SECRET = 'too-short';
const shortSecret = await (await fetch(`${base}/health`)).json();
ok('health distinguishes a too-short secret from a missing one',
  /only 9 characters/.test(shortSecret.signing_secret), JSON.stringify(shortSecret));
process.env.OAUTH_SIGNING_SECRET = savedSecret;

/* ---------- discovery ---------- */
const unauth = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
ok('unauthenticated /mcp returns 401', unauth.status === 401, `got ${unauth.status}`);
ok('401 points at the protected-resource metadata',
  (unauth.headers.get('www-authenticate') || '').includes('/.well-known/oauth-protected-resource'),
  unauth.headers.get('www-authenticate'));

const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
ok('protected-resource metadata advertises this server', prm.authorization_servers?.[0] === base, JSON.stringify(prm));

const asm = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
ok('AS metadata requires PKCE S256', asm.code_challenge_methods_supported?.includes('S256'));
ok('AS metadata lists both grants',
  asm.grant_types_supported?.includes('authorization_code') && asm.grant_types_supported?.includes('refresh_token'));

/* ---------- dynamic client registration ---------- */
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude' }) })).json();
ok('DCR issues a client_id', typeof reg.client_id === 'string' && reg.client_id.length > 20);

const badReg = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: ['http://evil.test/cb'] }) });
ok('DCR rejects non-loopback http redirect_uris', badReg.status === 400, `got ${badReg.status}`);

const loopback = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:41999/cb'], client_name: 'Claude Code' }) });
ok('DCR accepts a loopback http redirect_uri (OAuth 2.1 native clients)', loopback.status === 201, `got ${loopback.status}`);

const mixed = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: [REDIRECT, 'http://localhost:8080/cb'] }) });
ok('DCR accepts https and loopback together', mixed.status === 201, `got ${mixed.status}`);

const emptyBody = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const emptyBodyJson = await emptyBody.json();
ok('DCR names the empty-body case rather than blaming the redirect_uri',
  emptyBody.status === 400 && emptyBodyJson.error === 'invalid_client_metadata', JSON.stringify(emptyBodyJson));

/* ---------- authorize ---------- */
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier, 'ascii').digest());
const authQs = new URLSearchParams({ client_id: reg.client_id, redirect_uri: REDIRECT, state: 'xyz',
  code_challenge: challenge, code_challenge_method: 'S256' });

const loginPage = await fetch(`${base}/authorize?${authQs}`);
ok('authorize renders a login page', loginPage.status === 200 && (await loginPage.text()).includes('Connect Gym Tracker'));

const forged = new URLSearchParams(authQs); forged.set('redirect_uri', 'https://evil.test/cb');
ok('authorize rejects an unregistered redirect_uri', (await fetch(`${base}/authorize?${forged}`)).status === 400);

const tamper = new URLSearchParams(authQs); tamper.set('client_id', reg.client_id.slice(0, -3) + 'aaa');
ok('authorize rejects a tampered client_id', (await fetch(`${base}/authorize?${tamper}`)).status === 400);

const wrongPw = await fetch(`${base}/authorize`, { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...Object.fromEntries(authQs), username: 'ben', password: 'nope' }).toString() });
ok('wrong password does not issue a code', wrongPw.status === 401);

const login = await fetch(`${base}/authorize`, { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...Object.fromEntries(authQs), username: 'ben', password: fake.credentials.password }).toString() });
ok('correct password redirects back to the client', login.status === 302);
const cb = new URL(login.headers.get('location'));
ok('redirect carries state', cb.searchParams.get('state') === 'xyz');
const code = cb.searchParams.get('code');
ok('redirect carries a code', !!code);

/* ---------- token ---------- */
const badPkce = await fetch(`${base}/token`, { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    code_verifier: b64url(randomBytes(32)) }).toString() });
ok('token rejects a wrong PKCE verifier', badPkce.status === 400);

const tok = await (await fetch(`${base}/token`, { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
    code_verifier: verifier }).toString() })).json();
ok('token exchange returns a bearer access token', tok.token_type === 'Bearer' && !!tok.access_token, JSON.stringify(tok));
ok('token exchange returns a refresh token', !!tok.refresh_token);

const refreshed = await (await fetch(`${base}/token`, { method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }).toString() })).json();
ok('refresh_token grant returns a fresh pair', !!refreshed.access_token && !!refreshed.refresh_token);

/* ---------- MCP ---------- */
let rpcId = 0;
async function rpc(method, params, token = tok.access_token) {
  const r = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'test', version: '1' } });
ok('initialize succeeds', init.result?.serverInfo?.name === 'gym-tracker', JSON.stringify(init).slice(0, 300));

const list = await rpc('tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name).sort();
ok('all eight tools are exposed',
  JSON.stringify(names) === JSON.stringify(['delete_workout','exercise_history','get_workout','list_workouts','log_bodyweight','log_workout','update_workout','workout_stats']),
  JSON.stringify(names));

const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return r.result?.content?.[0]?.text ?? JSON.stringify(r);
};

const listed = await call('list_workouts', { limit: 5 });
ok('list_workouts returns both seeded workouts', listed.includes('2026-08-18') && listed.includes('2026-08-15'), listed);

const backOnly = await call('list_workouts', { bodyPart: 'Back' });
ok('list_workouts filters by body part', backOnly.includes('2026-08-18') && !backOnly.includes('2026-08-15'), backOnly);

const one = await call('get_workout', { id: 1000 });
ok('get_workout shows every set', one.includes('Lat Pulldown') && one.includes('110lbs x 10') && one.includes('max set'), one);

const hist = await call('exercise_history', { exercise: 'pulldown' });
ok('exercise_history finds by substring and reports a best set',
  hist.includes('Lat Pulldown') && hist.includes('est. 1RM'), hist);

const stats = await call('workout_stats', { since: '2026-01-01' });
ok('workout_stats counts all workouts', stats.includes('2 workouts'), stats);

/* ---------- writes ---------- */
const logged = await call('log_workout', {
  dateISO: '2026-08-22', type: 'Hypertrophy', bodyParts: ['Back'],
  exercises: [{ name: 'Barbell Row', sets: [
    { reps: 8, weight: 185 }, { reps: 8, weight: 185, max: true }, { reps: 12, weight: 95, type: 'warmup' }] }]
});
ok('log_workout writes the workout', logged.includes('Barbell Row') && logged.includes('185lbs x 8'), logged);

const afterLog = fake.current();
const added = afterLog.history.find((w) => w.dateISO === '2026-08-22');
ok('logged workout reaches the database', !!added);
ok('logged workout has editedAt set so the app merge keeps it', !!added && added.editedAt > 0);
ok('logged sets use the app string shape', !!added && added.exercises[0].sets[0].reps === '8' && added.exercises[0].sets[0].weight === '185');
ok('warm-up set kept its type', !!added && added.exercises[0].sets[2].type === 'warmup');
ok('only one max set survives', !!added && added.exercises[0].sets.filter((s) => s.max).length === 1);

const upd = await call('update_workout', { id: added.startedAt, comment: 'felt strong', bodyParts: ['Back', 'Biceps'] });
ok('update_workout edits in place', upd.includes('felt strong'), upd);
ok('update kept the same workout id', fake.current().history.filter((w) => w.startedAt === added.startedAt).length === 1);

const bw = await call('log_bodyweight', { weight: 181.5, dateISO: '2026-08-22' });
ok('log_bodyweight records an entry', bw.includes('181.5'), bw);
ok('bodyweight lands in the profile', fake.current().profile.bodyweightLog?.some((e) => e.weight === '181.5'));

const del = await call('delete_workout', { id: added.startedAt });
ok('delete_workout removes it', del.includes('Deleted'), del);
ok('deleted workout is gone from history', !fake.current().history.some((w) => w.startedAt === added.startedAt));
ok('delete leaves a tombstone so it will not resync',
  fake.current().deleted.includes(String(added.startedAt)), JSON.stringify(fake.current().deleted));

const missing = await call('get_workout', { id: 424242 });
ok('unknown id fails cleanly', missing.includes('No workout found'), missing);

/* ---------- unparsed body fallback ---------- */
// Some runtimes hand the handler no req.body at all; it must read the stream itself.
const rawApp = createServer(async (req, res) => { await handler(req, res); });   // deliberately no body parsing
await new Promise((r) => rawApp.listen(0, '127.0.0.1', r));
const rawBase = `http://127.0.0.1:${rawApp.address().port}`;
const rawReg = await fetch(`${rawBase}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Claude' }) });
const rawRegJson = await rawReg.json();
ok('DCR works when the runtime does not pre-parse the body',
  rawReg.status === 201 && typeof rawRegJson.client_id === 'string', `${rawReg.status} ${JSON.stringify(rawRegJson).slice(0,160)}`);
await new Promise((r) => rawApp.close(r));

/* ---------- vercel rewrite shape ---------- */
// Vercel forwards the real path as __path; make sure that routing works too.
const viaRewrite = await fetch(`${base}/api/index?__path=/.well-known/oauth-protected-resource`);
const viaRewriteBody = await viaRewrite.json();
ok('routes on the __path Vercel rewrites in', viaRewriteBody.resource?.endsWith('/mcp'), JSON.stringify(viaRewriteBody));

const authViaRewrite = await fetch(`${base}/api/index?__path=/authorize&${authQs}`);
ok('authorize still sees its query params through the rewrite',
  authViaRewrite.status === 200 && (await authViaRewrite.text()).includes('Connect Gym Tracker'), `status ${authViaRewrite.status}`);

/* ---------- token isolation ---------- */
const bogus = await rpc('tools/list', {}, 'not-a-real-token');
ok('a forged bearer token is rejected', !bogus.result, JSON.stringify(bogus).slice(0, 200));

await new Promise((r) => app.close(r));
await fake.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
