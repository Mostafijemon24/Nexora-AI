// Local backend, selected only when VITE_API_URL is unset, so the app runs without the Nexora AI
// API. The workspace starts empty and is kept in this device's storage between launches. With no
// server there is nothing to hold credentials or call a provider, so integrations and provider
// keys cannot be connected and AI answers are built-in examples; it is never a substitute for
// server-side license enforcement. Adding `?sample` to the address loads the design prototype's
// sample data instead (never stored), where connections are simulated, for previews and screenshots.

import type { Backend, LicenseStatus } from './backend';
import { funnel, inRange } from '../lib/analytics';
import { CsvError, leadsFromCsv } from '../lib/csv';
import { addDays, shortDate, toIsoDate, weekOf, fullDate } from '../lib/dates';
import { CATALOG } from '../lib/integrations';
import { rankLeads } from '../lib/scoring';
import { newLead, PROVIDER_NAMES } from '../lib/types';
import type {
  ActivationResult, Change, Conversation, DashboardMetrics, DeviceInfo, GeneratedPost, Integration, Lead, LicenseEvent, LicenseState, Message,
  OpenRouterModel, Post, Range, Run, Task, Tone, WorkspaceSnapshot,
} from '../lib/types';
import {
  advance, dispatch, makeStep, newRun, resume, scheduleDue, workflowProblem, type Dispatcher, type WfEvent, type WorkflowHost,
} from '../lib/workflow';

/** Demo license keys, one per server outcome. */
export const DEMO_KEYS = {
  valid: 'NXR-VALID-0001',
  expired: 'NXR-EXPIRED-0002',
  revoked: 'NXR-REVOKED-0003',
  inUse: 'NXR-INUSE-0004',
  unavailable: 'NXR-OFFLINE-0005',
} as const;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LS_KEY = 'nexora.demo.license';
const LS_WORKSPACE = 'nexora.local.workspace';
const LS_SCHEDULES = 'nexora.local.schedules';

const catalog = (connected: (id: string) => boolean = () => false): Integration[] => CATALOG.map((g) => ({
  id: g.id, name: g.name, cat: g.cat, desc: g.desc, oauth: g.kind === 'oauth', connected: connected(g.id),
  ...(g.fields ? { fields: g.fields } : {}), ...(g.kind === 'hook' ? { hook: true } : {}),
}));

/** A new workspace: no leads, posts, conversations or workflows, nothing connected. */
export function emptyWorkspace(): WorkspaceSnapshot {
  return {
    plan: { name: 'Professional', hosting: 'Hybrid hosting' },
    profile: { name: '', email: '', workspace: 'My workspace' },
    leads: [],
    campaigns: [],
    icp: { industry: '', title: '', sizeMin: '', sizeMax: '', location: '' },
    prompts: [],
    posts: [],
    conversations: [],
    savedReplies: [],
    workflows: [],
    runs: [],
    integrations: catalog(),
    tasks: [],
    activity: [],
    routing: { 'Content generation': 'OpenAI', 'Lead research': 'OpenAI', 'Reply suggestions': 'OpenAI' },
    providers: PROVIDER_NAMES.map((name) => ({ name, verified: false })),
    openRouter: { defaultModel: '', fallbackModel: '', monthlyBudgetUsd: '' },
    mfa: false,
    sessions: [{ id: 'this-device', device: 'This device', meta: 'Active now', current: true }],
    sync: { region: 'Singapore', endpoint: '', offlineCache: true, conflict: 'ask', lastBackupAt: '' },
    aiUsage: { postsGenerated: 0, tokensThisMonth: 0, costThisMonthUsd: 0 },
    brandVoice: 'plain, specific, no hype',
    automationDailyRunLimit: 500,
  };
}

/** The workspace saved on this device, or a new empty one. */
function storedWorkspace(): WorkspaceSnapshot {
  const fresh = emptyWorkspace();
  try {
    const raw = localStorage.getItem(LS_WORKSPACE);
    if (!raw) return fresh;
    const saved = JSON.parse(raw) as Partial<WorkspaceSnapshot>;
    // Nothing can be connected without a server, whatever an earlier build stored.
    const ws = { ...fresh, ...saved, integrations: fresh.integrations, providers: fresh.providers };
    // Data saved by an earlier version lacks the newer lead fields.
    ws.leads = ws.leads.map((l) => newLead(l.id, l.name, l.company, l.createdAt ?? new Date().toISOString(), l));
    return ws;
  } catch {
    return fresh; // storage unavailable or unreadable
  }
}

const NO_SERVER = 'This build is not connected to a Nexora AI server.';
const sampleRequested = (): boolean => typeof location !== 'undefined' && new URLSearchParams(location.search).has('sample');

const bar = (label: string, value: number) => ({ label, value });

/** Dashboard numbers counted from the workspace itself: replies received per period, and the lead funnel. */
export function workspaceMetrics(ws: WorkspaceSnapshot, range: Range, now: Date): DashboardMetrics {
  const received = ws.conversations.flatMap((c) => c.msgs.filter((m) => !m.me).map((m) => new Date(m.at).getTime()));
  const between = (from: Date, to: Date) => received.filter((t) => t >= from.getTime() && t < to.getTime()).length;
  const [y, mo, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const bars = range === '7d'
    ? Array.from({ length: 7 }, (_, i) => {
      const from = new Date(y, mo, d - 6 + i);
      return bar('SMTWTFS'[from.getDay()], between(from, new Date(y, mo, d - 5 + i)));
    })
    : range === '30d'
      ? Array.from({ length: 4 }, (_, i) => bar(`W${i + 1}`, between(new Date(y, mo, d - 27 + i * 7), new Date(y, mo, d - 20 + i * 7))))
      : Array.from({ length: 3 }, (_, i) => {
        const from = new Date(y, mo - 2 + i, 1);
        return bar(from.toLocaleString('en', { month: 'short' }), between(from, new Date(y, mo - 1 + i, 1)));
      });
  return { bars, funnel: funnel(ws.leads.filter((l) => inRange(l.createdAt, range, now))) };
}

function sampleWorkspace(now: Date): WorkspaceSnapshot {
  const week = weekOf(now);
  const today = toIsoDate(now);
  const at = (dayOffset: number, h: number, m: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m);
    return d.toISOString();
  };
  return {
    plan: { name: 'Professional', hosting: 'Hybrid hosting' },
    profile: { name: 'Rafiq Hasan', email: 'rafiq@northwind.example', workspace: 'Northwind Growth' },
    leads: [
      newLead('l1', 'John Smith', 'Brightlane Media', at(-1, 9, 0), { title: 'Founder', industry: 'Marketing & Advertising', size: 42, country: 'United States', email: 'john@brightlane.example', stage: 'interested', tags: ['agency', 'priority'], campaignId: 'cm1', notes: [{ text: 'Asked about the team plan.', at: at(-1, 10, 0) }] }),
      newLead('l2', 'Sarah Johnson', 'Peak Digital', at(-2, 9, 0), { title: 'CEO', industry: 'Marketing', size: 130, country: 'United States', email: 'sarah@peakdigital.example', stage: 'contacted', tags: ['agency'], campaignId: 'cm1' }),
      newLead('l3', 'David Miller', 'Orbit Labs', at(-3, 9, 0), { title: 'Head of Growth', industry: 'Software', size: 60, country: 'Canada', phone: '+1 416 555 0134', stage: 'converted', campaignId: 'cm1' }),
      newLead('l4', 'Priya Nair', 'Signal Works', at(-4, 9, 0), { title: 'Founder & CEO', industry: 'Marketing', country: 'United States' }),
      newLead('l5', 'Tom Becker', 'Kiln Studio', at(-5, 9, 0), { title: 'Marketing Director', size: 18, country: 'Germany' }),
      newLead('l6', 'Aisha Rahman', 'Delta Reach', at(-20, 9, 0), { title: 'CEO', industry: 'Marketing', size: 75, stage: 'contacted' }),
    ],
    campaigns: [
      { id: 'cm1', name: 'Agency founders Q4', goal: 'Book 10 discovery calls with agency founders', channel: 'Email', status: 'Active', startDate: addDays(today, -14), endDate: addDays(today, 30) },
      { id: 'cm2', name: 'SaaS growth leads', goal: 'Test interest among heads of growth', channel: 'WhatsApp', status: 'Draft', startDate: null, endDate: null },
    ],
    icp: { industry: 'Marketing', title: 'Founder, CEO', sizeMin: '10', sizeMax: '100', location: 'United States' },
    prompts: [
      { id: 'p1', title: 'Top leads today', text: 'Which leads score highest against my target criteria?' },
      { id: 'p2', title: 'Post idea', text: 'Suggest a post hook for marketing agency founders.' },
      { id: 'p3', title: 'Inbox triage', text: 'Which replies should I answer first?' },
    ],
    posts: [
      { id: 'po1', title: '3 outreach mistakes agencies make', body: 'Most agencies pitch before they listen.', status: 'Scheduled', date: addDays(today, 1) },
      { id: 'po2', title: 'Why lead scoring beats list size', body: 'A list of 500 means little without fit.', status: 'In review', date: null },
      { id: 'po3', title: '14 calls from 200 leads', body: 'What we changed in the follow-up plan.', status: 'Draft', date: null },
      { id: 'po4', title: 'Brand voice checklist', body: 'Five questions to keep every post consistent.', status: 'Published', date: week.includes(today) ? today : week[0] },
    ],
    conversations: [
      { id: 'c1', name: 'John Smith', company: 'Brightlane Media', channel: 'Email', leadId: 'l1', address: 'john@brightlane.example', unread: true, important: true, intent: 'Pricing request', sentiment: 'Positive',
        suggestion: 'Thanks John — happy to share pricing. Would a 20-minute call on Thursday work to match a plan to your team size?',
        msgs: [{ me: false, text: 'Hello! Can you share your pricing?', at: at(0, 9, 2) }], notes: ['Asked about team plan last month.'] },
      { id: 'c2', name: 'Sarah Johnson', company: 'Peak Digital', channel: 'Manual import', leadId: 'l2', unread: true, important: false, intent: 'Information request', sentiment: 'Neutral',
        suggestion: 'Hi Sarah — here is a short overview of how we work with agencies. Which service matters most to you right now?',
        msgs: [{ me: true, text: 'Hi Sarah, thanks for connecting.', at: at(-3, 15, 0) }, { me: false, text: 'Please share details about your services.', at: at(0, 8, 47) }], notes: [] },
      { id: 'c3', name: 'David Miller', company: 'Orbit Labs', channel: 'WhatsApp', leadId: 'l3', address: '+1 416 555 0134', unread: false, important: false, intent: 'Meeting', sentiment: 'Positive',
        suggestion: 'Great — I have Wednesday 3pm or Thursday 11am open. Which suits you?',
        msgs: [{ me: false, text: 'Let’s schedule a call.', at: at(-1, 16, 30) }], notes: [] },
    ],
    savedReplies: [
      { title: 'Pricing overview', text: 'Thanks for asking — our plans start at $9 per month. I can send a one-page comparison if helpful.' },
      { title: 'Book a call', text: 'Happy to walk you through it. Here are two slots: Wednesday 3pm or Thursday 11am.' },
      { title: 'Send details', text: 'Sharing a short overview of our services below. Tell me which part is most relevant.' },
    ],
    workflows: [
      { id: 'w1', name: 'Score and draft for new leads', on: true, steps: [
        makeStep('lead.created'), makeStep('if.lead_score', { op: 'gte', value: '70' }), makeStep('message.draft'),
        makeStep('approval', { note: 'Review the drafted message' }), makeStep('lead.set_stage', { stage: 'contacted' })] },
      { id: 'w2', name: 'Follow-up reminder', on: true, steps: [
        makeStep('message.received'), makeStep('wait', { amount: '24', unit: 'hours' }), makeStep('notify', { text: 'Follow up with {{lead.name}}' })] },
      { id: 'w3', name: 'Weekly content review', on: false, steps: [
        makeStep('schedule', { every: 'week', weekday: '1', time: '09:00' }), makeStep('notify', { text: 'Review the drafts waiting for approval' })] },
    ],
    runs: [],
    integrations: catalog((id) => ['oa', 'ge', 'hs', 'wa'].includes(id)),
    tasks: [
      { id: 't1', text: 'Follow up with Sarah Johnson', due: '', dueDate: today, leadId: 'l2', done: false },
      { id: 't2', text: 'Publish “3 outreach mistakes” manually', due: '', dueDate: addDays(today, 1), done: false },
      { id: 't3', text: 'Review AI drafts awaiting approval', due: '', dueDate: addDays(today, 2), done: false },
    ],
    activity: [
      { text: 'Workflow “Score new leads” ran 12 times', at: at(0, 9, 12) },
      { text: 'Post “Brand voice checklist” published', at: at(0, 8, 40) },
      { text: 'HubSpot sync completed', at: at(0, 8, 5) },
      { text: '48 leads imported from CSV', at: at(-1, 17, 20) },
    ],
    routing: { 'Content generation': 'Google Gemini', 'Lead research': 'OpenAI', 'Reply suggestions': 'OpenAI' },
    providers: [
      { name: 'OpenAI', verified: true }, { name: 'Google Gemini', verified: true },
      { name: 'Anthropic Claude', verified: false }, { name: 'OpenRouter', verified: false },
    ],
    openRouter: { defaultModel: 'openai/gpt-4o-mini', fallbackModel: '', monthlyBudgetUsd: '20' },
    mfa: true,
    sessions: [
      { id: 's1', device: 'This device', meta: 'Dhaka · active now', current: true },
      { id: 's2', device: 'Chrome on Windows', meta: 'Dhaka · 2 hours ago', current: false },
      { id: 's3', device: 'Edge on Windows', meta: 'Chattogram · 3 days ago', current: false },
    ],
    sync: { region: 'Singapore', endpoint: '', offlineCache: true, conflict: 'ask', lastBackupAt: at(0, 3, 0) },
    aiUsage: { postsGenerated: 14, tokensThisMonth: 412_000, costThisMonthUsd: 6.8 },
    brandVoice: 'plain, specific, no hype',
    automationDailyRunLimit: 500,
  };
}

const MODELS: OpenRouterModel[] = [
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct', context: '131k', free: true, available: true },
  { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (exp)', context: '1M', free: true, available: false },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', context: '128k', free: false, price: '$0.15 in · $0.60 out', available: true },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', context: '200k', free: false, price: '$3.00 in · $15.00 out', available: true },
  { id: 'mistralai/mistral-small', name: 'Mistral Small', context: '32k', free: false, price: '$0.20 in · $0.60 out', available: true },
];

/** Chart numbers of the sample workspace. */
const METRICS: Record<Range, { m: number; labels: string[]; values: number[] }> = {
  '7d': { m: 1, labels: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], values: [3, 5, 2, 6, 4, 1, 2] },
  '30d': { m: 4.6, labels: ['W1', 'W2', 'W3', 'W4'], values: [18, 24, 15, 20] },
  '90d': { m: 14, labels: ['Sep', 'Oct', 'Nov'], values: [71, 88, 82] },
};

export function makePost(topic: string, audience: string, tone: Tone, variant: number): GeneratedPost {
  const t = topic.trim();
  const a = audience.trim() || 'your buyers';
  const hooks: Record<Tone, [string, string]> = {
    Direct: [`Most ${a} get ${t} wrong. Here is the fix.`, `Stop overthinking ${t}. Do this instead.`],
    Story: [`Last quarter we nearly gave up on ${t}.`, `One client question about ${t} changed our process.`],
    Data: [`We reviewed 200 conversations about ${t}. One pattern stood out.`, `3 numbers that changed how we approach ${t}.`],
  };
  const bodies: Record<Tone, string> = {
    Direct: `1. Start with the other person’s problem, not your offer.\n2. Keep the first message under 60 words.\n3. Ask one question that is easy to answer.\n\nThat is the whole playbook for ${t}.`,
    Story: `We had done everything “right” and still heard nothing back.\n\nThen we rewrote our approach to ${t} around one idea: be useful before being visible.\n\nReplies came back within the week.`,
    Data: `• Messages under 60 words got more replies.\n• A specific question outperformed a generic pitch.\n• A second follow-up mattered more than the first message.\n\nFor ${a}, ${t} is a process, not a talent.`,
  };
  const tag = t.replace(/[^a-zA-Z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return { hook: hooks[tone][variant % 2], body: bodies[tone], cta: `What has worked for you with ${t}?`, tags: `#${tag} #B2BMarketing #LinkedInGrowth` };
}

export function createDemoBackend(now: () => Date = () => new Date(), sample = sampleRequested()): Backend {
  const ws = sample ? sampleWorkspace(now()) : storedWorkspace();
  /** Keeps the workspace on this device. Sample data is never stored. */
  const store = () => {
    if (sample) return;
    try { localStorage.setItem(LS_WORKSPACE, JSON.stringify(ws)); } catch { /* storage unavailable */ }
  };
  const seen = new Set<string>();
  let license: LicenseState | null = null;
  let events: LicenseEvent[] = [];

  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved) license = JSON.parse(saved) as LicenseState;
  } catch { /* storage unavailable */ }
  const persist = () => {
    try {
      if (license) localStorage.setItem(LS_KEY, JSON.stringify(license));
      else localStorage.removeItem(LS_KEY);
    } catch { /* storage unavailable */ }
  };

  const devLabel = (d: DeviceInfo) => `${d.name} · ${d.os}`;
  const log = (text: string) => { events = [{ text, at: now().toISOString() }, ...events].slice(0, 6); };

  const grant = (key: string, device: DeviceInfo, note?: string): ActivationResult => {
    const n = now();
    license = {
      keyMasked: `NXR-••••-${key.slice(-4)}`,
      plan: 'Professional',
      priceLabel: '$29 / month',
      renewsOn: fullDate(new Date(n.getFullYear(), n.getMonth() + 1, n.getDate())),
      deviceName: device.name,
      deviceOs: device.os,
      activatedAt: shortDate(n),
      activeDevices: 1,
      maxDevices: 1,
      graceUntil: device.platform === 'web' ? undefined : new Date(n.getTime() + 7 * 86_400_000).toISOString(),
    };
    persist();
    log(note ?? `Activated on ${devLabel(device)}`);
    return { ok: true, license, entitlementToken: '' };
  };

  // Keeps this copy of the workspace in step with the client's optimistic writes.
  const collections: Record<string, keyof WorkspaceSnapshot> = {
    post: 'posts', prompt: 'prompts', activity: 'activity', conversation: 'conversations', workflow: 'workflows',
    task: 'tasks', integration: 'integrations', session: 'sessions', lead: 'leads', campaign: 'campaigns',
  };
  const singletons: Record<string, keyof WorkspaceSnapshot> = {
    profile: 'profile', icp: 'icp', routing: 'routing', openrouter: 'openRouter', sync: 'sync',
  };

  const firstMessage = (l: Lead) =>
    `Hi ${l.name.split(' ')[0]} — I saw ${l.company} is growing${l.industry ? ` in ${l.industry.toLowerCase()}` : ''}. We help teams like yours turn outreach into booked conversations. Open to a quick exchange of notes?`;
  const put = <T extends { id: string }>(list: T[], item: T, front = true) => {
    const i = list.findIndex((x) => x.id === item.id);
    if (i >= 0) list[i] = item; else if (front) list.unshift(item); else list.push(item);
  };
  const NOT_SENT = 'This build runs without a server, so the reply was kept here and not sent.';
  const addReply = (conversationId: string, text: string, id: string, at: string): { ok: boolean; note: string } => {
    const c = ws.conversations.find((x) => x.id === conversationId);
    if (!c) return { ok: false, note: 'That conversation does not exist.' };
    c.msgs = [...c.msgs.filter((m) => m.id !== id), { id, me: true, text, at, status: 'saved', error: NOT_SENT }];
    c.unread = false;
    return { ok: false, note: NOT_SENT };
  };

  // The workflow engine, over this device's copy of the workspace.
  const host: WorkflowHost = {
    now,
    newId: () => crypto.randomUUID(),
    icp: async () => ws.icp,
    lead: async (id) => structuredClone(ws.leads.find((l) => l.id === id) ?? null),
    saveLead: async (lead) => { put(ws.leads, lead, false); },
    conversation: async (id) => structuredClone(ws.conversations.find((c) => c.id === id) ?? null),
    conversationForLead: async (id) => structuredClone(ws.conversations.find((c) => c.leadId === id) ?? null),
    saveConversation: async (c) => { put(ws.conversations, c, false); },
    post: async (id) => ws.posts.find((p) => p.id === id) ?? null,
    addTask: async (t: Task) => { ws.tasks.unshift(t); },
    notify: async (text) => { ws.activity = [{ text, at: now().toISOString() }, ...ws.activity].slice(0, 6); },
    draft: async (lead) => firstMessage(lead),
    send: async (c, text) => addReply(c.id, text, crypto.randomUUID(), now().toISOString()),
    webhook: async () => ({ ok: false, note: 'Webhooks need a Nexora AI server; this build runs without one.' }),
  };
  const dispatcher: Dispatcher = {
    host,
    workflows: async () => ws.workflows,
    mayRun: async () => ws.runs.filter((r) => !r.test && Date.parse(r.at) >= now().getTime() - 86_400_000).length < ws.automationDailyRunLimit,
    saveRun: async (run) => { put(ws.runs, run as Run); ws.runs.splice(50); },
  };

  /** Applies one write. Returns the events it caused and anything still to do once it is stored. */
  const apply = (c: Change): { events: WfEvent[]; then?: () => Promise<unknown> } => {
    const none = { events: [] as WfEvent[] };
    if (seen.has(c.id)) return none;
    seen.add(c.id);
    const events: WfEvent[] = [];
    if (c.entity === 'message' && c.op === 'upsert') {
      const m = c.data as { id: string; conversationId: string; text: string; at?: string };
      addReply(m.conversationId, m.text, m.id, m.at ?? now().toISOString());
      return none;
    }
    if (c.entity === 'run' && c.op === 'upsert') {
      const r = c.data as Run;
      const existing = ws.runs.find((x) => x.id === r.id);
      if (!existing) {
        return { events, then: async () => {
          const wf = ws.workflows.find((f) => f.id === r.workflowId);
          if (!wf) throw new Error('That workflow does not exist.');
          const problem = workflowProblem(wf.steps);
          if (problem) throw new Error(problem);
          if (!r.test && !(await dispatcher.mayRun())) throw new Error(`The daily limit of ${ws.automationDailyRunLimit} runs has been reached.`);
          const lead = ws.leads.find((l) => l.id === r.subject?.leadId);
          const out = await advance(newRun(r.id, wf, lead ? { leadId: lead.id, label: lead.name } : {}, now(), { test: r.test }), wf, host);
          await dispatcher.saveRun(out.run);
          await dispatch(out.events, dispatcher);
        } };
      }
      if (existing.status !== 'Awaiting approval' || (r.status !== 'Completed' && r.status !== 'Rejected')) return none;
      if (r.status === 'Rejected') { existing.status = 'Rejected'; return none; }
      existing.status = 'Waiting';
      existing.log = [...(existing.log ?? []), { step: existing.cursor ?? 1, text: 'Approved', ok: true, at: now().toISOString() }];
      return { events, then: () => resume(existing, dispatcher) };
    }
    const coll = collections[c.entity];
    if (coll) {
      const list = ws[coll] as unknown as { id: string }[];
      const i = list.findIndex((x) => x.id === c.entityId);
      if (c.op === 'delete') {
        if (i >= 0) list.splice(i, 1);
        if (coll === 'workflows') ws.runs = ws.runs.filter((r) => r.workflowId !== c.entityId);
        if (coll === 'campaigns') for (const l of ws.leads) if (l.campaignId === c.entityId) l.campaignId = null;
        return none;
      }
      if (coll === 'leads') {
        const l = c.data as Lead;
        const before = list[i] as Lead | undefined;
        if (!before) events.push({ kind: 'lead.created', leadId: l.id, label: l.name });
        else if (before.stage !== l.stage) events.push({ kind: 'lead.stage_changed', leadId: l.id, to: l.stage, label: l.name });
        if (before) l.createdAt = before.createdAt;
      }
      if (coll === 'posts') {
        const p = c.data as Post;
        const before = list[i] as Post | undefined;
        if (before && before.status !== p.status) events.push({ kind: 'post.status_changed', postId: p.id, to: p.status, label: p.title });
      }
      if (coll === 'conversations' && i >= 0) {
        // The engine may have added to this conversation since the client last loaded it: keep those messages.
        const v = c.data as Conversation;
        const have = (list[i] as Conversation).msgs;
        const same = (x: Message, y: Message) => (x.id && y.id ? x.id === y.id : x.me === y.me && x.at === y.at && x.text === y.text);
        v.msgs = [...have, ...v.msgs.filter((m) => !have.some((x) => same(x, m)))].map(({ queued: _queued, ...m }) => m);
      }
      if (i >= 0) list[i] = c.data as { id: string };
      else if (coll === 'leads' || coll === 'campaigns') list.push(c.data as { id: string });
      else list.unshift(c.data as { id: string });
      if (coll === 'activity') list.splice(6); // the dashboard shows the latest six
      return { events };
    }
    const single = singletons[c.entity];
    if (single && c.op === 'upsert') (ws as unknown as Record<string, unknown>)[single] = c.data;
    if (c.entity === 'security' && c.op === 'upsert') ws.mfa = (c.data as { mfa: boolean }).mfa;
    return none;
  };

  /** Continues waiting runs and fires schedules. Runs while the app is open, since there is no server to do it. */
  const tick = async () => {
    const t = now();
    let changed = false;
    for (const r of ws.runs.filter((x) => x.status === 'Waiting' && x.resumeAt && Date.parse(x.resumeAt) <= t.getTime())) {
      r.resumeAt = null;
      await resume(r, dispatcher);
      changed = true;
    }
    let days: Record<string, string> = {};
    try { days = JSON.parse(localStorage.getItem(LS_SCHEDULES) ?? '{}') as Record<string, string>; } catch { /* storage unavailable */ }
    for (const wf of ws.workflows) {
      const due = scheduleDue(wf, t, days[wf.id] ?? null);
      if (!due || workflowProblem(wf.steps)) continue;
      days[wf.id] = due;
      const each = wf.steps[0].config?.each;
      const subjects = each ? ws.leads.filter((l) => l.stage === each).slice(0, 200).map((l) => ({ leadId: l.id, label: l.name })) : [{}];
      for (const subject of subjects) {
        if (!(await dispatcher.mayRun())) break;
        const out = await advance(newRun(crypto.randomUUID(), wf, subject, t), wf, host);
        await dispatcher.saveRun(out.run);
        await dispatch(out.events, dispatcher);
      }
      changed = true;
    }
    if (changed) {
      store();
      if (!sample) try { localStorage.setItem(LS_SCHEDULES, JSON.stringify(days)); } catch { /* storage unavailable */ }
    }
    return changed;
  };

  const reply = (q: string): string => {
    const s = q.toLowerCase();
    const top = rankLeads(ws.leads, ws.icp)[0];
    const unread = ws.conversations.filter((c) => c.unread);
    if (/score|lead|prospect/.test(s) && !top) return 'There are no leads in this workspace yet. Import a CSV from Integrations and I will rank them.';
    if (/score|lead|prospect/.test(s)) return `Highest match right now is ${top.name} at ${top.company} (${top.score.total}/100, confidence ${top.score.conf}/10). Open Lead scoring to see what was found and what is missing.`;
    if (/post|content|hook/.test(s)) return 'Try a hook built on one specific number from your own results, then one lesson and one question. Content Studio can draft it — it stays a draft until you approve it.';
    if (/reply|repl|message|inbox|answer/.test(s)) return unread.length ? `You have ${unread.length} unread. Start with ${unread[0].name} — intent: ${unread[0].intent.toLowerCase()}.` : 'Inbox is clear. No unread conversations.';
    return 'I can help with lead scoring, post drafts and reply suggestions. I flag missing data rather than guessing.';
  };

  return {
    demo: true,
    canConnect: sample,
    license: {
      async status(): Promise<LicenseStatus> {
        return { license, events };
      },
      async activate(raw, device) {
        await wait(800);
        const key = raw.trim().toUpperCase();
        const fail = (r: ActivationResult & { ok: false }, title: string): ActivationResult => { log(`Failed activation: ${title}`); return r; };
        if (key === DEMO_KEYS.valid) return grant(key, device);
        if (key === DEMO_KEYS.expired) return fail({ ok: false, code: 'expired', expiredOn: '1 October 2026' }, 'License expired');
        if (key === DEMO_KEYS.revoked) return fail({ ok: false, code: 'revoked' }, 'License revoked');
        if (key === DEMO_KEYS.inUse) return fail({ ok: false, code: 'in_use', deviceName: 'RAFIQ-LAPTOP', deviceOs: 'Windows 10', activatedAt: '14 Nov 2026' }, 'Already active on another device');
        if (key === DEMO_KEYS.unavailable) return fail({ ok: false, code: 'unavailable' }, 'License server unavailable');
        return fail({ ok: false, code: 'invalid' }, 'Invalid license key');
      },
      async requestTransfer() { await wait(300); },
      async confirmTransfer(raw, code, device) {
        await wait(500);
        if (!/^\d{6}$/.test(code.trim())) return { ok: false, code: 'bad_code' };
        return grant(raw.trim().toUpperCase(), device, `Transferred from RAFIQ-LAPTOP to ${devLabel(device)}`);
      },
      async deactivate(device) {
        license = null;
        persist();
        log(`Deactivated on ${devLabel(device)}`);
      },
    },
    workspace: {
      async metrics(range) {
        if (!sample) return workspaceMetrics(ws, range, now());
        const r = METRICS[range];
        const f = [64, 41, 17, 6].map((v) => Math.round(v * r.m)) as [number, number, number, number];
        return { bars: r.values.map((value, i) => ({ label: r.labels[i], value })), funnel: f };
      },
      async load() {
        await tick();
        return structuredClone(ws);
      },
      async push(changes) {
        await wait(150);
        let effects = false;
        try {
          for (const c of changes) {
            const { events, then } = apply(c);
            if (then) { await then(); effects = true; }
            if (c.entity === 'message') effects = true;
            if ((await dispatch(events, dispatcher)).length) effects = true;
          }
        } finally {
          store();
        }
        return { effects };
      },
    },
    ai: {
      async chat(history) { await wait(700); return { text: reply(history[history.length - 1]?.text ?? '') }; },
      async generatePost({ topic, audience, tone, variant }) {
        await wait(800);
        ws.aiUsage.postsGenerated++;
        store();
        return makePost(topic, audience, tone, variant);
      },
      async draftMessage(leadId) {
        await wait(400);
        const l = ws.leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Lead not found.');
        return { text: firstMessage(l) };
      },
    },
    leads: {
      async importCsv(csv) {
        await wait(300);
        let parsed: ReturnType<typeof leadsFromCsv>;
        try { parsed = leadsFromCsv(csv, now().toISOString(), () => crypto.randomUUID()); } catch (e) {
          throw e instanceof CsvError ? new Error(e.message) : e;
        }
        ws.leads.push(...parsed.leads);
        await dispatch(parsed.leads.map((l) => ({ kind: 'lead.created' as const, leadId: l.id, label: l.name })), dispatcher);
        store();
        return { imported: parsed.leads.length, skipped: parsed.skipped, leads: structuredClone(ws.leads) };
      },
    },
    integrations: {
      async test(id) {
        await wait(900);
        const g = ws.integrations.find((x) => x.id === id);
        return { latencyMs: 120 + (g?.name.length ?? 0) * 9 };
      },
      async connect(id) {
        if (!sample) throw new Error(NO_SERVER);
        await wait(300);
        const g = ws.integrations.find((x) => x.id === id);
        if (g) g.connected = true;
        store();
        return {};
      },
      async disconnect(id) {
        const g = ws.integrations.find((x) => x.id === id);
        if (g) g.connected = false;
        store();
      },
    },
    providers: {
      async verifyKey(name, key) {
        if (!sample) throw new Error(NO_SERVER);
        await wait(800);
        const p = ws.providers.find((x) => x.name === name);
        const ok = key.trim() ? true : (p?.verified ?? false); // empty key re-checks the stored one
        if (p) p.verified = ok;
        store();
        return ok;
      },
      async openRouterModels() { await wait(300); return structuredClone(MODELS); },
    },
    system: {
      async backup() {
        await wait(400);
        ws.sync.lastBackupAt = now().toISOString();
        store();
        return ws.sync.lastBackupAt;
      },
      async revokeSession(id) { ws.sessions = ws.sessions.filter((s) => s.id !== id); store(); },
    },
  };
}
