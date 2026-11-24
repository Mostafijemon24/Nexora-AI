// What a workflow step can be and how a workflow runs. The same engine runs on the server and in
// the local backend; each provides a `WorkflowHost` that reads and writes its own data.
//
// A workflow is one trigger followed by steps. Every step has a `kind` from STEP_DEFS and a
// `config` holding that kind's fields. Nothing here acts on LinkedIn, and a message is only ever
// sent after an approval step earlier in the same workflow.

import { scoreLead } from './scoring.ts';
import type { Conversation, Icp, Lead, LeadStage, Post, Run, RunLog, RunSubject, Step, StepType, Task, Workflow } from './types.ts';
import { LEAD_STAGES, STAGE_LABEL } from './types.ts';

export type Option = readonly [value: string, label: string];
export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'time';
  options?: readonly Option[];
  default: string;
  placeholder?: string;
}
export interface StepDef {
  kind: string;
  type: StepType;
  /** Name in the "add step" menu. */
  name: string;
  fields: FieldDef[];
  /** One-line description of a configured step, shown in the editor and the run log. */
  describe(c: Record<string, string>): string;
  /** The step needs the run to be about a lead (or, for `conversation`, a conversation). */
  needs?: 'lead' | 'conversation';
}

const STAGES: Option[] = LEAD_STAGES.map((s) => [s, STAGE_LABEL[s]] as const);
const ANY: Option = ['', 'Any'];
const POST_STATUSES: Option[] = ['Draft', 'In review', 'Approved', 'Scheduled', 'Published'].map((s) => [s, s] as const);
const WEEKDAYS: Option[] = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']];
const UNITS: Option[] = [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']];
const LEAD_FIELDS: Option[] = [['title', 'Job title'], ['company', 'Company'], ['industry', 'Industry'], ['country', 'Country'], ['email', 'Email'], ['phone', 'Phone']];
const label = (options: readonly Option[], v: string) => options.find((o) => o[0] === v)?.[1] ?? v;
const stage = (v: string) => STAGE_LABEL[v as LeadStage] ?? v;

export const STEP_DEFS: StepDef[] = [
  // ── triggers ──
  { kind: 'lead.created', type: 'Trigger', name: 'A lead is added', fields: [], describe: () => 'When a lead is added' },
  {
    kind: 'lead.stage_changed', type: 'Trigger', name: 'A lead changes stage',
    fields: [{ key: 'to', label: 'New stage', type: 'select', options: [ANY, ...STAGES], default: '' }],
    describe: (c) => (c.to ? `When a lead moves to ${stage(c.to)}` : 'When a lead changes stage'),
  },
  { kind: 'message.received', type: 'Trigger', name: 'A message is received', fields: [], describe: () => 'When a message is received' },
  {
    kind: 'post.status_changed', type: 'Trigger', name: 'A post changes status',
    fields: [{ key: 'to', label: 'New status', type: 'select', options: [ANY, ...POST_STATUSES], default: '' }],
    describe: (c) => (c.to ? `When a post becomes ${c.to}` : 'When a post changes status'),
  },
  {
    kind: 'schedule', type: 'Trigger', name: 'On a schedule',
    fields: [
      { key: 'every', label: 'Repeat', type: 'select', options: [['day', 'Every day'], ['week', 'Every week']], default: 'week' },
      { key: 'weekday', label: 'Day (weekly)', type: 'select', options: WEEKDAYS, default: '1' },
      { key: 'time', label: 'Time', type: 'time', default: '09:00' },
      { key: 'each', label: 'Run for', type: 'select', options: [['', 'The workspace, once'], ...STAGES.map(([v, l]) => [v, `Each ${l.toLowerCase()} lead`] as const)], default: '' },
    ],
    describe: (c) => `${c.every === 'day' ? 'Every day' : `Every ${label(WEEKDAYS, c.weekday ?? '1')}`} at ${c.time || '09:00'}${c.each ? `, for each ${stage(c.each).toLowerCase()} lead` : ''}`,
  },
  { kind: 'manual', type: 'Trigger', name: 'Only when I run it', fields: [], describe: () => 'When I run it' },

  // ── conditions ──
  {
    kind: 'if.lead_score', type: 'Condition', name: 'Lead score', needs: 'lead',
    fields: [
      { key: 'op', label: 'Is', type: 'select', options: [['gte', 'at least'], ['lt', 'below']], default: 'gte' },
      { key: 'value', label: 'Score (0–100)', type: 'number', default: '70' },
    ],
    describe: (c) => `If the lead score is ${c.op === 'lt' ? 'below' : 'at least'} ${c.value || 0}`,
  },
  {
    kind: 'if.lead_stage', type: 'Condition', name: 'Lead stage', needs: 'lead',
    fields: [
      { key: 'op', label: 'Stage', type: 'select', options: [['is', 'is'], ['is_not', 'is not']], default: 'is' },
      { key: 'stage', label: 'Stage', type: 'select', options: STAGES, default: 'new' },
    ],
    describe: (c) => `If the lead ${c.op === 'is_not' ? 'is not' : 'is'} ${stage(c.stage ?? 'new')}`,
  },
  {
    kind: 'if.lead_tag', type: 'Condition', name: 'Lead tag', needs: 'lead',
    fields: [
      { key: 'op', label: 'Lead', type: 'select', options: [['has', 'has the tag'], ['has_not', 'does not have the tag']], default: 'has' },
      { key: 'tag', label: 'Tag', type: 'text', default: '', placeholder: 'e.g. priority' },
    ],
    describe: (c) => `If the lead ${c.op === 'has_not' ? 'does not have' : 'has'} the tag “${c.tag ?? ''}”`,
  },
  {
    kind: 'if.lead_field', type: 'Condition', name: 'Lead detail', needs: 'lead',
    fields: [
      { key: 'field', label: 'Detail', type: 'select', options: LEAD_FIELDS, default: 'title' },
      { key: 'op', label: 'Test', type: 'select', options: [['contains', 'contains'], ['not_contains', 'does not contain'], ['is_set', 'is known'], ['is_empty', 'is not known']], default: 'contains' },
      { key: 'text', label: 'Text', type: 'text', default: '' },
    ],
    describe: (c) => {
      const f = label(LEAD_FIELDS, c.field ?? 'title').toLowerCase();
      if (c.op === 'is_set') return `If the lead’s ${f} is known`;
      if (c.op === 'is_empty') return `If the lead’s ${f} is not known`;
      return `If the lead’s ${f} ${c.op === 'not_contains' ? 'does not contain' : 'contains'} “${c.text ?? ''}”`;
    },
  },
  {
    kind: 'if.message_contains', type: 'Condition', name: 'Message text', needs: 'conversation',
    fields: [{ key: 'text', label: 'Any of these words (comma separated)', type: 'text', default: '', placeholder: 'price, pricing, cost' }],
    describe: (c) => `If the latest message contains any of: ${c.text ?? ''}`,
  },

  // ── changes to a lead ──
  {
    kind: 'lead.set_stage', type: 'Update', name: 'Change lead stage', needs: 'lead',
    fields: [{ key: 'stage', label: 'Move to', type: 'select', options: STAGES, default: 'contacted' }],
    describe: (c) => `Move the lead to ${stage(c.stage ?? 'contacted')}`,
  },
  {
    kind: 'lead.add_tag', type: 'Update', name: 'Add a tag', needs: 'lead',
    fields: [{ key: 'tag', label: 'Tag', type: 'text', default: '', placeholder: 'e.g. follow-up' }],
    describe: (c) => `Add the tag “${c.tag ?? ''}”`,
  },
  {
    kind: 'lead.remove_tag', type: 'Update', name: 'Remove a tag', needs: 'lead',
    fields: [{ key: 'tag', label: 'Tag', type: 'text', default: '' }],
    describe: (c) => `Remove the tag “${c.tag ?? ''}”`,
  },
  {
    kind: 'lead.add_note', type: 'Update', name: 'Add a note to the lead', needs: 'lead',
    fields: [{ key: 'text', label: 'Note', type: 'text', default: '' }],
    describe: (c) => `Add the note “${c.text ?? ''}”`,
  },

  // ── actions ──
  {
    kind: 'task.create', type: 'Action', name: 'Create a task',
    fields: [
      { key: 'text', label: 'Task', type: 'text', default: 'Follow up with {{lead.name}}' },
      { key: 'days', label: 'Due in (days)', type: 'number', default: '1' },
    ],
    describe: (c) => `Create the task “${c.text ?? ''}”, due in ${c.days || 0} day${c.days === '1' ? '' : 's'}`,
  },
  {
    kind: 'message.draft', type: 'Action', name: 'Draft a message with AI', needs: 'lead',
    fields: [{ key: 'channel', label: 'Channel', type: 'select', options: [['Email', 'Email'], ['WhatsApp', 'WhatsApp'], ['Manual import', 'Keep as a draft only']], default: 'Email' }],
    describe: (c) => `Draft a message to the lead with AI (${c.channel === 'Manual import' ? 'draft only' : c.channel || 'Email'})`,
  },
  {
    kind: 'message.send', type: 'Action', name: 'Send the drafted message', needs: 'lead',
    fields: [],
    describe: () => 'Send the drafted message through the conversation’s channel',
  },
  {
    kind: 'webhook', type: 'Action', name: 'Send a webhook',
    fields: [{ key: 'event', label: 'Event name', type: 'text', default: 'workflow.step' }],
    describe: (c) => `Send the webhook event “${c.event || 'workflow.step'}”`,
  },
  {
    kind: 'notify', type: 'Notification', name: 'Notify the workspace',
    fields: [
      { key: 'text', label: 'Message', type: 'text', default: '{{lead.name}} needs attention' },
      { key: 'email', label: 'Also email the owner', type: 'select', options: [['no', 'No'], ['yes', 'Yes']], default: 'no' },
    ],
    describe: (c) => `Notify the workspace: “${c.text ?? ''}”${c.email === 'yes' ? ' (and by email)' : ''}`,
  },

  // ── flow ──
  {
    kind: 'wait', type: 'Delay', name: 'Wait',
    fields: [
      { key: 'amount', label: 'Wait', type: 'number', default: '24' },
      { key: 'unit', label: 'Unit', type: 'select', options: UNITS, default: 'hours' },
    ],
    describe: (c) => `Wait ${c.amount || 0} ${c.unit || 'hours'}`,
  },
  {
    kind: 'approval', type: 'Approval', name: 'Ask for my approval',
    fields: [{ key: 'note', label: 'What to check', type: 'text', default: 'Review before continuing' }],
    describe: (c) => `Wait for approval: ${c.note || 'Review before continuing'}`,
  },
  { kind: 'stop', type: 'Stop', name: 'Stop', fields: [], describe: () => 'Stop the workflow' },
];

export const stepDef = (kind: string | undefined): StepDef | undefined => STEP_DEFS.find((d) => d.kind === kind);

/** A step of the given kind with its default settings. */
export function makeStep(kind: string, config: Record<string, string> = {}): Step {
  const d = stepDef(kind);
  if (!d) throw new Error(`Unknown step kind "${kind}".`);
  const c = { ...Object.fromEntries(d.fields.map((f) => [f.key, f.default])), ...config };
  return { type: d.type, kind, config: c, label: d.describe(c) };
}

/** The description of a step: from its settings, or its saved text when it has no kind. */
export const describeStep = (s: Step): string => stepDef(s.kind)?.describe(s.config ?? {}) ?? s.label;

/** Why a workflow cannot be saved or switched on, or null when it is sound. */
export function workflowProblem(steps: Step[]): string | null {
  if (!steps.length || steps[0].type !== 'Trigger') return 'A workflow starts with a trigger.';
  if (steps.slice(1).some((s) => s.type === 'Trigger')) return 'A workflow has exactly one trigger.';
  for (const [i, s] of steps.entries()) {
    if (s.kind === undefined) continue;
    const d = stepDef(s.kind);
    if (!d) return `Step ${i + 1} has an unknown type.`;
    if (d.type !== s.type) return `Step ${i + 1} does not match its type.`;
    if (s.kind === 'message.send') {
      const before = steps.slice(0, i);
      if (!before.some((x) => x.kind === 'approval')) return 'A message can only be sent after an approval step.';
      if (!before.some((x) => x.kind === 'message.draft')) return 'Add a “Draft a message with AI” step before sending.';
    }
    for (const f of d.fields) {
      const v = s.config?.[f.key] ?? '';
      if (f.type === 'number' && !/^\d{1,5}$/.test(v)) return `Step ${i + 1}: “${f.label}” must be a whole number.`;
      if (f.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return `Step ${i + 1}: enter the time as HH:MM.`;
      if (f.type === 'select' && f.options && !f.options.some((o) => o[0] === v)) return `Step ${i + 1}: choose a value for “${f.label}”.`;
      if (f.type === 'text' && v.length > 300) return `Step ${i + 1}: “${f.label}” is too long.`;
    }
  }
  return null;
}

// ── events ───────────────────────────────────────────────────────────────

/** Something that happened in the workspace and may start workflows. */
export interface WfEvent {
  kind: 'lead.created' | 'lead.stage_changed' | 'message.received' | 'post.status_changed';
  leadId?: string;
  conversationId?: string;
  postId?: string;
  /** The new stage or status. */
  to?: string;
  label?: string;
  /** Workflows that led to this event. A workflow is never started by an event it caused. */
  chain?: string[];
}

export function triggeredBy(wf: Workflow, ev: WfEvent): boolean {
  const t = wf.steps[0];
  if (!wf.on || !t || t.kind !== ev.kind || ev.chain?.includes(wf.id)) return false;
  const to = t.config?.to ?? '';
  return !to || to === ev.to;
}

/** The parts of a date in a time zone. An unknown zone falls back to UTC. */
function zoned(now: Date, zone: string): { day: string; weekday: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  const opts = { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' } as const;
  try { parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: zone || 'UTC' }).formatToParts(now); }
  catch { parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).formatToParts(now); }
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return {
    day: `${p('year')}-${p('month')}-${p('day')}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p('weekday')),
    minutes: Number(p('hour')) * 60 + Number(p('minute')),
  };
}

/** A schedule fires once on its day, at its time or up to this long after (so a short outage does not skip it). */
const SCHEDULE_WINDOW_MIN = 180;

/**
 * Returns the day (YYYY-MM-DD in the workflow's time zone) a schedule trigger should fire for
 * now, or null. `lastDay` is the day it last fired.
 */
export function scheduleDue(wf: Workflow, now: Date, lastDay: string | null): string | null {
  const t = wf.steps[0];
  if (!wf.on || t?.kind !== 'schedule') return null;
  const c = t.config ?? {};
  const z = zoned(now, c.zone ?? 'UTC');
  const [h, m] = (c.time ?? '09:00').split(':').map(Number);
  const at = h * 60 + m;
  if (z.day === lastDay) return null;
  if (c.every !== 'day' && String(z.weekday) !== (c.weekday ?? '1')) return null;
  return z.minutes >= at && z.minutes < at + SCHEDULE_WINDOW_MIN ? z.day : null;
}

// ── running ──────────────────────────────────────────────────────────────

/** What the engine needs from wherever the workspace lives. */
export interface WorkflowHost {
  now(): Date;
  newId(): string;
  icp(): Promise<Icp>;
  lead(id: string): Promise<Lead | null>;
  saveLead(lead: Lead): Promise<void>;
  conversation(id: string): Promise<Conversation | null>;
  conversationForLead(leadId: string): Promise<Conversation | null>;
  saveConversation(c: Conversation): Promise<void>;
  post(id: string): Promise<Post | null>;
  addTask(task: Task): Promise<void>;
  /** Adds an activity entry, and emails the workspace owner when asked. */
  notify(text: string, email: boolean): Promise<void>;
  /** Writes a first message to the lead with the workspace's AI provider. */
  draft(lead: Lead): Promise<string>;
  /** Delivers a reply through the conversation's channel and records it in the conversation. */
  send(conversation: Conversation, text: string): Promise<{ ok: boolean; note: string }>;
  webhook(event: string, payload: Record<string, unknown>): Promise<{ ok: boolean; note: string }>;
}

export function newRun(id: string, wf: Workflow, subject: RunSubject, at: Date, opts: { test?: boolean; chain?: string[] } = {}): Run & { chain?: string[] } {
  return {
    id, workflowId: wf.id, name: wf.name, steps: wf.steps.length, status: 'Waiting', at: at.toISOString(),
    cursor: 1, subject, log: [], resumeAt: null, test: opts.test || undefined, chain: opts.chain,
  };
}

const fill = (text: string, lead: Lead | null, post: Post | null, message: string): string =>
  text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (_, key: string) => {
    switch (key) {
      case 'lead.name': return lead?.name ?? 'the lead';
      case 'lead.first_name': return lead?.name.split(/\s+/)[0] ?? 'there';
      case 'lead.company': return lead?.company ?? '';
      case 'lead.title': return lead?.title ?? '';
      case 'lead.stage': return lead ? STAGE_LABEL[lead.stage] : '';
      case 'post.title': return post?.title ?? 'the post';
      case 'message.text': return message;
      default: return '';
    }
  });

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const UNIT_MS: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/**
 * Carries a run forward from its cursor until it finishes, waits (delay or approval) or stops.
 * Returns the updated run and the events its changes caused. A test run reports what each step
 * would do and changes nothing.
 */
export async function advance(run: Run & { chain?: string[] }, wf: Workflow, host: WorkflowHost): Promise<{ run: Run & { chain?: string[] }; events: WfEvent[] }> {
  const log: RunLog[] = [...(run.log ?? [])];
  const events: WfEvent[] = [];
  const subject = run.subject ?? {};
  const test = Boolean(run.test);
  const say = (step: number, text: string, ok = true) => { log.push({ step, text, ok, at: host.now().toISOString() }); };
  const end = (status: Run['status'], cursor: number, resumeAt: string | null = null) =>
    ({ run: { ...run, status, cursor, log, resumeAt, steps: wf.steps.length }, events });

  let lead = subject.leadId ? await host.lead(subject.leadId) : null;
  let conv = subject.conversationId ? await host.conversation(subject.conversationId) : null;
  const post = subject.postId ? await host.post(subject.postId) : null;
  if (!lead && conv?.leadId) lead = await host.lead(conv.leadId);
  const lastMessage = () => [...(conv?.msgs ?? [])].reverse().find((m) => !m.me)?.text ?? '';

  for (let i = run.cursor ?? 1; i < wf.steps.length; i++) {
    const s = wf.steps[i];
    const n = i + 1;
    const d = stepDef(s.kind);
    if (!d) { say(n, `Skipped: “${s.label}” is a note, not a step that can run.`); continue; }
    const c = s.config ?? {};
    const what = d.describe(c);
    if (d.needs === 'lead' && !lead) { say(n, `${what} — stopped: this run is not about a lead.`, false); return end('Stopped', i); }
    if (d.needs === 'conversation' && !conv) { say(n, `${what} — stopped: this run is not about a conversation.`, false); return end('Stopped', i); }

    try {
      switch (s.kind) {
        case 'if.lead_score': {
          const score = scoreLead(lead!, await host.icp()).total;
          const pass = c.op === 'lt' ? score < Number(c.value) : score >= Number(c.value);
          say(n, `${what} — score is ${score}: ${pass ? 'yes' : 'no'}`);
          if (!pass) return end('Stopped', i);
          break;
        }
        case 'if.lead_stage': {
          const pass = (lead!.stage === c.stage) === (c.op !== 'is_not');
          say(n, `${what} — stage is ${STAGE_LABEL[lead!.stage]}: ${pass ? 'yes' : 'no'}`);
          if (!pass) return end('Stopped', i);
          break;
        }
        case 'if.lead_tag': {
          const has = lead!.tags.some((t) => t.toLowerCase() === (c.tag ?? '').trim().toLowerCase());
          const pass = has === (c.op !== 'has_not');
          say(n, `${what}: ${pass ? 'yes' : 'no'}`);
          if (!pass) return end('Stopped', i);
          break;
        }
        case 'if.lead_field': {
          const v = String((lead as unknown as Record<string, unknown>)[c.field ?? 'title'] ?? '');
          const needle = (c.text ?? '').trim().toLowerCase();
          const pass = c.op === 'is_set' ? v !== '' : c.op === 'is_empty' ? v === '' : (needle !== '' && v.toLowerCase().includes(needle)) === (c.op !== 'not_contains');
          say(n, `${what}: ${pass ? 'yes' : 'no'}`);
          if (!pass) return end('Stopped', i);
          break;
        }
        case 'if.message_contains': {
          const words = (c.text ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
          const text = lastMessage().toLowerCase();
          const pass = words.some((w) => text.includes(w));
          say(n, `${what}: ${pass ? 'yes' : 'no'}`);
          if (!pass) return end('Stopped', i);
          break;
        }
        case 'lead.set_stage': {
          const to = c.stage as LeadStage;
          if (lead!.stage === to) { say(n, `${what} — already there`); break; }
          if (test) { say(n, `Would: ${what}`); break; }
          lead = { ...lead!, stage: to };
          await host.saveLead(lead);
          events.push({ kind: 'lead.stage_changed', leadId: lead.id, to, label: lead.name, chain: [...(run.chain ?? []), wf.id] });
          say(n, what);
          break;
        }
        case 'lead.add_tag':
        case 'lead.remove_tag': {
          const tag = (c.tag ?? '').trim();
          if (!tag) { say(n, `${what} — no tag was set`, false); break; }
          const has = lead!.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
          if (has === (s.kind === 'lead.add_tag')) { say(n, `${what} — nothing to change`); break; }
          if (test) { say(n, `Would: ${what}`); break; }
          lead = { ...lead!, tags: s.kind === 'lead.add_tag' ? [...lead!.tags, tag].slice(0, 20) : lead!.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase()) };
          await host.saveLead(lead);
          say(n, what);
          break;
        }
        case 'lead.add_note': {
          const text = fill(c.text ?? '', lead, post, lastMessage()).trim();
          if (!text) { say(n, `${what} — the note is empty`, false); break; }
          if (test) { say(n, `Would: ${what}`); break; }
          lead = { ...lead!, notes: [...lead!.notes, { text, at: host.now().toISOString() }].slice(-200) };
          await host.saveLead(lead);
          say(n, what);
          break;
        }
        case 'task.create': {
          const text = fill(c.text ?? '', lead, post, lastMessage()).trim() || 'Follow up';
          const dueDate = isoDay(new Date(host.now().getTime() + Number(c.days || 0) * 86_400_000));
          if (test) { say(n, `Would create the task “${text}”, due ${dueDate}`); break; }
          await host.addTask({ id: host.newId(), text, due: '', dueDate, leadId: lead?.id ?? null, done: false });
          say(n, `Created the task “${text}”, due ${dueDate}`);
          break;
        }
        case 'message.draft': {
          if (test) { say(n, `Would: ${what}`); break; }
          const text = await host.draft(lead!);
          conv = conv ?? (await host.conversationForLead(lead!.id));
          const channel = c.channel || 'Email';
          conv = conv
            ? { ...conv, suggestion: text }
            : {
              id: host.newId(), name: lead!.name, company: lead!.company, channel, leadId: lead!.id,
              address: channel === 'Email' ? lead!.email : channel === 'WhatsApp' ? lead!.phone : null,
              unread: false, important: false, intent: 'Outreach', sentiment: '', suggestion: text, msgs: [], notes: [],
            };
          await host.saveConversation(conv);
          say(n, `Drafted a message to ${lead!.name}. It is in the conversation as the suggested reply.`);
          break;
        }
        case 'message.send': {
          if (test) { say(n, `Would: ${what}`); break; }
          conv = conv ?? (await host.conversationForLead(lead!.id));
          if (!conv || !conv.suggestion.trim()) { say(n, 'There is no drafted message to send.', false); return end('Failed', i); }
          const r = await host.send(conv, conv.suggestion);
          conv = (await host.conversation(conv.id)) ?? conv;
          say(n, r.note, r.ok);
          if (!r.ok) return end('Failed', i);
          break;
        }
        case 'webhook': {
          if (test) { say(n, `Would: ${what}`); break; }
          const r = await host.webhook(c.event || 'workflow.step', {
            workflow: { id: wf.id, name: wf.name }, run: run.id,
            lead: lead ? { id: lead.id, name: lead.name, company: lead.company, stage: lead.stage, tags: lead.tags } : null,
            conversation: conv ? { id: conv.id, name: conv.name, channel: conv.channel } : null,
            post: post ? { id: post.id, title: post.title, status: post.status } : null,
          });
          say(n, r.note, r.ok);
          if (!r.ok) return end('Failed', i);
          break;
        }
        case 'notify': {
          const text = fill(c.text ?? '', lead, post, lastMessage()).trim() || wf.name;
          if (test) { say(n, `Would notify: “${text}”`); break; }
          await host.notify(text, c.email === 'yes');
          say(n, `Notified the workspace: “${text}”`);
          break;
        }
        case 'wait': {
          if (test) { say(n, `Would: ${what}`); break; }
          const until = new Date(host.now().getTime() + Number(c.amount || 0) * (UNIT_MS[c.unit ?? 'hours'] ?? UNIT_MS.hours));
          say(n, `${what} — continues ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
          return end('Waiting', i + 1, until.toISOString());
        }
        case 'approval': {
          if (test) { say(n, `Would: ${what}`); break; }
          say(n, what);
          return end('Awaiting approval', i + 1);
        }
        case 'stop':
          say(n, 'Stopped');
          return end('Completed', i + 1);
      }
    } catch (e) {
      say(n, `${what} — failed: ${e instanceof Error ? e.message : 'unknown error'}`, false);
      return end('Failed', i);
    }
  }
  return end('Completed', wf.steps.length);
}

/** The most runs one event (and the events it causes in turn) may start. */
export const MAX_RUNS_PER_EVENT = 25;

export interface Dispatcher {
  workflows(): Promise<Workflow[]>;
  host: WorkflowHost;
  /** False once the workspace's daily run limit is reached. */
  mayRun(): Promise<boolean>;
  saveRun(run: Run): Promise<void>;
}

/** Starts every enabled workflow an event triggers, then those triggered by what they changed. */
export async function dispatch(first: WfEvent[], d: Dispatcher): Promise<Run[]> {
  const queue = [...first];
  const runs: Run[] = [];
  const workflows = await d.workflows();
  while (queue.length && runs.length < MAX_RUNS_PER_EVENT) {
    const ev = queue.shift()!;
    for (const wf of workflows) {
      if (!triggeredBy(wf, ev) || workflowProblem(wf.steps)) continue;
      if (runs.length >= MAX_RUNS_PER_EVENT || !(await d.mayRun())) return runs;
      const subject: RunSubject = { leadId: ev.leadId, conversationId: ev.conversationId, postId: ev.postId, label: ev.label };
      const out = await advance(newRun(d.host.newId(), wf, subject, d.host.now(), { chain: ev.chain }), wf, d.host);
      await d.saveRun(out.run);
      runs.push(out.run);
      queue.push(...out.events);
    }
  }
  return runs;
}

/** Continues a run after its delay or approval, and starts whatever its changes trigger. */
export async function resume(run: Run, d: Dispatcher): Promise<Run> {
  const wf = (await d.workflows()).find((w) => w.id === run.workflowId);
  if (!wf) return run;
  const out = await advance(run, wf, d.host);
  await d.saveRun(out.run);
  if (out.events.length) await dispatch(out.events, d);
  return out.run;
}
