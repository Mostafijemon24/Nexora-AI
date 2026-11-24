// Reading and writing workspace records. Every statement is scoped to one workspace.

import type { Campaign, Conversation, Lead, LeadStage, Post, Run, Task, Workflow } from '../../../src/lib/types.ts';
import type { Q } from '../db.ts';
import { conflict } from '../errors.ts';

const iso = (d: Date | string) => new Date(d).toISOString();
const j = (v: unknown) => JSON.stringify(v);

/**
 * Insert-or-update by primary key that can only ever touch the caller's own rows.
 * If the id already belongs to another workspace the UPDATE matches nothing and the write is refused.
 */
export async function upsert(q: Q, table: string, w: string, rowId: string, cols: Record<string, unknown>): Promise<void> {
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  const sql = `INSERT INTO ${table} (id, workspace_id, ${names.join(', ')}) VALUES ($1, $2, ${names.map((_, i) => `$${i + 3}`).join(', ')})
    ON CONFLICT (id) DO UPDATE SET ${names.map((n) => `${n} = EXCLUDED.${n}`).join(', ')} WHERE ${table}.workspace_id = $2`;
  const r = await q.query(sql, [rowId, w, ...vals]);
  if (r.rowCount !== 1) throw conflict('That record belongs to another workspace.', 'forbidden_record');
}

// ── leads ────────────────────────────────────────────────────────────────
const LEAD = 'id, name, title, company, industry, size, country, email, phone, linkedin, status, tags, notes, campaign_id, created_at';
const toLead = (r: any): Lead => ({
  id: r.id, name: r.name, title: r.title, company: r.company, industry: r.industry, size: r.size, country: r.country,
  email: r.email, phone: r.phone, linkedin: r.linkedin, stage: r.status, tags: r.tags, notes: r.notes, campaignId: r.campaign_id, createdAt: iso(r.created_at),
});

export async function loadLeads(q: Q, w: string): Promise<Lead[]> {
  return (await q.query(`SELECT ${LEAD} FROM leads WHERE workspace_id = $1 ORDER BY created_at, id`, [w])).rows.map(toLead);
}
export async function getLead(q: Q, w: string, id: string): Promise<Lead | null> {
  const r = (await q.query(`SELECT ${LEAD} FROM leads WHERE id::text = $1 AND workspace_id = $2`, [id, w])).rows[0];
  return r ? toLead(r) : null;
}
/** Writes a lead. Returns the stage it had before, or null when it is new. The creation time is kept from the first write. */
export async function saveLead(q: Q, w: string, l: Lead, now: Date): Promise<{ previous: LeadStage | null }> {
  const before = (await q.query('SELECT status FROM leads WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [l.id, w])).rows[0];
  const campaign = l.campaignId && (await q.query('SELECT 1 FROM campaigns WHERE id = $1 AND workspace_id = $2', [l.campaignId, w])).rowCount ? l.campaignId : null;
  const cols = {
    name: l.name, title: l.title, company: l.company, industry: l.industry, size: l.size, country: l.country, email: l.email, phone: l.phone,
    linkedin: l.linkedin, status: l.stage, tags: j(l.tags), notes: j(l.notes), campaign_id: campaign, updated_at: now,
  };
  await upsert(q, 'leads', w, l.id, before ? cols : { ...cols, created_at: now });
  return { previous: before ? (before.status as LeadStage) : null };
}

// ── campaigns ────────────────────────────────────────────────────────────
export async function loadCampaigns(q: Q, w: string): Promise<Campaign[]> {
  return (await q.query('SELECT id, name, goal, channel, status, start_date, end_date FROM campaigns WHERE workspace_id = $1 ORDER BY created_at, id', [w])).rows
    .map((r) => ({ id: r.id, name: r.name, goal: r.goal, channel: r.channel, status: r.status, startDate: r.start_date, endDate: r.end_date }));
}

// ── conversations ────────────────────────────────────────────────────────
const CONV = 'id, name, company, channel, address, lead_id, unread, important, intent, sentiment, suggestion, msgs, notes';
const toConversation = (r: any): Conversation => ({
  id: r.id, name: r.name, company: r.company, channel: r.channel, address: r.address, leadId: r.lead_id, unread: r.unread, important: r.important,
  intent: r.intent, sentiment: r.sentiment, suggestion: r.suggestion, msgs: r.msgs, notes: r.notes,
});
export async function loadConversations(q: Q, w: string): Promise<Conversation[]> {
  return (await q.query(`SELECT ${CONV} FROM conversations WHERE workspace_id = $1 ORDER BY created_at, id`, [w])).rows.map(toConversation);
}
export async function getConversation(q: Q, w: string, id: string): Promise<Conversation | null> {
  const r = (await q.query(`SELECT ${CONV} FROM conversations WHERE id::text = $1 AND workspace_id = $2`, [id, w])).rows[0];
  return r ? toConversation(r) : null;
}
export async function conversationForLead(q: Q, w: string, leadId: string): Promise<Conversation | null> {
  const r = (await q.query(`SELECT ${CONV} FROM conversations WHERE lead_id::text = $1 AND workspace_id = $2 ORDER BY created_at DESC LIMIT 1`, [leadId, w])).rows[0];
  return r ? toConversation(r) : null;
}
export async function saveConversation(q: Q, w: string, v: Conversation, now: Date): Promise<void> {
  // Once it reaches the server a message is no longer "queued".
  const msgs = v.msgs.map(({ queued: _queued, ...m }) => m);
  const lead = v.leadId && (await q.query('SELECT 1 FROM leads WHERE id::text = $1 AND workspace_id = $2', [v.leadId, w])).rowCount ? v.leadId : null;
  const exists = (await q.query('SELECT 1 FROM conversations WHERE id = $1', [v.id])).rowCount;
  const cols = {
    name: v.name, company: v.company, channel: v.channel, address: v.address?.trim() || null, lead_id: lead, unread: v.unread, important: v.important,
    intent: v.intent, sentiment: v.sentiment, suggestion: v.suggestion, msgs: j(msgs), notes: j(v.notes),
  };
  await upsert(q, 'conversations', w, v.id, exists ? cols : { ...cols, created_at: now });
}

// ── posts, tasks ─────────────────────────────────────────────────────────
export async function getPost(q: Q, w: string, id: string): Promise<Post | null> {
  const r = (await q.query('SELECT id, title, body, status, date FROM posts WHERE id::text = $1 AND workspace_id = $2', [id, w])).rows[0];
  return r ?? null;
}
const toTask = (r: any): Task => ({ id: r.id, text: r.text, due: r.due, dueDate: r.due_date, leadId: r.lead_id, done: r.done });
export async function loadTasks(q: Q, w: string): Promise<Task[]> {
  return (await q.query('SELECT id, text, due, due_date, lead_id, done FROM tasks WHERE workspace_id = $1 ORDER BY created_at DESC, id', [w])).rows.map(toTask);
}
export async function saveTask(q: Q, w: string, t: Task, now: Date): Promise<void> {
  const lead = t.leadId && (await q.query('SELECT 1 FROM leads WHERE id::text = $1 AND workspace_id = $2', [t.leadId, w])).rowCount ? t.leadId : null;
  await upsert(q, 'tasks', w, t.id, { text: t.text, due: t.due, due_date: t.dueDate ?? null, lead_id: lead, done: t.done, updated_at: now });
}

// ── workflows, runs ──────────────────────────────────────────────────────
export async function loadWorkflows(q: Q, w: string): Promise<Workflow[]> {
  return (await q.query('SELECT id, name, enabled, steps FROM workflows WHERE workspace_id = $1 ORDER BY created_at, id', [w])).rows
    .map((f) => ({ id: f.id, name: f.name, on: f.enabled, steps: f.steps }));
}

export type StoredRun = Run & { chain?: string[] };
const RUN = 'id, workflow_id, name, steps, status, at, cursor, subject, log, chain, resume_at, test';
const toRun = (r: any): StoredRun => ({
  id: r.id, workflowId: r.workflow_id, name: r.name, steps: r.steps, status: r.status, at: iso(r.at), cursor: r.cursor, subject: r.subject, log: r.log,
  resumeAt: r.resume_at ? iso(r.resume_at) : null, test: r.test || undefined, chain: r.chain,
});
export async function loadRuns(q: Q, w: string, limit = 50): Promise<Run[]> {
  return (await q.query(`SELECT ${RUN} FROM runs WHERE workspace_id = $1 ORDER BY at DESC, id LIMIT $2`, [w, limit])).rows
    .map((r) => { const { chain: _chain, ...run } = toRun(r); return run; });
}
export async function getRun(q: Q, w: string, id: string): Promise<StoredRun | null> {
  const r = (await q.query(`SELECT ${RUN} FROM runs WHERE id::text = $1 AND workspace_id = $2`, [id, w])).rows[0];
  return r ? toRun(r) : null;
}
export async function saveRun(q: Q, w: string, r: StoredRun): Promise<void> {
  await upsert(q, 'runs', w, r.id, {
    workflow_id: r.workflowId, name: r.name, steps: r.steps, status: r.status, at: new Date(r.at), cursor: r.cursor ?? 1, subject: j(r.subject ?? {}),
    log: j((r.log ?? []).slice(-100)), chain: j(r.chain ?? []), resume_at: r.resumeAt ? new Date(r.resumeAt) : null, test: Boolean(r.test),
  });
}
