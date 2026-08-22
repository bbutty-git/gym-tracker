/**
 * Runtime configuration. Only OAUTH_SIGNING_SECRET is mandatory — the Supabase
 * URL and publishable key default to the ones the app itself ships with, which
 * are public by design (row-level security is what protects the data).
 */

export const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ffbsvwxntaksqdtbvshz.supabase.co';
export const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || 'sb_publishable_zo9eWfMSH4fryDbAVKA3Tg_aNCydINU';

/** Plain usernames log in as <name>@gymtracker.app, same as the app. */
export const USER_DOMAIN = process.env.USER_DOMAIN || 'gymtracker.app';

export function signingSecret(): string {
  const s = process.env.OAUTH_SIGNING_SECRET;
  if (!s || s.length < 32) {
    throw new Error('OAUTH_SIGNING_SECRET is missing or shorter than 32 characters.');
  }
  return s;
}

export function toLoginEmail(u: string): string {
  const t = (u || '').trim().toLowerCase();
  if (!t) return '';
  return t.includes('@') ? t : `${t}@${USER_DOMAIN}`;
}

/** Public origin of this deployment, used as the OAuth issuer and resource id. */
export function originOf(req: { headers: Record<string, string | string[] | undefined> }): string {
  const envOrigin = process.env.PUBLIC_ORIGIN;
  if (envOrigin) return envOrigin.replace(/\/+$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${host}`;
}
