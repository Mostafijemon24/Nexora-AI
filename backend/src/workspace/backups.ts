// Backups: a copy of everything a workspace's people made (leads, campaigns, posts,
// conversations, workflows, tasks, prompts, saved replies and the scoring criteria). A backup can
// be downloaded as a file, and a workspace can be restored from a stored backup or from such a
// file. Connections, keys, team members and sessions are not part of a backup and are left as they
// are by a restore.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cleanTags } from '../../../src/lib/csv.ts';
import { newLead, type Campaign, type Conversation, type Icp, type Lead, type Post, type Prompt, type SavedReply, type Task, type Workflow } from '../../../src/lib/types.ts';
import { workflowProblem } from '../../../src/lib/workflow.ts';
import type { Ctx } from '../context.ts';
import { tx, type Q } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { loadCampaigns, loadConversations, loadLeads, loadTasks, loadWorkflows, saveConversation, saveTask, upsert } from './store.ts';

export interface BackupData {
  format: 'nexora-backup';
  version: 2;
  exportedAt: string;
  workspace: string;
  leads: Lead[];
  campaigns: Campaign[];
  prompts: Prompt[];
  posts: Post[];
  conversations: Conversation[];
  savedReplies: SavedReply[];
  workflows: Workflow[];
  tasks: Task[];
  icp: Icp;
  brandVoice: string;
}

const KEEP_AUTOMATIC = 14;

export async function exportData(ctx: Ctx, workspaceId: string, q: Q = ctx.db): Promise<BackupData> {
  const w = workspaceId;
  const ws = (await q.query('SELECT name, icp, brand_voice FROM workspaces WHERE id = $1', [w])).rows[0];
  if (!ws) throw notFound('Workspace not found.');
  return {
    format: 'nexora-backup', version: 2, exportedAt: ctx.now().toISOString(), workspace: ws.name,
    leads: await loadLeads(q, w),
    campaigns: await loadCampaigns(q, w),
    prompts: (await q.query('SELECT id, title, text FROM prompts WHERE workspace_id = $1 ORDER BY created_at, id', [w])).rows,
    posts: (await q.query('SELECT id, title, body, status, date FROM posts WHERE workspace_id = $1 ORDER BY created_at, id', [w])).rows,
    conversations: await loadConversations(q, w),
    savedReplies: (await q.query('SELECT title, text FROM saved_replies WHERE workspace_id = $1 ORDER BY position, id', [w])).rows,
    workflows: await loadWorkflows(q, w),
    tasks: await loadTasks(q, w),
    icp: ws.icp, brandVoice: ws.brand_voice,
  };
}

export async function createBackup(ctx: Ctx, workspaceId: string, automatic = false): Promise<string> {
  const data = await exportData(ctx, workspaceId);
  const r = await ctx.db.query('INSERT INTO backups (workspace_id, snapshot, created_at, automatic) VALUES ($1, $2, $3, $4) RETURNING created_at', [workspaceId, JSON.stringify(data), ctx.now(), automatic]);
  return new Date(r.rows[0].created_at).toISOString();
}

export interface BackupInfo { id: string; createdAt: string; automatic: boolean; sizeBytes: number; leads: number }

export async function listBackups(ctx: Ctx, workspaceId: string): Promise<BackupInfo[]> {
  return (await ctx.db.query(
    `SELECT id, created_at, automatic, octet_length(snapshot::text) AS size, coalesce(jsonb_array_length(snapshot->'leads'), 0) AS leads
     FROM backups WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 60`, [workspaceId])).rows
    .map((r) => ({ id: r.id, createdAt: new Date(r.created_at).toISOString(), automatic: r.automatic, sizeBytes: r.size, leads: r.leads }));
}

export async function readBackup(ctx: Ctx, workspaceId: string, id: string): Promise<unknown> {
  const r = (await ctx.db.query('SELECT snapshot FROM backups WHERE id::text = $1 AND workspace_id = $2', [id, workspaceId])).rows[0];
  if (!r) throw notFound('That backup does not exist.');
  return r.snapshot;
}

// ── restore ──────────────────────────────────────────────────────────────

const id = z.string().max(64);
const text = (max: number) => z.string().max(max);
const opt = (max: number) => z.string().max(max).nullable().optional();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const Stage = z.enum(['new', 'contacted', 'interested', 'converted', 'lost']);

/** What a restore accepts. Older backups (which stored the whole workspace view) carry more fields; the extra ones are ignored. */
const Restorable = z.object({
  leads: z.array(z.object({
    id, name: text(300).min(1), company: text(300).min(1), title: opt(300), industry: opt(300), size: z.number().int().positive().nullable().optional(), country: opt(300),
    email: opt(320), phone: opt(40), linkedin: opt(300), stage: Stage.optional(), tags: z.array(text(40)).max(50).optional(),
    notes: z.array(z.object({ text: text(2000), at: text(40) })).max(200).optional(), campaignId: id.nullable().optional(), createdAt: text(40).optional(),
  })).max(100_000).default([]),
  campaigns: z.array(z.object({ id, name: text(200).min(1), goal: text(1000).default(''), channel: text(60).default(''), status: z.enum(['Draft', 'Active', 'Paused', 'Completed']).default('Draft'), startDate: day, endDate: day })).max(2000).default([]),
  prompts: z.array(z.object({ id, title: text(200).min(1), text: text(4000).min(1) })).max(5000).default([]),
  posts: z.array(z.object({ id, title: text(500).min(1), body: text(20_000), status: z.enum(['Draft', 'In review', 'Approved', 'Scheduled', 'Published']), date: day })).max(20_000).default([]),
  conversations: z.array(z.object({
    id, name: text(200), company: text(200).default(''), channel: text(60), address: opt(320), leadId: id.nullable().optional(), unread: z.boolean().default(false), important: z.boolean().default(false),
    intent: text(200).default(''), sentiment: text(60).default(''), suggestion: text(4000).default(''),
    msgs: z.array(z.object({ me: z.boolean(), text: text(10_000), at: text(40), id: text(200).optional(), status: z.enum(['sent', 'failed', 'saved']).optional(), error: text(500).optional() })).max(2000).default([]),
    notes: z.array(text(2000)).max(500).default([]),
  })).max(50_000).default([]),
  savedReplies: z.array(z.object({ title: text(200).min(1), text: text(4000) })).max(500).default([]),
  workflows: z.array(z.object({
    id, name: text(200), on: z.boolean().default(false),
    steps: z.array(z.object({ type: z.enum(['Trigger', 'Condition', 'Action', 'Delay', 'Approval', 'Notification', 'Update', 'Stop']), label: text(300), kind: text(40).optional(), config: z.record(text(40), text(300)).optional() })).min(1).max(50),
  })).max(2000).default([]),
  tasks: z.array(z.object({ id, text: text(500).min(1), due: text(40).default(''), dueDate: day, leadId: id.nullable().optional(), done: z.boolean().default(false) })).max(50_000).default([]),
  icp: z.object({ industry: text(200), title: text(400), sizeMin: text(12), sizeMax: text(12), location: text(200) }).optional(),
  brandVoice: text(2000).optional(),
});

export interface RestoreSummary { leads: number; campaigns: number; posts: number; conversations: number; workflows: number; tasks: number; prompts: number }

/**
 * Replaces the workspace's content with a backup's. Every record gets a new id (references between
 * them are kept), so a file from another workspace can never collide with or touch anyone else's
 * records. Workflows come back switched off: they are reviewed and switched on again by a person.
 * The state before the restore is saved as a backup first, so a restore can be undone.
 */
export async function restore(ctx: Ctx, workspaceId: string, raw: unknown): Promise<RestoreSummary> {
  const parsed = Restorable.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(`This file is not a Nexora AI backup that can be restored (${issue?.path.join('.') || 'file'}: ${issue?.message ?? 'invalid'}).`, 'invalid_backup');
  }
  const d = parsed.data;
  const w = workspaceId;
  const now = ctx.now();
  await createBackup(ctx, w, true);

  const map = new Map<string, string>();
  const fresh = (old: string) => { let n = map.get(old); if (!n) { n = randomUUID(); map.set(old, n); } return n; };
  const ref = (old: string | null | undefined) => (old && map.has(old) ? map.get(old)! : null);
  for (const c of d.campaigns) fresh(c.id);
  for (const l of d.leads) fresh(l.id);

  await tx(ctx.db, async (q) => {
    for (const table of ['runs', 'workflows', 'tasks', 'conversations', 'posts', 'prompts', 'saved_replies', 'leads', 'campaigns']) {
      await q.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [w]);
    }
    for (const c of d.campaigns) {
      await upsert(q, 'campaigns', w, fresh(c.id), { name: c.name, goal: c.goal, channel: c.channel, status: c.status, start_date: c.startDate ?? null, end_date: c.endDate ?? null, created_at: now });
    }
    for (const [i, l] of d.leads.entries()) {
      const lead = newLead(fresh(l.id), l.name, l.company, l.createdAt ?? now.toISOString(), {
        title: l.title ?? null, industry: l.industry ?? null, size: l.size ?? null, country: l.country ?? null, email: l.email ?? null, phone: l.phone ?? null, linkedin: l.linkedin ?? null,
        stage: l.stage ?? 'new', tags: cleanTags(l.tags ?? []), notes: l.notes ?? [], campaignId: ref(l.campaignId),
      });
      const created = Number.isNaN(Date.parse(lead.createdAt)) ? now : new Date(lead.createdAt);
      await upsert(q, 'leads', w, lead.id, {
        name: lead.name, title: lead.title, company: lead.company, industry: lead.industry, size: lead.size, country: lead.country, email: lead.email, phone: lead.phone, linkedin: lead.linkedin,
        status: lead.stage, tags: JSON.stringify(lead.tags), notes: JSON.stringify(lead.notes), campaign_id: lead.campaignId,
        // Leads keep their order and their age, which the reports count by.
        created_at: new Date(created.getTime() + (created.getTime() === now.getTime() ? i : 0)), updated_at: now,
      });
    }
    for (const [i, p] of d.prompts.entries()) await upsert(q, 'prompts', w, randomUUID(), { title: p.title, text: p.text, created_at: new Date(now.getTime() + i) });
    for (const [i, p] of d.posts.entries()) await upsert(q, 'posts', w, randomUUID(), { title: p.title, body: p.body, status: p.status, date: p.date ?? null, created_at: new Date(now.getTime() + i) });
    for (const [i, c] of d.conversations.entries()) {
      await saveConversation(q, w, { ...c, id: randomUUID(), leadId: ref(c.leadId), address: c.address ?? null } as Conversation, new Date(now.getTime() + i));
    }
    for (const [i, r] of d.savedReplies.entries()) await q.query('INSERT INTO saved_replies (workspace_id, title, text, position) VALUES ($1, $2, $3, $4)', [w, r.title, r.text, i]);
    for (const [i, f] of d.workflows.entries()) {
      if (workflowProblem(f.steps)) continue; // a workflow this version cannot run is left out rather than stored broken
      await upsert(q, 'workflows', w, randomUUID(), { name: f.name, enabled: false, steps: JSON.stringify(f.steps), created_at: new Date(now.getTime() + i) });
    }
    for (const t of d.tasks) await saveTask(q, w, { ...t, id: randomUUID(), leadId: ref(t.leadId), dueDate: t.dueDate ?? null } as Task, now);
    if (d.icp) await q.query('UPDATE workspaces SET icp = $2 WHERE id = $1', [w, JSON.stringify(d.icp)]);
    if (d.brandVoice !== undefined) await q.query('UPDATE workspaces SET brand_voice = $2 WHERE id = $1', [w, d.brandVoice]);
    await q.query('INSERT INTO activity (id, workspace_id, text, at) VALUES (gen_random_uuid(), $1, $2, $3)', [w, 'Workspace restored from a backup. Workflows are switched off until you switch them on.', now]);
  });
  return { leads: d.leads.length, campaigns: d.campaigns.length, posts: d.posts.length, conversations: d.conversations.length, workflows: d.workflows.length, tasks: d.tasks.length, prompts: d.prompts.length };
}

/** Background job: one automatic backup a day for every workspace that holds anything, keeping the newest fourteen. */
export async function dailyBackups(ctx: Ctx): Promise<number> {
  const since = new Date(ctx.now().getTime() - 86_400_000);
  const rows = (await ctx.db.query(
    `SELECT w.id FROM workspaces w
     WHERE NOT EXISTS (SELECT 1 FROM backups b WHERE b.workspace_id = w.id AND b.created_at > $1)
       AND (EXISTS (SELECT 1 FROM leads l WHERE l.workspace_id = w.id) OR EXISTS (SELECT 1 FROM posts p WHERE p.workspace_id = w.id) OR EXISTS (SELECT 1 FROM conversations c WHERE c.workspace_id = w.id))
     LIMIT 50`, [since])).rows;
  for (const r of rows) {
    await createBackup(ctx, r.id, true);
    await ctx.db.query(
      `DELETE FROM backups WHERE workspace_id = $1 AND automatic AND id NOT IN (SELECT id FROM backups WHERE workspace_id = $1 AND automatic ORDER BY created_at DESC LIMIT $2)`, [r.id, KEEP_AUTOMATIC]);
  }
  return rows.length;
}
