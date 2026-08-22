/**
 * The workout shapes the app writes to Supabase.
 *
 * These mirror index.html exactly. The app merges cloud state by workoutKey() and
 * keeps whichever copy has the newer editedAt, so anything written here has to use
 * the same key and bump editedAt or the app will quietly discard it on next sync.
 */

export const SET_TYPES = ['working', 'warmup'] as const;
export type SetType = (typeof SET_TYPES)[number];

/** Set tags the app knows. Anything else is normalised to null ("No Tag"). */
export const EXTRAS = ['assisted', 'drop', 'restpause', 'half'] as const;
export type Extra = (typeof EXTRAS)[number];

export const WORKOUT_TYPES = ['Deload', 'Hypertrophy', 'Strength'] as const;
export const BODY_PARTS = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core'] as const;

/** reps and weight are strings in the app — they come straight off text inputs. */
export interface GymSet {
  reps: string;
  weight: string;
  type: SetType;
  max: boolean;
  extra: Extra | null;
}

export interface Exercise {
  name: string;
  notes?: string;
  sets: GymSet[];
}

export interface Workout {
  dateISO: string;
  startedAt: number;
  endedAt?: number;
  duration?: string;
  type?: string;
  bodyParts?: string[];
  exercises: Exercise[];
  comment?: string;
  synced?: boolean;
  editedAt?: number;
}

export interface Profile {
  name?: string;
  height?: string;
  bodyweight?: string;
  unit?: string;
  maxLifts?: unknown[];
  bodyweightLog?: { dateISO: string; weight: string }[];
  deloadResetISO?: string | null;
  brands?: string[];
  profileUpdatedAt?: number;
}

/** The exact payload shape pushState() writes to gym_state.data. */
export interface GymState {
  history: Workout[];
  deleted: string[];
  profile: Profile;
}

export const EMPTY_STATE: GymState = { history: [], deleted: [], profile: {} };

/**
 * Identity of a workout across devices — must stay byte-identical to the app's
 * workoutKey(), or a workout written here would merge as a second, separate one.
 */
export function workoutKey(w: Workout): string {
  return String(w?.startedAt || `${w?.dateISO}|${(w?.exercises || []).map((e) => e.name).join(',')}`);
}

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Coerce loose tool input into the app's set shape. Unknown tags become null. */
export function normalizeSet(raw: {
  reps: number | string;
  weight: number | string;
  type?: string;
  max?: boolean;
  extra?: string | null;
}): GymSet {
  const extra = raw.extra && (EXTRAS as readonly string[]).includes(raw.extra) ? (raw.extra as Extra) : null;
  return {
    reps: String(raw.reps ?? '').trim(),
    weight: String(raw.weight ?? '').trim(),
    type: raw.type === 'warmup' ? 'warmup' : 'working',
    max: !!raw.max,
    extra
  };
}

/** Only one set per exercise may carry the Max Set flame, same as the app. */
export function enforceSingleMax(sets: GymSet[]): GymSet[] {
  const last = sets.map((s) => s.max).lastIndexOf(true);
  return sets.map((s, i) => ({ ...s, max: s.max && i === last }));
}

export function setVolume(s: GymSet): number {
  return (parseFloat(s.weight) || 0) * (parseInt(s.reps, 10) || 0);
}

export function workoutVolume(w: Workout): number {
  return w.exercises.reduce((v, ex) => v + ex.sets.reduce((sv, s) => sv + setVolume(s), 0), 0);
}

export function workoutSetCount(w: Workout): number {
  return w.exercises.reduce((n, ex) => n + ex.sets.length, 0);
}

export function workingSets(w: Workout): number {
  return w.exercises.reduce((n, ex) => n + ex.sets.filter((s) => s.type !== 'warmup').length, 0);
}

/** Newest first — the order the app keeps history in. */
export function sortHistory(hist: Workout[]): Workout[] {
  return [...hist].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function findWorkout(hist: Workout[], startedAt: number): Workout | undefined {
  return hist.find((w) => w.startedAt === startedAt);
}

export function describeSet(s: GymSet, unit: string): string {
  const tags = [
    s.type === 'warmup' ? 'warm up' : null,
    s.max ? 'max set' : null,
    s.extra ? s.extra : null
  ].filter(Boolean);
  return `${s.weight}${unit} x ${s.reps}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
}
