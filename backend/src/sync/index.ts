// Runs the connectors: on a timer for every connected workspace, and on request ("Sync now").

import { getState, patchState } from '../connections.ts';
import type { Ctx } from '../context.ts';
import { badRequest, HttpError } from '../errors.ts';
import { pollMailboxes } from '../inbound.ts';
import { syncCalendar } from './calendar.ts';
import { apiFor, SyncError, type SyncResult } from './common.ts';
import { hubspot } from './hubspot.ts';
import { syncLeads } from './leads.ts';
import { salesforce } from './salesforce.ts';

/** Integrations that exchange data, and the least time between two automatic passes of each. */
export const SYNCABLE = ['hs', 'sf', 'gc'] as const;
const EVERY_MS = 5 * 60_000;

async function run(ctx: Ctx, workspaceId: string, id: string): Promise<SyncResult> {
  const api = await apiFor(ctx, workspaceId, id);
  if (!api) throw new SyncError('This integration is not connected.');
  if (id === 'hs') return syncLeads(ctx, workspaceId, api, hubspot);
  if (id === 'sf') return syncLeads(ctx, workspaceId, api, salesforce(ctx.config.env.SALESFORCE_API_VERSION || undefined));
  return syncCalendar(ctx, workspaceId, api);
}

const summary = (id: string, r: SyncResult): string => {
  const what = id === 'gc' ? ['task', 'event'] : ['lead', 'lead'];
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const moved = r.pulled || r.pushed ? `${n(r.pulled, what[0])} updated here, ${n(r.pushed, what[1])} sent` : 'Everything is up to date';
  return [moved, ...r.notes].join(' · ');
};

/** One pass for one connection. The outcome is stored on the connection and returned. */
export async function syncOne(ctx: Ctx, workspaceId: string, id: string): Promise<{ ok: boolean; note: string }> {
  let outcome: { ok: boolean; note: string };
  try {
    outcome = { ok: true, note: summary(id, await run(ctx, workspaceId, id)) };
  } catch (e) {
    if (!(e instanceof SyncError)) console.error(`[sync] ${id} failed:`, e);
    outcome = { ok: false, note: e instanceof SyncError ? e.message : 'The sync stopped because of an unexpected error. It will be tried again.' };
  }
  await patchState(ctx, workspaceId, id, { sync: { at: ctx.now().toISOString(), ...outcome } });
  return outcome;
}

/** "Sync now" from the app. */
export async function syncNow(ctx: Ctx, workspaceId: string, id: string): Promise<{ ok: boolean; note: string }> {
  if (id === 'em') {
    await pollMailboxes(ctx, workspaceId);
    const s = (await getState<{ sync?: { ok: boolean; note: string } }>(ctx, workspaceId, 'em')).sync;
    return s ?? { ok: true, note: 'This mailbox only sends; add an incoming (IMAP) server to receive mail.' };
  }
  if (!(SYNCABLE as readonly string[]).includes(id)) throw badRequest('This integration has nothing to sync.');
  if (!(await ctx.limiter.allow(`sync:${workspaceId}:${id}`, 6, 60))) throw new HttpError(429, 'rate_limited', 'Syncing too often. Wait a minute and try again.');
  return syncOne(ctx, workspaceId, id);
}

/** Background job: every connection that has not synced in the last few minutes. */
export async function syncAll(ctx: Ctx): Promise<number> {
  const due = new Date(ctx.now().getTime() - EVERY_MS).toISOString();
  const rows = (await ctx.db.query(
    `SELECT workspace_id, integration_id FROM integration_connections
     WHERE integration_id = ANY($1) AND (state->'sync'->>'at' IS NULL OR state->'sync'->>'at' < $2) LIMIT 200`, [SYNCABLE, due])).rows;
  for (const r of rows) await syncOne(ctx, r.workspace_id, r.integration_id);
  return rows.length;
}
