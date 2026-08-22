/**
 * Reads and writes the single gym_state row that belongs to the signed-in user.
 *
 * Every call goes through the user's own Supabase access token, so the row-level
 * security policy ("own state": auth.uid() = user_id) is what actually enforces
 * access. This server never holds a service-role key, so a bug here cannot reach
 * another account's data.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { EMPTY_STATE, type GymState, type Workout } from './gym.js';

export function userClient(supabaseAccessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${supabaseAccessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

export async function readState(sb: SupabaseClient, userId: string): Promise<GymState> {
  const { data, error } = await sb.from('gym_state').select('data').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`Could not read your workouts: ${error.message}`);
  const raw = (data?.data ?? {}) as Partial<GymState>;
  return {
    history: Array.isArray(raw.history) ? raw.history : [],
    deleted: Array.isArray(raw.deleted) ? raw.deleted : [],
    profile: raw.profile && typeof raw.profile === 'object' ? raw.profile : {}
  };
}

export async function writeState(sb: SupabaseClient, userId: string, state: GymState): Promise<void> {
  const { error } = await sb
    .from('gym_state')
    .upsert(
      { user_id: userId, data: state, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
  if (error) throw new Error(`Could not save your workouts: ${error.message}`);
}

/**
 * Read, change, write back. The app pushes the whole blob too, so a write from
 * here and a sync from the phone at the same instant is last-writer-wins on the
 * row — but the app re-merges by workoutKey on its next pull, so an individual
 * workout survives either way.
 */
export async function mutateState(
  sb: SupabaseClient,
  userId: string,
  fn: (state: GymState) => GymState | void
): Promise<GymState> {
  const state = await readState(sb, userId);
  const next = fn(state) || state;
  next.history = next.history.slice(0, 200); // the app caps history at 200
  await writeState(sb, userId, next);
  return next;
}

export const emptyState = (): GymState => structuredClone(EMPTY_STATE);

export type { Workout };
