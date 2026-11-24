// Client writes. Each change is validated, scoped to the caller's workspace and applied exactly
// once: its id is recorded in the same transaction, so replaying the offline queue is a no-op.
// What a write sets in motion (workflows, delivering a reply) happens after it is committed.

import { z } from 'zod';
import { cleanTags } from '../../../src/lib/csv.ts';
import type { Conversation, Lead, Message, Task } from '../../../src/lib/types.ts';
import { workflowProblem, type WfEvent } from '../../../src/lib/workflow.ts';
import type { Ctx } from '../context.ts';
import { tx, type Q } from '../db.ts';
import { badRequest, conflict } from '../errors.ts';
import type { Auth } from '../license/service.ts';
import { sendReply } from '../messaging.ts';
import { decideRun, emit, startRun } from './automation.ts';
import { PROVIDERS } from './snapshot.ts';
import { saveConversation, saveLead, saveTask, upsert } from './store.ts';

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);
const opt = (max: number) => z.string().trim().max(max).nullable().transform((v) => v || null);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

const ChangeEnvelope = z.object({
  id, entity: z.string().max(40), op: z.enum(['upsert', 'delete']), entityId: z.string().max(64),
  data: z.unknown().optional(), at: z.string().optional(),
});

/** Step types a workflow may contain. Nothing here performs an action LinkedIn does not permit. */
const StepType = z.enum(['Trigger', 'Condition', 'Action', 'Delay', 'Approval', 'Notification', 'Update', 'Stop']);
const Provider = z.enum(PROVIDERS as [string, ...string[]]);
const Msg = z.object({
  me: z.boolean(), text: text(10_000), at: z.string().max(40), queued: z.boolean().optional(),
  id: z.string().max(200).optional(), status: z.enum(['sent', 'failed', 'saved']).optional(), error: text(500).optional(),
});

const Schemas = {
  prompt: z.object({ id, title: text(200).min(1), text: text(4000).min(1) }),
  post: z.object({
    id, title: text(500).min(1), body: text(20_000),
    status: z.enum(['Draft', 'In review', 'Approved', 'Scheduled', 'Published']),
    date: day,
  }),
  lead: z.object({
    id, name: z.string().trim().min(1, 'A lead needs a name.').max(300), company: z.string().trim().min(1, 'A lead needs a company.').max(300),
    title: opt(300), industry: opt(300), size: z.number().int().positive().max(10_000_000).nullable(), country: opt(300),
    email: opt(320).refine((v) => !v || /^\S+@\S+\.\S+$/.test(v), 'Enter a valid email address.'),
    phone: opt(40).refine((v) => !v || /^\+?[\d\s().-]{6,}$/.test(v), 'Enter the phone number with its country code.'),
    linkedin: opt(300).refine((v) => !v || /^https:\/\/([a-z]+\.)?linkedin\.com\//i.test(v), 'Enter a linkedin.com address.'),
    stage: z.enum(['new', 'contacted', 'interested', 'converted', 'lost']),
    tags: z.array(text(40)).max(50).transform(cleanTags),
    notes: z.array(z.object({ text: text(2000).min(1), at: z.string().max(40) })).max(200),
    campaignId: id.nullable(),
    createdAt: z.string().max(40).optional(),
  }),
  campaign: z.object({
    id, name: z.string().trim().min(1, 'A campaign needs a name.').max(200), goal: text(1000), channel: text(60),
    status: z.enum(['Draft', 'Active', 'Paused', 'Completed']), startDate: day, endDate: day,
  }),
  conversation: z.object({
    id, name: text(200), company: text(200), channel: text(60), unread: z.boolean(), important: z.boolean(),
    address: z.string().trim().max(320).nullable().optional(), leadId: id.nullable().optional(),
    intent: text(200), sentiment: text(60), suggestion: text(4000),
    msgs: z.array(Msg).max(2000),
    notes: z.array(text(2000)).max(500),
  }),
  /** A reply to deliver through the conversation's channel. `id` is the message id. */
  message: z.object({ id, conversationId: id, text: z.string().trim().min(1, 'Write a reply first.').max(10_000), at: z.string().max(40).optional() }),
  workflow: z.object({
    id, name: text(200), on: z.boolean(),
    steps: z.array(z.object({ type: StepType, label: text(300), kind: z.string().max(40).optional(), config: z.record(z.string().max(40), z.string().max(300)).optional() })).min(1).max(50),
  }),
  run: z.object({
    id, workflowId: id, status: z.string().max(40).optional(), test: z.boolean().optional(),
    subject: z.object({ leadId: z.string().max(64).optional() }).optional(),
  }),
  task: z.object({ id, text: text(500).min(1), due: text(40), dueDate: day.optional(), leadId: id.nullable().optional(), done: z.boolean() }),
  activity: z.object({ id, text: text(500).min(1), at: z.string().max(40) }),
  profile: z.object({ name: text(200).min(1), email: z.string().max(320).regex(/^\S+@\S+\.\S+$/, 'Enter a valid email address.'), workspace: text(200).min(1) }),
  icp: z.object({ industry: text(200), title: text(400), sizeMin: text(12), sizeMax: text(12), location: text(200) }),
  routing: z.object({ 'Content generation': Provider, 'Lead research': Provider, 'Reply suggestions': Provider }),
  openrouter: z.object({ defaultModel: text(200), fallbackModel: text(200), monthlyBudgetUsd: text(12).regex(/^\d*\.?\d*$/, 'Enter a number.') }),
  sync: z.object({
    region: text(60), endpoint: z.string().max(300).regex(/^(https:\/\/[^\s/]+\.[^\s]+)?$/, 'Enter a full https:// address.'),
    offlineCache: z.boolean(), conflict: z.enum(['ask', 'latest', 'cloud']), lastBackupAt: z.string().optional(),
  }),
  security: z.object({ mfa: z.boolean() }),
} as const;

type Entity = keyof typeof Schemas;
const DELETABLE: Partial<Record<Entity, string>> = { prompt: 'prompts', post: 'posts', workflow: 'workflows', task: 'tasks', lead: 'leads', campaign: 'campaigns' };

/** What a committed change still has to set in motion. */
interface After {
  events: WfEvent[];
  startRun?: { id: string; workflowId: string; test?: boolean; subject?: { leadId?: string } };
  decideRun?: { id: string; approve: boolean };
  send?: { id: string; conversationId: string; text: string; at?: string };
}

const j = (v: unknown) => JSON.stringify(v);
const when = (s: string, fallback: Date) => { const t = Date.parse(s); return Number.isNaN(t) ? fallback : new Date(t); };
const sameMsg = (a: Message, b: Message) => (a.id && b.id ? a.id === b.id : a.me === b.me && a.at === b.at && a.text === b.text);

async function applyOne(ctx: Ctx, q: Q, auth: Auth, raw: unknown): Promise<After | null> {
  const env = ChangeEnvelope.safeParse(raw);
  if (!env.success) throw badRequest('Malformed change.');
  const c = env.data;
  const w = auth.workspaceId;
  const now = ctx.now();
  const after: After = { events: [] };

  // Idempotency: first writer wins; a replay inserts nothing and stops here.
  const first = await q.query('INSERT INTO applied_changes (workspace_id, change_id, applied_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [w, c.id, now]);
  if (first.rowCount === 0) return null;

  if (!(c.entity in Schemas)) throw badRequest(`Unknown entity "${c.entity}".`);
  const entity = c.entity as Entity;

  if (c.op === 'delete') {
    const table = DELETABLE[entity];
    if (!table || !z.string().uuid().safeParse(c.entityId).success) throw badRequest(`"${c.entity}" cannot be deleted.`);
    await q.query(`DELETE FROM ${table} WHERE id = $1 AND workspace_id = $2`, [c.entityId, w]);
    return after;
  }

  const parsed = Schemas[entity].safeParse(c.data);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid data.', 'invalid_data');
  const d = parsed.data as never;
  if ('id' in (parsed.data as object) && (parsed.data as { id: string }).id !== c.entityId) throw badRequest('Change id and record id differ.');

  switch (entity) {
    case 'prompt': { const p = d as z.infer<typeof Schemas.prompt>; await upsert(q, 'prompts', w, p.id, { title: p.title, text: p.text }); break; }
    case 'post': {
      const p = d as z.infer<typeof Schemas.post>;
      const before = (await q.query('SELECT status FROM posts WHERE id = $1 AND workspace_id = $2', [p.id, w])).rows[0];
      await upsert(q, 'posts', w, p.id, { title: p.title, body: p.body, status: p.status, date: p.date });
      if (before && before.status !== p.status) after.events.push({ kind: 'post.status_changed', postId: p.id, to: p.status, label: p.title });
      break;
    }
    case 'lead': {
      const l = d as z.infer<typeof Schemas.lead>;
      const { previous } = await saveLead(q, w, { ...l, createdAt: now.toISOString() } as Lead, now);
      if (previous === null) after.events.push({ kind: 'lead.created', leadId: l.id, label: l.name });
      else if (previous !== l.stage) after.events.push({ kind: 'lead.stage_changed', leadId: l.id, to: l.stage, label: l.name });
      break;
    }
    case 'campaign': {
      const p = d as z.infer<typeof Schemas.campaign>;
      if (p.startDate && p.endDate && p.endDate < p.startDate) throw badRequest('The end date is before the start date.', 'invalid_data');
      await upsert(q, 'campaigns', w, p.id, { name: p.name, goal: p.goal, channel: p.channel, status: p.status, start_date: p.startDate, end_date: p.endDate });
      break;
    }
    case 'task': { await saveTask(q, w, d as Task, now); break; }
    case 'activity': { const a = d as z.infer<typeof Schemas.activity>; await upsert(q, 'activity', w, a.id, { text: a.text, at: when(a.at, now) }); break; }
    case 'workflow': {
      const f = d as z.infer<typeof Schemas.workflow>;
      const problem = workflowProblem(f.steps);
      if (problem) throw badRequest(problem, 'invalid_workflow');
      await upsert(q, 'workflows', w, f.id, { name: f.name, enabled: f.on, steps: j(f.steps) });
      break;
    }
    case 'conversation': {
      const v = d as z.infer<typeof Schemas.conversation>;
      // The server may have added messages (incoming mail, a delivered reply) since the client
      // loaded its copy, so messages are merged, never replaced.
      const stored = (await q.query('SELECT msgs FROM conversations WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [v.id, w])).rows[0];
      const have = (stored?.msgs ?? []) as Message[];
      const added = (v.msgs as Message[]).filter((m) => !have.some((x) => sameMsg(x, m)));
      const msgs = [...have, ...added].sort((a, b) => a.at.localeCompare(b.at));
      await saveConversation(q, w, { ...v, msgs } as Conversation, now);
      break;
    }
    case 'message': {
      const m = d as z.infer<typeof Schemas.message>;
      const exists = await q.query('SELECT 1 FROM conversations WHERE id = $1 AND workspace_id = $2', [m.conversationId, w]);
      if (!exists.rowCount) throw badRequest('That conversation does not exist.');
      after.send = { id: m.id, conversationId: m.conversationId, text: m.text, at: m.at };
      break;
    }
    case 'run': {
      const r = d as z.infer<typeof Schemas.run>;
      const existing = (await q.query('SELECT status FROM runs WHERE id = $1', [r.id])).rows[0];
      if (!existing) after.startRun = { id: r.id, workflowId: r.workflowId, test: r.test, subject: r.subject };
      else if (r.status === 'Completed' || r.status === 'Rejected') after.decideRun = { id: r.id, approve: r.status === 'Completed' };
      break;
    }
    case 'profile': {
      const p = d as z.infer<typeof Schemas.profile>;
      const taken = await q.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [p.email, auth.userId]);
      if (taken.rowCount) throw conflict('That email address is already in use.');
      await q.query('UPDATE users SET name = $1, email = $2 WHERE id = $3 AND workspace_id = $4', [p.name, p.email, auth.userId, w]);
      await q.query('UPDATE workspaces SET name = $1 WHERE id = $2', [p.workspace, w]);
      break;
    }
    case 'icp': await q.query('UPDATE workspaces SET icp = $1 WHERE id = $2', [j(d), w]); break;
    case 'routing': await q.query('UPDATE workspaces SET routing = $1 WHERE id = $2', [j(d), w]); break;
    case 'openrouter': await q.query('UPDATE workspaces SET openrouter = $1 WHERE id = $2', [j(d), w]); break;
    case 'sync': {
      const { lastBackupAt: _ignored, ...s } = d as z.infer<typeof Schemas.sync>;
      await q.query('UPDATE workspaces SET sync = $1 WHERE id = $2', [j(s), w]);
      break;
    }
    case 'security': await q.query('UPDATE workspaces SET mfa = $1 WHERE id = $2', [(d as z.infer<typeof Schemas.security>).mfa, w]); break;
  }
  return after;
}

/**
 * Applies one change in its own transaction, then carries out what follows from it. Returns
 * `effects: true` when the server changed more than the client asked for (a workflow ran, a
 * reply was delivered), so the client knows to reload.
 */
export async function applyChange(ctx: Ctx, auth: Auth, raw: unknown): Promise<{ effects: boolean }> {
  const after = await tx(ctx.db, (q) => applyOne(ctx, q, auth, raw));
  if (!after) return { effects: false };
  let effects = false;
  if (after.send) { await sendReply(ctx, auth.workspaceId, after.send.conversationId, after.send.text, after.send.id, after.send.at); effects = true; }
  if (after.startRun) { await startRun(ctx, auth, after.startRun); effects = true; }
  if (after.decideRun) { await decideRun(ctx, auth, after.decideRun.id, after.decideRun.approve); effects = true; }
  if ((await emit(ctx, auth, after.events)) > 0) effects = true;
  return { effects };
}
