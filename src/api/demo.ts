// In-memory development backend. It exists so the UI can be run and reviewed without the
// Nexora AI API; it is selected only when VITE_API_URL is unset and is never a substitute
// for server-side license enforcement. Data and responses mirror the design prototype.

import type { Backend, LicenseStatus } from './backend';
import { addDays, shortDate, toIsoDate, weekOf, fullDate } from '../lib/dates';
import { rankLeads } from '../lib/scoring';
import type {
  ActivationResult, Change, DeviceInfo, GeneratedPost, LicenseEvent, LicenseState, OpenRouterModel, Range, Tone, WorkspaceSnapshot,
} from '../lib/types';

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

function seed(now: Date): WorkspaceSnapshot {
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
      { id: 'l1', name: 'John Smith', title: 'Founder', company: 'Brightlane Media', industry: 'Marketing & Advertising', size: 42, country: 'United States' },
      { id: 'l2', name: 'Sarah Johnson', title: 'CEO', company: 'Peak Digital', industry: 'Marketing', size: 130, country: 'United States' },
      { id: 'l3', name: 'David Miller', title: 'Head of Growth', company: 'Orbit Labs', industry: 'Software', size: 60, country: 'Canada' },
      { id: 'l4', name: 'Priya Nair', title: 'Founder & CEO', company: 'Signal Works', industry: 'Marketing', size: null, country: 'United States' },
      { id: 'l5', name: 'Tom Becker', title: 'Marketing Director', company: 'Kiln Studio', industry: null, size: 18, country: 'Germany' },
      { id: 'l6', name: 'Aisha Rahman', title: 'CEO', company: 'Delta Reach', industry: 'Marketing', size: 75, country: null },
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
      { id: 'c1', name: 'John Smith', company: 'Brightlane Media', channel: 'Email', unread: true, important: true, intent: 'Pricing request', sentiment: 'Positive',
        suggestion: 'Thanks John — happy to share pricing. Would a 20-minute call on Thursday work to match a plan to your team size?',
        msgs: [{ me: false, text: 'Hello! Can you share your pricing?', at: at(0, 9, 2) }], notes: ['Asked about team plan last month.'] },
      { id: 'c2', name: 'Sarah Johnson', company: 'Peak Digital', channel: 'Manual import', unread: true, important: false, intent: 'Information request', sentiment: 'Neutral',
        suggestion: 'Hi Sarah — here is a short overview of how we work with agencies. Which service matters most to you right now?',
        msgs: [{ me: true, text: 'Hi Sarah, thanks for connecting.', at: at(-3, 15, 0) }, { me: false, text: 'Please share details about your services.', at: at(0, 8, 47) }], notes: [] },
      { id: 'c3', name: 'David Miller', company: 'Orbit Labs', channel: 'WhatsApp', unread: false, important: false, intent: 'Meeting', sentiment: 'Positive',
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
        { type: 'Trigger', label: 'Lead created' }, { type: 'Condition', label: 'Lead score greater than 70' }, { type: 'Action', label: 'Create AI message draft' },
        { type: 'Approval', label: 'Request user approval' }, { type: 'Update', label: 'Change lead status to Contacted' }] },
      { id: 'w2', name: 'Follow-up reminder', on: true, steps: [
        { type: 'Trigger', label: 'Reply received' }, { type: 'Delay', label: 'Wait 24 hours' }, { type: 'Notification', label: 'Notify assigned user' }] },
      { id: 'w3', name: 'Weekly content review', on: false, steps: [
        { type: 'Trigger', label: 'Every Monday 09:00' }, { type: 'Notification', label: 'Notify workspace of drafts in review' }] },
    ],
    runs: [],
    integrations: [
      { id: 'li', name: 'LinkedIn', cat: 'Social', desc: 'Official OAuth. Approved scopes only.', oauth: true, connected: false },
      { id: 'oa', name: 'OpenAI', cat: 'AI', desc: 'Text and image generation.', oauth: false, connected: true },
      { id: 'ge', name: 'Google Gemini', cat: 'AI', desc: 'Content generation and research.', oauth: false, connected: true },
      { id: 'cl', name: 'Anthropic Claude', cat: 'AI', desc: 'Reply suggestions and analysis.', oauth: false, connected: false },
      { id: 'or', name: 'OpenRouter', cat: 'AI', desc: 'Bring your own key. Free and paid models from many providers.', oauth: false, connected: false },
      { id: 'hs', name: 'HubSpot', cat: 'CRM', desc: 'Two-way contact sync.', oauth: true, connected: true },
      { id: 'sf', name: 'Salesforce', cat: 'CRM', desc: 'Lead and account sync.', oauth: true, connected: false },
      { id: 'n8', name: 'n8n', cat: 'Automation', desc: 'Trigger external workflows by webhook.', oauth: false, connected: false },
      { id: 'wa', name: 'WhatsApp Cloud API', cat: 'Communication', desc: 'Approved business messaging channel.', oauth: false, connected: true },
      { id: 'gc', name: 'Google Calendar', cat: 'Communication', desc: 'Meeting and follow-up scheduling.', oauth: true, connected: false },
      { id: 'wh', name: 'Webhooks', cat: 'Developer', desc: 'Signed events for leads, posts and runs.', oauth: false, connected: false },
    ],
    tasks: [
      { id: 't1', text: 'Follow up with Sarah Johnson', due: 'Today', done: false },
      { id: 't2', text: 'Publish “3 outreach mistakes” manually', due: 'Tue', done: false },
      { id: 't3', text: 'Review AI drafts awaiting approval', due: 'Wed', done: false },
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

export function createDemoBackend(now: () => Date = () => new Date()): Backend {
  const ws = seed(now());
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

  // Keeps the demo's copy of the workspace in step with the client's optimistic writes.
  const collections: Record<string, keyof WorkspaceSnapshot> = {
    post: 'posts', prompt: 'prompts', activity: 'activity', conversation: 'conversations', workflow: 'workflows',
    run: 'runs', task: 'tasks', integration: 'integrations', session: 'sessions',
  };
  const singletons: Record<string, keyof WorkspaceSnapshot> = {
    profile: 'profile', icp: 'icp', routing: 'routing', openrouter: 'openRouter', sync: 'sync',
  };
  const apply = (c: Change) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    const coll = collections[c.entity];
    if (coll) {
      const list = ws[coll] as unknown as { id: string }[];
      const i = list.findIndex((x) => x.id === c.entityId);
      if (c.op === 'delete') { if (i >= 0) list.splice(i, 1); }
      else if (i >= 0) list[i] = c.data as { id: string };
      else list.unshift(c.data as { id: string });
      return;
    }
    const single = singletons[c.entity];
    if (single && c.op === 'upsert') (ws as unknown as Record<string, unknown>)[single] = c.data;
    if (c.entity === 'security' && c.op === 'upsert') ws.mfa = (c.data as { mfa: boolean }).mfa;
  };

  const reply = (q: string): string => {
    const s = q.toLowerCase();
    const top = rankLeads(ws.leads, ws.icp)[0];
    const unread = ws.conversations.filter((c) => c.unread);
    if (/score|lead|prospect/.test(s)) return `Highest match right now is ${top.name} at ${top.company} (${top.score.total}/100, confidence ${top.score.conf}/10). Open Lead scoring to see what was found and what is missing.`;
    if (/post|content|hook/.test(s)) return 'Try a hook built on one specific number from your own results, then one lesson and one question. Content Studio can draft it — it stays a draft until you approve it.';
    if (/reply|repl|message|inbox|answer/.test(s)) return unread.length ? `You have ${unread.length} unread. Start with ${unread[0].name} — intent: ${unread[0].intent.toLowerCase()}.` : 'Inbox is clear. No unread conversations.';
    return 'I can help with lead scoring, post drafts and reply suggestions. I flag missing data rather than guessing.';
  };

  return {
    demo: true,
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
      async load() { return structuredClone(ws); },
      async metrics(range) {
        const r = METRICS[range];
        const f = [64, 41, 17, 6].map((v) => Math.round(v * r.m)) as [number, number, number, number];
        return { bars: r.values.map((value, i) => ({ label: r.labels[i], value })), funnel: f };
      },
      async push(changes) { await wait(150); changes.forEach(apply); },
    },
    ai: {
      async chat(history) { await wait(700); return { text: reply(history[history.length - 1]?.text ?? '') }; },
      async generatePost({ topic, audience, tone, variant }) { await wait(800); return makePost(topic, audience, tone, variant); },
      async draftMessage(leadId) {
        await wait(400);
        const l = ws.leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Lead not found.');
        return { text: `Hi ${l.name.split(' ')[0]} — I saw ${l.company} is growing${l.industry ? ` in ${l.industry.toLowerCase()}` : ''}. We help teams like yours turn outreach into booked conversations. Open to a quick exchange of notes?` };
      },
    },
    integrations: {
      async test(id) {
        await wait(900);
        const g = ws.integrations.find((x) => x.id === id);
        return { latencyMs: 120 + (g?.name.length ?? 0) * 9 };
      },
      async connect(id) {
        await wait(300);
        const g = ws.integrations.find((x) => x.id === id);
        if (g) g.connected = true;
        return {};
      },
      async disconnect(id) {
        const g = ws.integrations.find((x) => x.id === id);
        if (g) g.connected = false;
      },
    },
    providers: {
      async verifyKey(name, key) {
        await wait(800);
        const p = ws.providers.find((x) => x.name === name);
        const ok = key.trim() ? true : (p?.verified ?? false); // empty key re-checks the stored one
        if (p) p.verified = ok;
        return ok;
      },
      async openRouterModels() { await wait(300); return structuredClone(MODELS); },
    },
    system: {
      async backup() { await wait(400); return now().toISOString(); },
      async revokeSession(id) { ws.sessions = ws.sessions.filter((s) => s.id !== id); },
    },
  };
}
