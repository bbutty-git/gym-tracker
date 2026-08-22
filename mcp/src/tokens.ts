/**
 * Stateless, HMAC-signed token envelopes.
 *
 * There is no database behind this server, so every OAuth artefact (client id,
 * authorization code, access token, refresh token) is a signed blob that carries
 * its own contents. Nothing is trusted until the signature verifies.
 *
 * The access token wraps the *Supabase* access token, and the refresh token wraps
 * the Supabase refresh token, so refreshing here maps one-to-one onto refreshing
 * there — which is what keeps Supabase's own rotation from breaking us.
 */

import { createHmac, timingSafeEqual, createHash, randomBytes } from 'node:crypto';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function sign(payload: Record<string, unknown>, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Returns null for anything tampered with, malformed, or past its exp. */
export function verify<T extends { exp?: number }>(token: string, secret: string): T | null {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac('sha256', secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: T;
  try {
    payload = JSON.parse(unb64url(body).toString('utf8')) as T;
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
  return payload;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** PKCE S256, the only method this server accepts. */
export function s256(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function randomId(bytes = 24): string {
  return b64url(randomBytes(bytes));
}

/** A registered client. redirect_uris travel inside the id so DCR needs no storage. */
export interface ClientPayload {
  k: 'client';
  ru: string[];
  name?: string;
  exp?: number;
}

/** Short-lived authorization code, carrying the Supabase refresh token it stands for. */
export interface CodePayload {
  k: 'code';
  cid: string;
  ru: string;
  cc: string;
  sbr: string;
  exp: number;
}

export interface AccessPayload {
  k: 'at';
  sba: string;
  uid: string;
  exp: number;
}

export interface RefreshPayload {
  k: 'rt';
  sbr: string;
  exp: number;
}
