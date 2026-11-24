// Tasks with a due date ↔ all-day events in the user's primary Google Calendar.
// An open task gets an event on its due day. Moving the event moves the task; finishing or
// deleting the task removes the event; deleting the event unlinks it and leaves the task alone.

import { getState, patchState } from '../connections.ts';
import type { Ctx } from '../context.ts';
import { emptyResult, SyncError, type Api, type SyncResult } from './common.ts';

const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const PER_PASS = 50;
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

interface State extends Record<string, unknown> { since?: string }
const fail = (what: string, r: { status: number; json: any }): never => {
  throw new SyncError(`Google Calendar could not ${what} (${r.status}${typeof r.json?.error?.message === 'string' ? `: ${r.json.error.message.slice(0, 160)}` : ''}).`);
};

export async function syncCalendar(ctx: Ctx, workspaceId: string, api: Api): Promise<SyncResult> {
  const result = emptyResult();
  const w = workspaceId;
  const state = await getState<State>(ctx, w, 'gc');
  const started = ctx.now().toISOString();

  // ── from the calendar: events of ours that were moved or deleted ──
  if (state.since) {
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ updatedMin: state.since, showDeleted: 'true', singleEvents: 'true', maxResults: '250', ...(pageToken ? { pageToken } : {}) });
      const r = await api.call(`${EVENTS}?${q}`);
      if (r.status === 410) break; // the window is too old for Google; the push below brings everything back in line
      if (!r.ok) fail('list events', r);
      for (const ev of Array.isArray(r.json?.items) ? r.json.items : []) {
        const taskId = ev?.extendedProperties?.private?.nexoraTask;
        if (typeof taskId !== 'string') continue;
        const task = (await ctx.db.query('SELECT id, due_date, external FROM tasks WHERE id::text = $1 AND workspace_id = $2', [taskId, w])).rows[0];
        if (!task || task.external?.gc !== ev.id) continue;
        if (ev.status === 'cancelled') {
          await ctx.db.query(`UPDATE tasks SET external = (external - 'gc') || '{"gcOff": true}' WHERE id = $1 AND workspace_id = $2`, [task.id, w]);
        } else if (typeof ev.start?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.start.date) && ev.start.date !== task.due_date) {
          const at = ctx.now();
          await ctx.db.query('UPDATE tasks SET due_date = $3, updated_at = $4, external = external || $5::jsonb WHERE id = $1 AND workspace_id = $2', [task.id, w, ev.start.date, at, JSON.stringify({ gcAt: at.toISOString() })]);
          result.pulled++;
        }
      }
      pageToken = typeof r.json?.nextPageToken === 'string' ? r.json.nextPageToken : undefined;
      if (!pageToken) break;
    }
  }

  // ── to the calendar: tasks that are new, changed, finished or lost their date ──
  const rows = (await ctx.db.query(
    `SELECT id, text, due_date, done, external FROM tasks
     WHERE workspace_id = $1 AND NOT coalesce((external->>'gcOff')::boolean, false)
       AND ((external->>'gc' IS NULL AND due_date IS NOT NULL AND NOT done) OR (external->>'gc' IS NOT NULL AND updated_at > (external->>'gcAt')::timestamptz))
     ORDER BY updated_at LIMIT $2`, [w, PER_PASS])).rows;
  for (const t of rows) {
    const eventId = t.external?.gc as string | undefined;
    const at = ctx.now().toISOString();
    if (eventId && (t.done || !t.due_date)) {
      const r = await api.call(`${EVENTS}/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404 && r.status !== 410) fail('remove an event', r);
      await ctx.db.query("UPDATE tasks SET external = external - 'gc' - 'gcAt' WHERE id = $1 AND workspace_id = $2", [t.id, w]);
      result.pushed++;
      continue;
    }
    const body = { summary: t.text, start: { date: t.due_date }, end: { date: nextDay(t.due_date) }, extendedProperties: { private: { nexoraTask: t.id } } };
    let id = eventId;
    if (id) {
      const r = await api.call(`${EVENTS}/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      if (r.status === 404 || r.status === 410) id = undefined; else if (!r.ok) fail('update an event', r);
    }
    if (!id) {
      const r = await api.call(EVENTS, { method: 'POST', body });
      if (!r.ok || typeof r.json?.id !== 'string') fail('add an event', r);
      id = r.json.id as string;
    }
    await ctx.db.query('UPDATE tasks SET external = external || $3::jsonb WHERE id = $1 AND workspace_id = $2', [t.id, w, JSON.stringify({ gc: id, gcAt: at })]);
    result.pushed++;
  }
  await patchState(ctx, w, 'gc', { since: started });
  return result;
}
