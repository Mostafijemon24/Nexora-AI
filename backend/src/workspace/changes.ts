// Client writes. Each change is validated, scoped to the caller's workspace and applied exactly
// once: its id is recorded in the same transaction, so replaying the offline queue is a no-op.

import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { tx, type Q } from '../db.ts';
import { badRequest, conflict, HttpError } from '../errors.ts';
import type { Auth } from '../license/service.ts';
import { PROVIDERS } from './snapshot.ts';

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);

const ChangeEnvelope = z.object({
  id, entity: z.string().max(40), op: z.enum(['upsert', 'delete']), entityId: z.string().max(64),
  data: z.unknown().optional(), at: z.string().optional(),
});

/** Step types a workflow may contain. Nothing here performs an action LinkedIn does not permit. */
const StepType = z.enum(['Trigger', 'Condition', 'Action', 'Delay', 'Approval', 'Notification', 'Update', 'Stop']);
const Provider = z.enum(PROVIDERS as [string, ...string[]]);

const Schemas = {
  prompt: z.object({ id, title: text(200).min(1), text: text(4000).min(1) }),
  post: z.object({
    id, title: text(500).min(1), body: text(20_000),
    status: z.enum(['Draft', 'In review', 'Approved', 'Scheduled', 'Published']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  }),
  conversation: z.object({
    id, name: text(200), company: text(200), channel: text(60), unread: z.boolean(), important: z.boolean(),
    intent: text(200), sentiment: text(60), suggestion: text(4000),
    msgs: z.array(z.object({ me: z.boolean(), text: text(10_000), at: z.string().max(40), queued: z.boolean().optional() })).max(2000),
    notes: z.array(text(2000)).max(500),
  }),
  workflow: z.object({
    id, name: text(200), on: z.boolean(),
    steps: z.array(z.object({ type: StepType, label: text(300) })).min(1).max(50)
      .refine((s) => s[0].type === 'Trigger' && s.slice(1).every((x) => x.type !== 'Trigger'), 'A workflow starts with exactly one trigger.'),
  }),
  run: z.object({ id, workflowId: id, name: text(200), steps: z.number().int().min(1).max(50), status: z.enum(['Completed', 'Awaiting approval']), at: z.string().max(40) }),
  task: z.object({ id, text: text(500).min(1), due: text(40), done: z.boolean() }),
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
const DELETABLE: Partial<Record<Entity, string>> = { prompt: 'prompts', post: 'posts', workflow: 'workflows', task: 'tasks' };

/**
 * Insert-or-update by primary key that can only ever touch the caller's own rows.
 * If the id already belongs to another workspace the UPDATE matches nothing and the write is refused.
 */
async function upsert(q: Q, table: string, w: string, rowId: string, cols: Record<string, unknown>) {
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  const sql = `INSERT INTO ${table} (id, workspace_id, ${names.join(', ')}) VALUES ($1, $2, ${names.map((_, i) => `$${i + 3}`).join(', ')})
    ON CONFLICT (id) DO UPDATE SET ${names.map((n) => `${n} = EXCLUDED.${n}`).join(', ')} WHERE ${table}.workspace_id = $2`;
  const r = await q.query(sql, [rowId, w, ...vals]);
  if (r.rowCount !== 1) throw conflict('That record belongs to another workspace.', 'forbidden_record');
}

const j = (v: unknown) => JSON.stringify(v);
const when = (s: string, fallback: Date) => { const t = Date.parse(s); return Number.isNaN(t) ? fallback : new Date(t); };

async function applyOne(ctx: Ctx, q: Q, auth: Auth, raw: unknown): Promise<void> {
  const env = ChangeEnvelope.safeParse(raw);
  if (!env.success) throw badRequest('Malformed change.');
  const c = env.data;
  const w = auth.workspaceId;
  const now = ctx.now();

  // Idempotency: first writer wins; a replay inserts nothing and stops here.
  const first = await q.query('INSERT INTO applied_changes (workspace_id, change_id, applied_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [w, c.id, now]);
  if (first.rowCount === 0) return;

  if (!(c.entity in Schemas)) throw badRequest(`Unknown entity "${c.entity}".`);
  const entity = c.entity as Entity;

  if (c.op === 'delete') {
    const table = DELETABLE[entity];
    if (!table || !z.string().uuid().safeParse(c.entityId).success) throw badRequest(`"${c.entity}" cannot be deleted.`);
    await q.query(`DELETE FROM ${table} WHERE id = $1 AND workspace_id = $2`, [c.entityId, w]);
    return;
  }

  const parsed = Schemas[entity].safeParse(c.data);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid data.', 'invalid_data');
  const d = parsed.data as never;
  if ('id' in (parsed.data as object) && (parsed.data as { id: string }).id !== c.entityId) throw badRequest('Change id and record id differ.');

  switch (entity) {
    case 'prompt': { const p = d as z.infer<typeof Schemas.prompt>; return upsert(q, 'prompts', w, p.id, { title: p.title, text: p.text }); }
    case 'post': { const p = d as z.infer<typeof Schemas.post>; return upsert(q, 'posts', w, p.id, { title: p.title, body: p.body, status: p.status, date: p.date }); }
    case 'task': { const t = d as z.infer<typeof Schemas.task>; return upsert(q, 'tasks', w, t.id, { text: t.text, due: t.due, done: t.done }); }
    case 'activity': { const a = d as z.infer<typeof Schemas.activity>; return upsert(q, 'activity', w, a.id, { text: a.text, at: when(a.at, now) }); }
    case 'workflow': { const f = d as z.infer<typeof Schemas.workflow>; return upsert(q, 'workflows', w, f.id, { name: f.name, enabled: f.on, steps: j(f.steps) }); }
    case 'conversation': {
      const v = d as z.infer<typeof Schemas.conversation>;
      // Once it reaches the server a message is no longer "queued".
      const msgs = v.msgs.map(({ queued: _queued, ...m }) => m);
      return upsert(q, 'conversations', w, v.id, {
        name: v.name, company: v.company, channel: v.channel, unread: v.unread, important: v.important,
        intent: v.intent, sentiment: v.sentiment, suggestion: v.suggestion, msgs: j(msgs), notes: j(v.notes),
      });
    }
    case 'run': {
      const r = d as z.infer<typeof Schemas.run>;
      const wf = (await q.query('SELECT steps FROM workflows WHERE id = $1 AND workspace_id = $2', [r.workflowId, w])).rows[0];
      if (!wf) throw badRequest('That workflow does not exist.');
      const existing = (await q.query('SELECT status FROM runs WHERE id = $1 AND workspace_id = $2', [r.id, w])).rows[0];
      if (!existing) {
        // New run: the daily limit is enforced here, and a workflow with an approval step always pauses.
        const ws = (await q.query('SELECT automation_daily_run_limit AS lim FROM workspaces WHERE id = $1 FOR UPDATE', [w])).rows[0];
        const today = (await q.query('SELECT count(*)::int AS n FROM runs WHERE workspace_id = $1 AND at >= $2', [w, new Date(now.getTime() - 86_400_000)])).rows[0].n;
        if (today >= ws.lim) throw new HttpError(429, 'run_limit', `The daily limit of ${ws.lim} runs has been reached.`);
        const steps = wf.steps as { type: string }[];
        const status = steps.some((s) => s.type === 'Approval') ? 'Awaiting approval' : 'Completed';
        return upsert(q, 'runs', w, r.id, { workflow_id: r.workflowId, name: r.name, steps: steps.length, status, at: now });
      }
      // Existing run: the only change is approval.
      if (existing.status === 'Awaiting approval' && r.status === 'Completed') await q.query("UPDATE runs SET status = 'Completed' WHERE id = $1 AND workspace_id = $2", [r.id, w]);
      return;
    }
    case 'profile': {
      const p = d as z.infer<typeof Schemas.profile>;
      const taken = await q.query('SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2', [p.email, auth.userId]);
      if (taken.rowCount) throw conflict('That email address is already in use.');
      await q.query('UPDATE users SET name = $1, email = $2 WHERE id = $3 AND workspace_id = $4', [p.name, p.email, auth.userId, w]);
      await q.query('UPDATE workspaces SET name = $1 WHERE id = $2', [p.workspace, w]);
      return;
    }
    case 'icp': await q.query('UPDATE workspaces SET icp = $1 WHERE id = $2', [j(d), w]); return;
    case 'routing': await q.query('UPDATE workspaces SET routing = $1 WHERE id = $2', [j(d), w]); return;
    case 'openrouter': await q.query('UPDATE workspaces SET openrouter = $1 WHERE id = $2', [j(d), w]); return;
    case 'sync': {
      const { lastBackupAt: _ignored, ...s } = d as z.infer<typeof Schemas.sync>;
      await q.query('UPDATE workspaces SET sync = $1 WHERE id = $2', [j(s), w]);
      return;
    }
    case 'security': await q.query('UPDATE workspaces SET mfa = $1 WHERE id = $2', [(d as z.infer<typeof Schemas.security>).mfa, w]); return;
  }
}

/** Applies one change in its own transaction. */
export const applyChange = (ctx: Ctx, auth: Auth, raw: unknown): Promise<void> => tx(ctx.db, (q) => applyOne(ctx, q, auth, raw));
