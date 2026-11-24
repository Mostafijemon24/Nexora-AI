// Numbers shown on the dashboard and the Reports page, counted from workspace data. The same
// code runs in the app (so reports work offline) and on the server.

import { scoreLead } from './scoring.ts';
import { toCsv } from './csv.ts';
import type { Campaign, Conversation, Icp, Lead, LeadStage, Post, PostStatus, Range, Run, Task } from './types.ts';
import { LEAD_STAGES, STAGE_LABEL } from './types.ts';

export const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, '90d': 90 };
const DAY = 86_400_000;

/** How far along the funnel a stage is. A lost lead counts as having entered it and nothing more. */
const REACHED: Record<LeadStage, number> = { new: 0, contacted: 1, interested: 2, converted: 3, lost: 0 };

/** New, Contacted, Interested, Converted: each lead counts in every step up to the one it has reached. */
export function funnel(leads: Pick<Lead, 'stage'>[]): [number, number, number, number] {
  const f: [number, number, number, number] = [0, 0, 0, 0];
  for (const l of leads) for (let i = 0; i <= REACHED[l.stage]; i++) f[i]++;
  return f;
}

export const inRange = (at: string, range: Range, now: Date): boolean => {
  const t = Date.parse(at);
  return !Number.isNaN(t) && t >= now.getTime() - RANGE_DAYS[range] * DAY && t <= now.getTime();
};

const pct = (part: number, whole: number): number | null => (whole ? Math.round((part / whole) * 100) : null);

export interface CampaignReport {
  id: string; name: string; status: Campaign['status']; leads: number; contacted: number; replied: number; converted: number;
  replyRate: number | null; conversionRate: number | null;
}
export interface ChannelReport { channel: string; conversations: number; received: number; sent: number }
export interface Report {
  leads: {
    total: number;
    byStage: Record<LeadStage, number>;
    /** Share of leads that were contacted, of contacted leads that replied, and of all leads that converted. Null when there is nothing to divide by. */
    contactedRate: number | null; replyRate: number | null; conversionRate: number | null;
    highMatch: number;
  };
  campaigns: CampaignReport[];
  posts: Record<PostStatus, number>;
  channels: ChannelReport[];
  messages: { received: number; sent: number };
  runs: { total: number; completed: number; waiting: number; failed: number };
  tasks: { open: number; done: number; overdue: number };
}

export interface ReportInput {
  leads: Lead[]; campaigns: Campaign[]; conversations: Conversation[]; posts: Post[]; runs: Run[]; tasks: Task[]; icp: Icp;
}

/** A lead has replied when a conversation linked to it (or, for older data, with the same name) holds an incoming message. */
export function repliedLeadIds(leads: Lead[], conversations: Conversation[]): Set<string> {
  const byName = new Map(leads.map((l) => [l.name.toLowerCase(), l.id]));
  const ids = new Set<string>();
  for (const c of conversations) {
    if (!c.msgs.some((m) => !m.me)) continue;
    const id = c.leadId ?? byName.get(c.name.toLowerCase());
    if (id) ids.add(id);
  }
  return ids;
}

/** The report for leads created, and messages and runs dated, inside the range. */
export function buildReport(ws: ReportInput, range: Range, now: Date): Report {
  const leads = ws.leads.filter((l) => inRange(l.createdAt, range, now));
  const replied = repliedLeadIds(ws.leads, ws.conversations);
  const byStage = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) as Record<LeadStage, number>;
  for (const l of leads) byStage[l.stage]++;
  const f = funnel(leads);
  const wasContacted = (l: Lead) => REACHED[l.stage] >= 1 || replied.has(l.id);
  const contacted = leads.filter(wasContacted);

  const campaigns = ws.campaigns.map((c): CampaignReport => {
    const mine = ws.leads.filter((l) => l.campaignId === c.id);
    const reached = mine.filter(wasContacted);
    const rep = mine.filter((l) => replied.has(l.id)).length;
    const conv = mine.filter((l) => l.stage === 'converted').length;
    return {
      id: c.id, name: c.name, status: c.status, leads: mine.length, contacted: reached.length, replied: rep, converted: conv,
      replyRate: pct(rep, reached.length), conversionRate: pct(conv, mine.length),
    };
  });

  const posts = { Draft: 0, 'In review': 0, Approved: 0, Scheduled: 0, Published: 0 } as Record<PostStatus, number>;
  for (const p of ws.posts) posts[p.status]++;

  const channels = new Map<string, ChannelReport>();
  let received = 0, sent = 0;
  for (const c of ws.conversations) {
    const row = channels.get(c.channel) ?? { channel: c.channel, conversations: 0, received: 0, sent: 0 };
    row.conversations++;
    for (const m of c.msgs) {
      if (!inRange(m.at, range, now)) continue;
      if (m.me) { row.sent++; sent++; } else { row.received++; received++; }
    }
    channels.set(c.channel, row);
  }

  const runs = ws.runs.filter((r) => inRange(r.at, range, now));
  const today = isoDay(now);
  return {
    leads: {
      total: leads.length, byStage,
      contactedRate: pct(contacted.length, leads.length),
      replyRate: pct(contacted.filter((l) => replied.has(l.id)).length, contacted.length),
      conversionRate: pct(f[3], leads.length),
      highMatch: leads.filter((l) => scoreLead(l, ws.icp).total >= 75).length,
    },
    campaigns,
    posts,
    channels: [...channels.values()].sort((a, b) => b.conversations - a.conversations),
    messages: { received, sent },
    runs: {
      total: runs.length,
      completed: runs.filter((r) => r.status === 'Completed').length,
      waiting: runs.filter((r) => r.status === 'Awaiting approval' || r.status === 'Waiting').length,
      failed: runs.filter((r) => r.status === 'Failed').length,
    },
    tasks: {
      open: ws.tasks.filter((t) => !t.done).length,
      done: ws.tasks.filter((t) => t.done).length,
      overdue: ws.tasks.filter((t) => !t.done && t.dueDate && t.dueDate < today).length,
    },
  };
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const rate = (v: number | null) => (v === null ? '' : `${v}%`);

/** Every lead with its score, for a spreadsheet. Re-importable: the column names match the importer's. */
export function leadsCsv(leads: Lead[], icp: Icp, campaigns: Campaign[]): string {
  const camp = new Map(campaigns.map((c) => [c.id, c.name]));
  return toCsv([
    ['name', 'company', 'title', 'industry', 'size', 'country', 'email', 'phone', 'linkedin', 'stage', 'tags', 'campaign', 'score', 'confidence', 'created'],
    ...leads.map((l) => {
      const s = scoreLead(l, icp);
      return [l.name, l.company, l.title, l.industry, l.size, l.country, l.email, l.phone, l.linkedin, l.stage, l.tags.join('; '),
        l.campaignId ? camp.get(l.campaignId) ?? '' : '', s.total, s.conf, l.createdAt.slice(0, 10)];
    }),
  ]);
}

/** The report as rows of section, measure, value. */
export function reportCsv(r: Report, rangeLabel: string): string {
  return toCsv([
    ['section', 'measure', 'value'],
    ['Report', 'Period', rangeLabel],
    ['Leads', 'Total', r.leads.total],
    ...LEAD_STAGES.map((s) => ['Leads', STAGE_LABEL[s], r.leads.byStage[s]]),
    ['Leads', 'High match', r.leads.highMatch],
    ['Leads', 'Contacted rate', rate(r.leads.contactedRate)],
    ['Leads', 'Reply rate', rate(r.leads.replyRate)],
    ['Leads', 'Conversion rate', rate(r.leads.conversionRate)],
    ...r.campaigns.flatMap((c) => [
      [`Campaign: ${c.name}`, 'Leads', c.leads], [`Campaign: ${c.name}`, 'Contacted', c.contacted], [`Campaign: ${c.name}`, 'Replied', c.replied],
      [`Campaign: ${c.name}`, 'Converted', c.converted], [`Campaign: ${c.name}`, 'Reply rate', rate(c.replyRate)], [`Campaign: ${c.name}`, 'Conversion rate', rate(c.conversionRate)],
    ]),
    ...Object.entries(r.posts).map(([k, v]) => ['Posts', k, v]),
    ['Messages', 'Received', r.messages.received], ['Messages', 'Sent', r.messages.sent],
    ...r.channels.flatMap((c) => [[`Channel: ${c.channel}`, 'Conversations', c.conversations], [`Channel: ${c.channel}`, 'Received', c.received], [`Channel: ${c.channel}`, 'Sent', c.sent]]),
    ['Workflow runs', 'Total', r.runs.total], ['Workflow runs', 'Completed', r.runs.completed], ['Workflow runs', 'Waiting', r.runs.waiting], ['Workflow runs', 'Failed', r.runs.failed],
    ['Tasks', 'Open', r.tasks.open], ['Tasks', 'Done', r.tasks.done], ['Tasks', 'Overdue', r.tasks.overdue],
  ]);
}
