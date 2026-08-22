/**
 * The tools a Claude chat sees. Everything runs as the signed-in user via their
 * own Supabase token, so nothing here can reach another account's log.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Session } from './oauth.js';
import { readState, mutateState, userClient } from './store.js';
import {
  BODY_PARTS,
  EXTRAS,
  WORKOUT_TYPES,
  describeSet,
  enforceSingleMax,
  findWorkout,
  isISODate,
  normalizeSet,
  setVolume,
  sortHistory,
  todayISO,
  workingSets,
  workoutKey,
  workoutSetCount,
  workoutVolume,
  type Exercise,
  type Workout
} from './gym.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const setInput = z.object({
  reps: z.union([z.number(), z.string()]).describe('Reps performed, e.g. 8'),
  weight: z.union([z.number(), z.string()]).describe('Weight used, in the profile unit. Use 0 for bodyweight.'),
  type: z.enum(['working', 'warmup']).optional().describe('Defaults to working.'),
  max: z.boolean().optional().describe('Mark this as the exercise\'s Max Set. At most one per exercise.'),
  extra: z.enum(EXTRAS).nullish().describe('Optional set tag.')
});

const exerciseInput = z.object({
  name: z.string().min(1).describe('Exercise name, e.g. "Lat Pulldown".'),
  notes: z.string().optional(),
  sets: z.array(setInput).min(1)
});

function unitOf(profileUnit: string | undefined): string {
  return profileUnit || 'lbs';
}

function summarise(w: Workout, unit: string): string {
  const meta = [w.type, (w.bodyParts || []).join(', ')].filter(Boolean).join(' · ');
  return [
    `${w.dateISO}${meta ? ` — ${meta}` : ''}${w.duration ? ` (${w.duration})` : ''}`,
    `  ${w.exercises.length} exercises, ${workoutSetCount(w)} sets, ${Math.round(workoutVolume(w)).toLocaleString()} ${unit} volume`,
    `  id: ${w.startedAt}`
  ].join('\n');
}

function detail(w: Workout, unit: string): string {
  const meta = [w.type, (w.bodyParts || []).join(', ')].filter(Boolean).join(' · ');
  const lines = [
    `${w.dateISO}${meta ? ` — ${meta}` : ''}${w.duration ? ` (${w.duration})` : ''}   id: ${w.startedAt}`,
    ''
  ];
  w.exercises.forEach((ex) => {
    lines.push(ex.name);
    ex.sets.forEach((s, i) => lines.push(`  ${i + 1}. ${describeSet(s, unit)}`));
    if (ex.notes) lines.push(`  note: ${ex.notes}`);
    lines.push('');
  });
  if (w.comment) lines.push(`Comment: ${w.comment}`);
  lines.push(`Totals: ${workoutSetCount(w)} sets (${workingSets(w)} working), ${Math.round(workoutVolume(w)).toLocaleString()} ${unit} volume`);
  return lines.join('\n');
}

export function buildServer(session: Session): McpServer {
  const server = new McpServer(
    { name: 'gym-tracker', version: '1.0.0' },
    {
      instructions:
        'Read and update the user\'s Gym Tracker workout log. Weights and reps are stored as ' +
        'strings in the unit given by the profile (usually lbs). A workout is identified by its ' +
        'numeric "id" (its startedAt timestamp). Prefer log_workout for a session that already ' +
        'happened; the app owns in-progress workouts and plans, which do not sync.'
    }
  );

  const sb = () => userClient(session.supabaseAccessToken);

  /* ------------------------------- read ------------------------------- */

  server.registerTool(
    'list_workouts',
    {
      title: 'List workouts',
      description:
        'Recent workouts, newest first, as a compact summary. Filter by body part, workout type or date range.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Default 10.'),
        bodyPart: z.enum(BODY_PARTS).optional(),
        type: z.enum(WORKOUT_TYPES).optional(),
        since: z.string().optional().describe('Inclusive YYYY-MM-DD.'),
        until: z.string().optional().describe('Inclusive YYYY-MM-DD.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ limit, bodyPart, type, since, until }) => {
      const state = await readState(sb(), session.userId);
      const unit = unitOf(state.profile.unit);
      let hist = sortHistory(state.history);
      if (bodyPart) hist = hist.filter((w) => (w.bodyParts || []).includes(bodyPart));
      if (type) hist = hist.filter((w) => w.type === type);
      if (since) hist = hist.filter((w) => w.dateISO >= since);
      if (until) hist = hist.filter((w) => w.dateISO <= until);
      const page = hist.slice(0, limit ?? 10);
      if (!page.length) return text('No workouts match that.');
      return text(
        `${page.length} of ${hist.length} matching workouts:\n\n${page.map((w) => summarise(w, unit)).join('\n\n')}`
      );
    }
  );

  server.registerTool(
    'get_workout',
    {
      title: 'Get one workout',
      description: 'Every exercise and set of a single workout, by its id or by date.',
      inputSchema: {
        id: z.number().optional().describe('The workout id from list_workouts.'),
        date: z.string().optional().describe('YYYY-MM-DD. Used when id is not given; picks the latest that day.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ id, date }) => {
      const state = await readState(sb(), session.userId);
      const unit = unitOf(state.profile.unit);
      const hist = sortHistory(state.history);
      const w = id != null ? findWorkout(hist, id) : date ? hist.find((x) => x.dateISO === date) : hist[0];
      if (!w) return text('No workout found for that id or date.');
      return text(detail(w, unit));
    }
  );

  server.registerTool(
    'exercise_history',
    {
      title: 'History for one exercise',
      description:
        'Every logged set of a named exercise over time, newest first, with the heaviest set and best estimated 1RM. Use this for progress questions.',
      inputSchema: {
        exercise: z.string().min(1).describe('Matched case-insensitively as a substring, so "row" finds Barbell Row.'),
        limit: z.number().int().min(1).max(50).optional().describe('How many sessions to return. Default 10.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ exercise, limit }) => {
      const state = await readState(sb(), session.userId);
      const unit = unitOf(state.profile.unit);
      const q = exercise.trim().toLowerCase();
      const rows: { dateISO: string; name: string; sets: typeof state.history[number]['exercises'][number]['sets'] }[] = [];
      sortHistory(state.history).forEach((w) => {
        w.exercises.forEach((ex) => {
          if (ex.name.toLowerCase().includes(q)) rows.push({ dateISO: w.dateISO, name: ex.name, sets: ex.sets });
        });
      });
      if (!rows.length) return text(`Nothing logged matching "${exercise}".`);

      let best = { weight: 0, reps: 0, dateISO: '', e1rm: 0 };
      rows.forEach((r) =>
        r.sets.forEach((s) => {
          const wt = parseFloat(s.weight) || 0;
          const rp = parseInt(s.reps, 10) || 0;
          const e1rm = wt * (1 + rp / 30); // Epley
          if (e1rm > best.e1rm) best = { weight: wt, reps: rp, dateISO: r.dateISO, e1rm };
        })
      );

      const page = rows.slice(0, limit ?? 10);
      const body = page
        .map((r) => `${r.dateISO} — ${r.name}\n${r.sets.map((s, i) => `  ${i + 1}. ${describeSet(s, unit)}`).join('\n')}`)
        .join('\n\n');
      return text(
        `${rows.length} sessions matching "${exercise}" (showing ${page.length}).\n` +
          `Best set: ${best.weight}${unit} x ${best.reps} on ${best.dateISO} (est. 1RM ${Math.round(best.e1rm)}${unit})\n\n${body}`
      );
    }
  );

  server.registerTool(
    'workout_stats',
    {
      title: 'Training summary',
      description:
        'Totals and frequency over a window, plus how many days since each body part was last trained (based on the body parts tagged on each workout).',
      inputSchema: { since: z.string().optional().describe('Inclusive YYYY-MM-DD. Defaults to the last 30 days.') },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ since }) => {
      const state = await readState(sb(), session.userId);
      const unit = unitOf(state.profile.unit);
      const from = since || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      const hist = sortHistory(state.history);
      const win = hist.filter((w) => w.dateISO >= from);

      const last: Record<string, string> = {};
      hist.forEach((w) => (w.bodyParts || []).forEach((bp) => {
        if (!last[bp] || w.dateISO > last[bp]!) last[bp] = w.dateISO;
      }));
      const today = todayISO();
      const days = (iso: string) => Math.round((Date.parse(today) - Date.parse(iso)) / 86400_000);

      const recency = BODY_PARTS.map((bp) =>
        last[bp] ? `  ${bp}: ${days(last[bp]!)}d ago (${last[bp]})` : `  ${bp}: never tagged`
      ).join('\n');

      const untagged = hist.filter((w) => !(w.bodyParts || []).length).length;
      return text(
        [
          `Since ${from}: ${win.length} workouts, ${win.reduce((n, w) => n + workoutSetCount(w), 0)} sets ` +
            `(${win.reduce((n, w) => n + workingSets(w), 0)} working), ` +
            `${Math.round(win.reduce((v, w) => v + workoutVolume(w), 0)).toLocaleString()} ${unit} volume.`,
          `All time: ${hist.length} workouts.`,
          '',
          'Days since each body part:',
          recency,
          untagged ? `\n(${untagged} workouts have no body parts tagged and are not counted above.)` : ''
        ].join('\n')
      );
    }
  );

  /* ------------------------------ write ------------------------------- */

  server.registerTool(
    'log_workout',
    {
      title: 'Log a completed workout',
      description:
        'Add a finished workout to the log. It appears in the app\'s History after its next sync. For a session that already happened — the app owns in-progress workouts.',
      inputSchema: {
        dateISO: z.string().optional().describe('YYYY-MM-DD. Defaults to today.'),
        type: z.enum(WORKOUT_TYPES).optional(),
        bodyParts: z.array(z.enum(BODY_PARTS)).optional(),
        exercises: z.array(exerciseInput).min(1),
        comment: z.string().optional(),
        duration: z.string().optional().describe('Free text, e.g. "48 min".')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ dateISO, type, bodyParts, exercises, comment, duration }) => {
      const date = dateISO || todayISO();
      if (!isISODate(date)) return text(`"${date}" is not a valid YYYY-MM-DD date.`);
      const now = Date.now();
      const workout: Workout = {
        dateISO: date,
        startedAt: now,
        endedAt: now,
        exercises: exercises.map(
          (ex): Exercise => ({
            name: ex.name.trim(),
            notes: ex.notes || '',
            sets: enforceSingleMax(ex.sets.map(normalizeSet))
          })
        ),
        synced: false,
        editedAt: now // must beat any copy the phone holds, or the merge drops this
      };
      if (type) workout.type = type;
      if (bodyParts?.length) workout.bodyParts = bodyParts;
      if (comment) workout.comment = comment;
      if (duration) workout.duration = duration;

      const state = await mutateState(sb(), session.userId, (s) => {
        s.history = sortHistory([workout, ...s.history]);
      });
      const unit = unitOf(state.profile.unit);
      return text(`Logged.\n\n${detail(workout, unit)}`);
    }
  );

  server.registerTool(
    'update_workout',
    {
      title: 'Edit a logged workout',
      description:
        'Change a workout already in the log. Only the fields you pass are touched; passing exercises replaces the whole exercise list.',
      inputSchema: {
        id: z.number().describe('The workout id from list_workouts.'),
        dateISO: z.string().optional(),
        type: z.enum(WORKOUT_TYPES).optional(),
        bodyParts: z.array(z.enum(BODY_PARTS)).optional(),
        exercises: z.array(exerciseInput).optional().describe('Replaces every exercise on the workout.'),
        comment: z.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ id, dateISO, type, bodyParts, exercises, comment }) => {
      if (dateISO && !isISODate(dateISO)) return text(`"${dateISO}" is not a valid YYYY-MM-DD date.`);
      let found: Workout | undefined;
      const state = await mutateState(sb(), session.userId, (s) => {
        const w = findWorkout(s.history, id);
        if (!w) return;
        if (dateISO) w.dateISO = dateISO;
        if (type) w.type = type;
        if (bodyParts) w.bodyParts = bodyParts;
        if (comment !== undefined) w.comment = comment;
        if (exercises) {
          w.exercises = exercises.map((ex) => ({
            name: ex.name.trim(),
            notes: ex.notes || '',
            sets: enforceSingleMax(ex.sets.map(normalizeSet))
          }));
        }
        w.editedAt = Date.now();
        w.synced = false;
        found = w;
      });
      if (!found) return text(`No workout with id ${id}.`);
      return text(`Updated.\n\n${detail(found, unitOf(state.profile.unit))}`);
    }
  );

  server.registerTool(
    'delete_workout',
    {
      title: 'Delete a workout',
      description:
        'Remove a workout from the log for good. It is tombstoned the same way the app does it, so it will not reappear from another device.',
      inputSchema: { id: z.number().describe('The workout id from list_workouts.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ id }) => {
      let removed: Workout | undefined;
      await mutateState(sb(), session.userId, (s) => {
        const w = findWorkout(s.history, id);
        if (!w) return;
        removed = w;
        s.history = s.history.filter((x) => x !== w);
        const key = workoutKey(w);
        if (!s.deleted.includes(key)) s.deleted = [...s.deleted, key].slice(-500);
      });
      if (!removed) return text(`No workout with id ${id}.`);
      return text(`Deleted the ${removed.dateISO} workout (${removed.exercises.length} exercises).`);
    }
  );

  server.registerTool(
    'log_bodyweight',
    {
      title: 'Log bodyweight',
      description: 'Add a bodyweight entry to the profile trend.',
      inputSchema: {
        weight: z.union([z.number(), z.string()]).describe('In the profile unit.'),
        dateISO: z.string().optional().describe('YYYY-MM-DD. Defaults to today.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ weight, dateISO }) => {
      const date = dateISO || todayISO();
      if (!isISODate(date)) return text(`"${date}" is not a valid YYYY-MM-DD date.`);
      const value = String(weight).trim();
      const state = await mutateState(sb(), session.userId, (s) => {
        const log = Array.isArray(s.profile.bodyweightLog) ? s.profile.bodyweightLog : [];
        s.profile.bodyweightLog = [...log.filter((e) => e.dateISO !== date), { dateISO: date, weight: value }].sort(
          (a, b) => a.dateISO.localeCompare(b.dateISO)
        );
        s.profile.bodyweight = value;
        s.profile.profileUpdatedAt = Date.now(); // profile is last-write-wins on merge
      });
      return text(`Bodyweight ${value} ${unitOf(state.profile.unit)} recorded for ${date}.`);
    }
  );

  return server;
}

export { setVolume };
