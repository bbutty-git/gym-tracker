/**
 * OAuth 2.1 for the connector, backed by the gym tracker's own Supabase login.
 *
 * Claude discovers this via RFC 9728 (protected-resource metadata) on a 401, then
 * registers itself with Dynamic Client Registration and runs a normal PKCE code
 * flow. The "login page" is the app's username and password — signing in issues a
 * Supabase session, and that session is what every later tool call runs as.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, signingSecret, toLoginEmail, originOf } from './config.js';
import {
  sign,
  verify,
  s256,
  randomId,
  MINUTE,
  HOUR,
  DAY,
  type ClientPayload,
  type CodePayload,
  type AccessPayload,
  type RefreshPayload
} from './tokens.js';

type Req = IncomingMessage & { body?: unknown; headers: Record<string, string | string[] | undefined> };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

/** Vercel gives us a parsed body for JSON; forms arrive as a raw string. */
function formOf(body: unknown): URLSearchParams {
  if (typeof body === 'string') return new URLSearchParams(body);
  if (body && typeof body === 'object') return new URLSearchParams(body as Record<string, string>);
  return new URLSearchParams();
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return Object.fromEntries(new URLSearchParams(body));
    }
  }
  return (body ?? {}) as Record<string, unknown>;
}

/* ---------- discovery ---------- */

export function protectedResourceMetadata(req: Req, res: ServerResponse): void {
  const origin = originOf(req);
  json(res, 200, {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ['workouts'],
    bearer_methods_supported: ['header']
  });
}

export function authorizationServerMetadata(req: Req, res: ServerResponse): void {
  const origin = originOf(req);
  json(res, 200, {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['workouts']
  });
}

/* ---------- dynamic client registration (RFC 7591) ---------- */

export function register(req: Req, res: ServerResponse): void {
  const body = bodyOf(req.body);
  const uris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
  if (!uris.length || !uris.every((u) => typeof u === 'string' && u.startsWith('https://'))) {
    json(res, 400, { error: 'invalid_redirect_uri', error_description: 'https redirect_uris are required' });
    return;
  }
  // The client id *is* the registration: signed, so /authorize can trust the
  // redirect_uris inside it without any storage behind this server.
  const client_id = sign(
    { k: 'client', ru: uris, name: String(body.client_name || 'MCP client') } satisfies ClientPayload,
    signingSecret()
  );
  json(res, 201, {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  });
}

/* ---------- authorize ---------- */

interface AuthParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  method: string;
}

function readAuthParams(p: URLSearchParams): AuthParams {
  return {
    client_id: p.get('client_id') || '',
    redirect_uri: p.get('redirect_uri') || '',
    state: p.get('state') || '',
    code_challenge: p.get('code_challenge') || '',
    method: p.get('code_challenge_method') || ''
  };
}

/** Validates the client id signature and that redirect_uri was registered with it. */
function checkClient(a: AuthParams): string | null {
  const client = verify<ClientPayload>(a.client_id, signingSecret());
  if (!client || client.k !== 'client') return 'Unknown client. Remove the connector and add it again.';
  if (!client.ru.includes(a.redirect_uri)) return 'That redirect_uri was not registered for this client.';
  if (a.method !== 'S256') return 'This server only accepts PKCE with code_challenge_method=S256.';
  if (!a.code_challenge) return 'Missing code_challenge.';
  return null;
}

function loginPage(a: AuthParams, error?: string): string {
  const field = (n: string, v: string) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Gym Tracker</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100dvh; display:grid; place-items:center; background:#0e0e12; color:#f2f2f5;
         font:500 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; padding:24px; }
  .card { width:100%; max-width:360px; background:#17171d; border:1px solid rgba(255,255,255,.08);
          border-radius:20px; padding:26px 22px; }
  h1 { font-size:19px; font-weight:800; margin:0 0 4px; }
  p.sub { margin:0 0 20px; color:rgba(255,255,255,.55); font-size:13px; }
  label { display:block; font-size:12px; font-weight:700; letter-spacing:.04em;
          text-transform:uppercase; color:rgba(255,255,255,.5); margin:14px 0 6px; }
  input[type=text],input[type=password] { width:100%; box-sizing:border-box; background:#0e0e12;
          border:1px solid rgba(255,255,255,.14); border-radius:12px; padding:12px 13px;
          color:#f2f2f5; font:inherit; outline:none; }
  input:focus { border-color:#F72585; }
  button { width:100%; margin-top:22px; background:#F72585; color:#fff; border:0; border-radius:12px;
           padding:14px; font:800 15px inherit; cursor:pointer; }
  .err { background:rgba(255,80,80,.12); border:1px solid rgba(255,80,80,.3); color:#ff8a84;
         border-radius:10px; padding:10px 12px; font-size:13px; margin-bottom:8px; }
  .note { margin-top:18px; font-size:12px; color:rgba(255,255,255,.4); line-height:1.5; }
</style></head><body>
<form class="card" method="post" action="/authorize">
  <h1>Connect Gym Tracker</h1>
  <p class="sub">Sign in with the same username and password you use in the app.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
  <label for="u">Username</label>
  <input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" autocorrect="off" required>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Allow access</button>
  <div class="note">Claude will be able to read your workout history and add or edit workouts in it.</div>
  ${field('client_id', a.client_id)}${field('redirect_uri', a.redirect_uri)}
  ${field('state', a.state)}${field('code_challenge', a.code_challenge)}
  ${field('code_challenge_method', a.method)}
</form></body></html>`;
}

export function authorizeGet(req: Req, res: ServerResponse): void {
  const url = new URL(req.url || '/', 'https://x');
  const a = readAuthParams(url.searchParams);
  const bad = checkClient(a);
  if (bad) {
    html(res, 400, `<!doctype html><meta charset=utf-8><p style="font-family:sans-serif">${esc(bad)}</p>`);
    return;
  }
  html(res, 200, loginPage(a));
}

export async function authorizePost(req: Req, res: ServerResponse): Promise<void> {
  const form = formOf(req.body);
  const a = readAuthParams(form);
  const bad = checkClient(a);
  if (bad) {
    html(res, 400, `<!doctype html><meta charset=utf-8><p style="font-family:sans-serif">${esc(bad)}</p>`);
    return;
  }

  const email = toLoginEmail(form.get('username') || '');
  const password = form.get('password') || '';
  if (!email || !password) {
    html(res, 400, loginPage(a, 'Enter your username and password.'));
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    const msg = /invalid login/i.test(error?.message || '')
      ? 'Wrong username or password.'
      : error?.message || 'Sign-in failed.';
    html(res, 401, loginPage(a, msg));
    return;
  }

  const code = sign(
    {
      k: 'code',
      cid: a.client_id,
      ru: a.redirect_uri,
      cc: a.code_challenge,
      sbr: data.session.refresh_token,
      exp: Date.now() + 2 * MINUTE
    } satisfies CodePayload,
    signingSecret()
  );

  const to = new URL(a.redirect_uri);
  to.searchParams.set('code', code);
  if (a.state) to.searchParams.set('state', a.state);
  res.statusCode = 302;
  res.setHeader('Location', to.toString());
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/* ---------- token ---------- */

/**
 * Turns a Supabase session into our own pair. Our access token is a signed wrapper
 * around the Supabase access token, so tool calls can act as the user without any
 * server-side session store; our refresh token wraps theirs, so each refresh here
 * is exactly one refresh there and Supabase's rotation stays consistent.
 */
function issue(session: { access_token: string; refresh_token: string; user: { id: string } }): {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
} {
  const secret = signingSecret();
  return {
    access_token: sign(
      { k: 'at', sba: session.access_token, uid: session.user.id, exp: Date.now() + HOUR } satisfies AccessPayload,
      secret
    ),
    refresh_token: sign(
      { k: 'rt', sbr: session.refresh_token, exp: Date.now() + 30 * DAY } satisfies RefreshPayload,
      secret
    ),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'workouts'
  };
}

export async function token(req: Req, res: ServerResponse): Promise<void> {
  const form = formOf(req.body);
  const grant = form.get('grant_type') || '';
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  if (grant === 'authorization_code') {
    const payload = verify<CodePayload>(form.get('code') || '', signingSecret());
    if (!payload || payload.k !== 'code') {
      json(res, 400, { error: 'invalid_grant', error_description: 'The authorization code is invalid or expired.' });
      return;
    }
    const verifier = form.get('code_verifier') || '';
    if (!verifier || s256(verifier) !== payload.cc) {
      json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
      return;
    }
    if (form.get('redirect_uri') && form.get('redirect_uri') !== payload.ru) {
      json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri does not match the code.' });
      return;
    }
    const { data, error } = await sb.auth.refreshSession({ refresh_token: payload.sbr });
    if (error || !data.session) {
      json(res, 400, { error: 'invalid_grant', error_description: error?.message || 'Session could not be established.' });
      return;
    }
    json(res, 200, issue(data.session));
    return;
  }

  if (grant === 'refresh_token') {
    const payload = verify<RefreshPayload>(form.get('refresh_token') || '', signingSecret());
    if (!payload || payload.k !== 'rt') {
      json(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is invalid or expired.' });
      return;
    }
    const { data, error } = await sb.auth.refreshSession({ refresh_token: payload.sbr });
    if (error || !data.session) {
      json(res, 400, { error: 'invalid_grant', error_description: error?.message || 'Could not refresh. Reconnect the connector.' });
      return;
    }
    json(res, 200, issue(data.session));
    return;
  }

  json(res, 400, { error: 'unsupported_grant_type' });
}

/* ---------- bearer check for /mcp ---------- */

export interface Session {
  supabaseAccessToken: string;
  userId: string;
}

export function authenticate(req: Req): Session | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !/^Bearer /i.test(header)) return null;
  const payload = verify<AccessPayload>(header.slice(7).trim(), signingSecret());
  if (!payload || payload.k !== 'at') return null;
  return { supabaseAccessToken: payload.sba, userId: payload.uid };
}

/** A 401 that tells Claude where to find the authorization server (RFC 9728). */
export function unauthorized(req: Req, res: ServerResponse): void {
  const origin = originOf(req);
  res.setHeader(
    'WWW-Authenticate',
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
  );
  json(res, 401, { error: 'invalid_token', error_description: 'Sign in to Gym Tracker to use this connector.' });
}

export { randomId };
