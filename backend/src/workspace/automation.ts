// Runs workflows on the server: when something happens (an event), when a delay ends, when a
// run is approved, and on a schedule. The engine itself is shared with the app (src/lib/workflow.ts).

import { randomUUID } from 'node:crypto';
import type { Run, RunSubject, Workflow } from '../../../src/lib/types.ts';
import {
  advance, dispatch, newRun, resume, scheduleDue, workflowProblem, type Dispatcher, type WfEvent, type WorkflowHost,
} from '../../../src/lib/workflow.ts';
import { draftMessage } from '../ai/gateway.ts';
import type { Ctx } from '../context.ts';
import { tx } from '../db.ts';
import { badRequest, HttpError } from '../errors.ts';
import { sendReply } from '../messaging.ts';
import { sendWebhook } from '../webhooks.ts';
import * as store from './store.ts';

/** Who the engine acts for: a workspace, and the license its AI usage is recorded against (none for background work). */
export interface Scope { workspaceId: string; licenseId: string | null }

function hostFor(ctx: Ctx, scope: Scope): WorkflowHost {
  const w = scope.workspaceId;
  return {
    now: () => ctx.now(),
    newId: () => randomUUID(),
    icp: async () => (await ctx.db.query('SELECT icp FROM workspaces WHERE id = $1', [w])).rows[0].icp,
    lead: (id) => store.getLead(ctx.db, w, id),
    saveLead: async (lead) => { await tx(ctx.db, (q) => store.saveLead(q, w, lead, ctx.now())); },
    conversation: (id) => store.getConversation(ctx.db, w, id),
    conversationForLead: (id) => store.conversationForLead(ctx.db, w, id),
    saveConversation: (c) => tx(ctx.db, (q) => store.saveConversation(q, w, c, ctx.now())),
    post: (id) => store.getPost(ctx.db, w, id),
    addTask: (t) => store.saveTask(ctx.db, w, t, ctx.now()),
    notify: async (text, email) => {
      await ctx.db.query('INSERT INTO activity (id, workspace_id, text, at) VALUES ($1, $2, $3, $4)', [randomUUID(), w, text.slice(0, 500), ctx.now()]);
      if (!email) return;
      const owner = (await ctx.db.query(
        'SELECT u.email, ws.name FROM workspaces ws JOIN licenses l ON l.workspace_id = ws.id JOIN users u ON u.id = l.owner_user_id WHERE ws.id = $1 ORDER BY l.created_at LIMIT 1', [w])).rows[0];
      if (owner) await ctx.mail({ to: owner.email, subject: `Nexora AI · ${owner.name}`, text: `${text}\n\nSent by a workflow in your Nexora AI workspace “${owner.name}”.` });
    },
    draft: async (lead) => (await draftMessage(ctx, scope, lead.id)).text,
    send: (conversation, text) => sendReply(ctx, w, conversation.id, text, randomUUID()),
    webhook: (event, payload) => sendWebhook(ctx, w, event, payload),
  };
}

function dispatcherFor(ctx: Ctx, scope: Scope): Dispatcher {
  const w = scope.workspaceId;
  return {
    host: hostFor(ctx, scope),
    workflows: () => store.loadWorkflows(ctx.db, w),
    mayRun: async () => {
      const lim = (await ctx.db.query('SELECT automation_daily_run_limit AS lim FROM workspaces WHERE id = $1', [w])).rows[0]?.lim ?? 0;
      const n = (await ctx.db.query('SELECT count(*)::int AS n FROM runs WHERE workspace_id = $1 AND at >= $2 AND NOT test', [w, new Date(ctx.now().getTime() - 86_400_000)])).rows[0].n;
      return n < lim;
    },
    saveRun: (run) => store.saveRun(ctx.db, w, run),
  };
}

/** Starts the workflows these events trigger. A failure here never fails the request that caused the event. */
export async function emit(ctx: Ctx, scope: Scope, events: WfEvent[]): Promise<number> {
  if (!events.length) return 0;
  try {
    return (await dispatch(events, dispatcherFor(ctx, scope))).length;
  } catch (e) {
    console.error('[automation] dispatch failed:', e);
    return 0;
  }
}

/**
 * A run asked for by a person: a test run (reports what each step would do, changes nothing) or
 * "Run now". Both may name the lead the run is about.
 */
export async function startRun(ctx: Ctx, scope: Scope, data: { id: string; workflowId: string; test?: boolean; subject?: RunSubject }): Promise<Run> {
  const w = scope.workspaceId;
  const d = dispatcherFor(ctx, scope);
  const wf = (await d.workflows()).find((f) => f.id === data.workflowId);
  if (!wf) throw badRequest('That workflow does not exist.');
  const problem = workflowProblem(wf.steps);
  if (problem) throw badRequest(problem, 'invalid_workflow');
  if (wf.steps.length < 2) throw badRequest('Add at least one step after the trigger.', 'invalid_workflow');
  if (!data.test && !(await d.mayRun())) {
    const lim = (await ctx.db.query('SELECT automation_daily_run_limit AS lim FROM workspaces WHERE id = $1', [w])).rows[0].lim;
    throw new HttpError(429, 'run_limit', `The daily limit of ${lim} runs has been reached.`);
  }
  const lead = data.subject?.leadId ? await store.getLead(ctx.db, w, data.subject.leadId) : null;
  const subject: RunSubject = lead ? { leadId: lead.id, label: lead.name } : {};
  const out = await advance(newRun(data.id, wf, subject, ctx.now(), { test: data.test }), wf, d.host);
  await d.saveRun(out.run);
  if (out.events.length) await dispatch(out.events, d);
  return out.run;
}

/** Approves or rejects a run that is waiting for approval. Anything else is left as it is. */
export async function decideRun(ctx: Ctx, scope: Scope, runId: string, approve: boolean): Promise<void> {
  const w = scope.workspaceId;
  // Claim the run first, so two approvals (or an approval and a rejection) cannot both act.
  const claimed = await ctx.db.query(
    "UPDATE runs SET status = $3 WHERE id::text = $1 AND workspace_id = $2 AND status = 'Awaiting approval' RETURNING id",
    [runId, w, approve ? 'Waiting' : 'Rejected']);
  if (!claimed.rowCount || !approve) return;
  const run = await store.getRun(ctx.db, w, runId);
  if (!run) return;
  const at = ctx.now().toISOString();
  await resume({ ...run, log: [...(run.log ?? []), { step: run.cursor ?? 1, text: 'Approved', ok: true, at }] }, dispatcherFor(ctx, scope));
}

/** Background pass: continues runs whose delay has ended and fires schedule triggers that are due. */
export async function tick(ctx: Ctx): Promise<{ resumed: number; scheduled: number }> {
  const now = ctx.now();
  let resumed = 0, scheduled = 0;

  // Claim each due run by clearing its resume time, so two workers never continue the same run.
  const due = (await ctx.db.query(
    `UPDATE runs SET resume_at = NULL WHERE id IN (SELECT id FROM runs WHERE status = 'Waiting' AND resume_at <= $1 ORDER BY resume_at LIMIT 200 FOR UPDATE SKIP LOCKED)
     RETURNING id, workspace_id`, [now])).rows;
  for (const r of due) {
    try {
      const run = await store.getRun(ctx.db, r.workspace_id, r.id);
      if (run) { await resume(run, dispatcherFor(ctx, { workspaceId: r.workspace_id, licenseId: null })); resumed++; }
    } catch (e) {
      console.error('[automation] resume failed:', e);
    }
  }

  const rows = (await ctx.db.query("SELECT id, workspace_id, name, enabled, steps, last_scheduled_day FROM workflows WHERE enabled AND steps->0->>'kind' = 'schedule'")).rows;
  for (const row of rows) {
    const wf: Workflow = { id: row.id, name: row.name, on: row.enabled, steps: row.steps };
    const day = scheduleDue(wf, now, row.last_scheduled_day);
    if (!day || workflowProblem(wf.steps)) continue;
    // Record the day first: if two workers race, only one UPDATE changes the row.
    const mine = await ctx.db.query('UPDATE workflows SET last_scheduled_day = $2 WHERE id = $1 AND last_scheduled_day IS DISTINCT FROM $2', [wf.id, day]);
    if (!mine.rowCount) continue;
    const scope: Scope = { workspaceId: row.workspace_id, licenseId: null };
    const d = dispatcherFor(ctx, scope);
    try {
      const each = wf.steps[0].config?.each;
      const subjects: RunSubject[] = each
        ? (await store.loadLeads(ctx.db, scope.workspaceId)).filter((l) => l.stage === each).slice(0, 200).map((l) => ({ leadId: l.id, label: l.name }))
        : [{}];
      for (const subject of subjects) {
        if (!(await d.mayRun())) break;
        const out = await advance(newRun(randomUUID(), wf, subject, now), wf, d.host);
        await d.saveRun(out.run);
        if (out.events.length) await dispatch(out.events, d);
        scheduled++;
      }
    } catch (e) {
      console.error('[automation] schedule failed:', e);
    }
  }
  return { resumed, scheduled };
}
