// Two-way lead sync with a CRM. The CRM-specific parts (how to list, create and update a
// record) are an adapter; the rules for matching, conflicts and avoiding echo are here.
//
// Matching: by the CRM's id once linked, otherwise by email address.
// A lead changed on one side only is copied to the other. When both sides changed since the last
// sync, the workspace's conflict rule decides: "latest" lets the newer edit win, "cloud" keeps
// Nexora AI's version, and "ask" keeps Nexora AI's version and reports the difference.
// An empty value in the CRM never erases a value in Nexora AI.

import { randomUUID } from 'node:crypto';
import { newLead, type ConflictRule, type Lead, type LeadStage } from '../../../src/lib/types.ts';
import type { WfEvent } from '../../../src/lib/workflow.ts';
import { getState, patchState } from '../connections.ts';
import type { Ctx } from '../context.ts';
import { tx } from '../db.ts';
import { emit } from '../workspace/automation.ts';
import { getLead, saveLead } from '../workspace/store.ts';
import { emptyResult, type Api, type SyncResult } from './common.ts';

export interface RemoteLead {
  id: string;
  modifiedAt: string;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  industry: string | null;
  country: string | null;
  size: number | null;
  stage: LeadStage | null;
}

export interface CrmAdapter {
  id: string;
  name: string;
  /** Records changed after `since`, oldest first. `cursor` continues a listing; `next` is null on the last page. */
  pull(api: Api, since: string, cursor: string | null): Promise<{ records: RemoteLead[]; next: string | null }>;
  /** Why this lead cannot be sent to the CRM, or null. */
  blocked(lead: Lead): string | null;
  /** Creates the record. When the CRM already has it, returns that record's id instead. */
  create(api: Api, lead: Lead): Promise<string>;
  /** Updates the record. Returns false when it no longer exists there. */
  update(api: Api, remoteId: string, lead: Lead): Promise<boolean>;
}

const PAGES_PER_PASS = 5;
const PUSHES_PER_PASS = 50;
const FIELDS = ['name', 'title', 'company', 'email', 'phone', 'industry', 'country', 'size', 'stage'] as const;

interface State extends Record<string, unknown> { since?: string; cursor?: string | null }

export async function syncLeads(ctx: Ctx, workspaceId: string, api: Api, a: CrmAdapter): Promise<SyncResult> {
  const result = emptyResult();
  const events: WfEvent[] = [];
  const w = workspaceId;
  const atKey = `${a.id}At`;
  const rule = ((await ctx.db.query("SELECT sync->>'conflict' AS c FROM workspaces WHERE id = $1", [w])).rows[0]?.c ?? 'ask') as ConflictRule;
  const state = await getState<State>(ctx, w, a.id);
  let since = state.since ?? '1970-01-01T00:00:00.000Z';
  let cursor = state.cursor ?? null;
  let conflicts = 0;

  // ── from the CRM ──
  for (let page = 0; page < PAGES_PER_PASS; page++) {
    const { records, next } = await a.pull(api, since, cursor);
    for (const r of records) {
      const now = ctx.now();
      await tx(ctx.db, async (q) => {
        const row = (await q.query(
          `SELECT id, updated_at, external FROM leads WHERE workspace_id = $1 AND (external->>$2 = $3 OR ($4::text IS NOT NULL AND lower(email) = lower($4) AND external->>$2 IS NULL))
           ORDER BY (external->>$2 = $3) DESC, created_at LIMIT 1 FOR UPDATE`, [w, a.id, r.id, r.email])).rows[0];
        const stamp = { [a.id]: r.id, [atKey]: now.toISOString() };
        if (!row) {
          if (!r.name) return;
          const lead = newLead(randomUUID(), r.name, r.company ?? r.email?.split('@')[1] ?? '—', now.toISOString(), {
            title: r.title, email: r.email, phone: r.phone, industry: r.industry, country: r.country, size: r.size, stage: r.stage ?? 'new' });
          await saveLead(q, w, lead, now);
          await q.query('UPDATE leads SET external = external || $3::jsonb WHERE id = $1 AND workspace_id = $2', [lead.id, w, JSON.stringify(stamp)]);
          events.push({ kind: 'lead.created', leadId: lead.id, label: lead.name });
          result.pulled++;
          return;
        }
        const local = (await getLead(q, w, row.id))!;
        const syncedAt = Date.parse(row.external[atKey] ?? '') || 0;
        const localChanged = new Date(row.updated_at).getTime() > syncedAt;
        const remoteChanged = Date.parse(r.modifiedAt) > syncedAt;
        const patch: Partial<Lead> = {};
        for (const f of FIELDS) {
          const v = r[f];
          const have = local[f];
          // An email address that differs only in capitals is the same address.
          const same = f === 'email' ? String(v ?? '').toLowerCase() === String(have ?? '').toLowerCase() : v === have;
          if (v !== null && v !== '' && !same) (patch as Record<string, unknown>)[f] = v;
        }
        const differs = Object.keys(patch).length > 0;
        let take = differs && remoteChanged;
        if (take && localChanged && row.external[a.id]) {
          if (rule === 'latest') take = Date.parse(r.modifiedAt) > new Date(row.updated_at).getTime();
          else { take = false; if (rule === 'ask') conflicts++; }
        }
        if (take) {
          await saveLead(q, w, { ...local, ...patch }, now);
          if (patch.stage) events.push({ kind: 'lead.stage_changed', leadId: local.id, to: patch.stage, label: local.name });
          result.pulled++;
          await q.query('UPDATE leads SET external = external || $3::jsonb WHERE id = $1 AND workspace_id = $2', [local.id, w, JSON.stringify(stamp)]);
        } else {
          // Link the record. Leave the sync time alone when Nexora AI's version still has to go out.
          const link = differs || localChanged ? { [a.id]: r.id } : stamp;
          await q.query('UPDATE leads SET external = external || $3::jsonb WHERE id = $1 AND workspace_id = $2', [local.id, w, JSON.stringify(link)]);
        }
      });
      if (r.modifiedAt > since) since = r.modifiedAt;
    }
    cursor = next;
    if (!next) break;
  }
  await patchState(ctx, w, a.id, { since: cursor ? state.since ?? '1970-01-01T00:00:00.000Z' : since, cursor });

  // ── to the CRM ──
  const out = (await ctx.db.query(
    `SELECT id, external FROM leads WHERE workspace_id = $1 AND (external->>$2 IS NULL OR updated_at > (external->>$3)::timestamptz OR external->>$3 IS NULL)
     ORDER BY updated_at LIMIT $4`, [w, a.id, atKey, PUSHES_PER_PASS + 200])).rows;
  let blocked = 0;
  let why = '';
  for (const row of out) {
    if (result.pushed >= PUSHES_PER_PASS) { result.notes.push('More leads will be sent on the next sync'); break; }
    const lead = await getLead(ctx.db, w, row.id);
    if (!lead) continue;
    const reason = a.blocked(lead);
    if (reason) { blocked++; why = reason; continue; }
    const at = ctx.now().toISOString();
    let remoteId = row.external[a.id] as string | undefined;
    if (remoteId && !(await a.update(api, remoteId, lead))) remoteId = undefined; // deleted there: create it again
    if (!remoteId) remoteId = await a.create(api, lead);
    await ctx.db.query('UPDATE leads SET external = external || $3::jsonb WHERE id = $1 AND workspace_id = $2', [lead.id, w, JSON.stringify({ [a.id]: remoteId, [atKey]: at })]);
    result.pushed++;
  }
  if (blocked) result.notes.push(`${blocked} lead${blocked === 1 ? '' : 's'} not sent (${why})`);
  if (conflicts) result.notes.push(`${conflicts} lead${conflicts === 1 ? ' was' : 's were'} changed on both sides; Nexora AI’s version was kept`);
  await emit(ctx, { workspaceId: w, licenseId: null }, events);
  return result;
}
