import { describe, expect, it } from 'vitest';
import { createDemoBackend, workspaceMetrics } from './demo';
import { newLead, type Change, type Conversation } from '../lib/types';
import { makeStep } from '../lib/workflow';

const NOW = new Date(2026, 10, 24, 10, 0); // Tuesday 24 November 2026
const local = () => createDemoBackend(() => NOW, false);

describe('local backend', () => {
  it('starts with an empty workspace and nothing connected', async () => {
    const ws = await local().workspace.load();
    for (const k of ['leads', 'campaigns', 'prompts', 'posts', 'conversations', 'savedReplies', 'workflows', 'runs', 'tasks', 'activity'] as const) {
      expect(ws[k], k).toEqual([]);
    }
    expect(ws.profile.name).toBe('');
    expect(ws.integrations.length).toBeGreaterThan(0);
    expect(ws.integrations.some((g) => g.connected)).toBe(false);
    expect(ws.providers.some((p) => p.verified)).toBe(false);
    expect(ws.sessions).toHaveLength(1);
    expect(ws.aiUsage).toEqual({ postsGenerated: 0, tokensThisMonth: 0, costThisMonthUsd: 0 });
  });

  it('reports zero metrics until there is data, then counts imported leads', async () => {
    const b = local();
    for (const range of ['7d', '30d', '90d'] as const) {
      const m = await b.workspace.metrics(range);
      expect(m.funnel).toEqual([0, 0, 0, 0]);
      expect(m.bars.every((x) => x.value === 0)).toBe(true);
    }
    const r = await b.leads.importCsv('name,company\nAda,Engines Ltd\nGrace,Compilers Inc\n,missing name');
    expect(r).toMatchObject({ imported: 2, skipped: 1 });
    expect((await b.workspace.metrics('7d')).funnel).toEqual([2, 0, 0, 0]);
    const [ada] = (await b.workspace.load()).leads;
    await b.workspace.push([{ id: 'x1', entity: 'lead', op: 'upsert', entityId: ada.id, data: { ...ada, stage: 'interested' }, at: NOW.toISOString() }]);
    expect((await b.workspace.metrics('7d')).funnel).toEqual([2, 1, 1, 0]);
  });

  it('answers a lead question when there are no leads', async () => {
    const a = await local().ai.chat([{ me: true, text: 'Which leads score highest?' }], 'Lead research');
    expect(a.text).toMatch(/no leads/i);
  });

  it('refuses to connect anything without a server', async () => {
    const b = local();
    expect(b.canConnect).toBe(false);
    await expect(b.integrations.connect('li')).rejects.toThrow(/not connected to a Nexora AI server/);
    await expect(b.providers.verifyKey('OpenAI', 'sk-anything')).rejects.toThrow(/not connected to a Nexora AI server/);
    const ws = await b.workspace.load();
    expect(ws.integrations.some((g) => g.connected) || ws.providers.some((p) => p.verified)).toBe(false);
  });

  it('keeps sample data, with simulated connections, available on request', async () => {
    const b = createDemoBackend(() => NOW, true);
    expect((await b.workspace.load()).leads.length).toBeGreaterThan(0);
    expect(b.canConnect).toBe(true);
    await b.integrations.connect('li');
    expect((await b.workspace.load()).integrations.find((g) => g.id === 'li')?.connected).toBe(true);
  });
});

describe('local workflows', () => {
  let n = 0;
  const ch = (entity: string, entityId: string, data?: unknown, op: Change['op'] = 'upsert'): Change => ({ id: `c${++n}`, entity, op, entityId, data, at: NOW.toISOString() });
  const lead = (id: string, rest = {}) => newLead(id, `Lead ${id}`, 'Acme', NOW.toISOString(), rest);

  it('runs a workflow when a lead is added, and reports that more changed', async () => {
    const b = local();
    const wf = { id: 'w1', name: 'Tag new leads', on: true, steps: [makeStep('lead.created'), makeStep('lead.add_tag', { tag: 'new' }), makeStep('task.create', { text: 'Call {{lead.name}}', days: '1' })] };
    expect(await b.workspace.push([ch('workflow', 'w1', wf)])).toEqual({ effects: false });
    expect(await b.workspace.push([ch('lead', 'a', lead('a'))])).toEqual({ effects: true });
    const ws = await b.workspace.load();
    expect(ws.leads[0].tags).toEqual(['new']);
    expect(ws.tasks[0]).toMatchObject({ text: 'Call Lead a', dueDate: '2026-11-25', leadId: 'a' });
    expect(ws.runs[0]).toMatchObject({ workflowId: 'w1', status: 'Completed', subject: { leadId: 'a' } });
    // Imported leads start workflows too.
    await b.leads.importCsv('name,company\nAda,Engines');
    expect((await b.workspace.load()).runs).toHaveLength(2);
  });

  it('waits for approval, and never claims a message was sent without a server', async () => {
    const b = local();
    const wf = { id: 'w2', name: 'Outreach', on: true, steps: [makeStep('lead.stage_changed', { to: 'interested' }), makeStep('message.draft'), makeStep('approval'), makeStep('message.send'), makeStep('lead.set_stage', { stage: 'contacted' })] };
    await b.workspace.push([ch('workflow', 'w2', wf), ch('lead', 'a', lead('a', { email: 'a@example.com' }))]);
    await b.workspace.push([ch('lead', 'a', lead('a', { email: 'a@example.com', stage: 'interested' }))]);
    let ws = await b.workspace.load();
    expect(ws.runs[0].status).toBe('Awaiting approval');
    expect(ws.conversations[0]).toMatchObject({ leadId: 'a', channel: 'Email', address: 'a@example.com', msgs: [] });
    expect(ws.conversations[0].suggestion).toMatch(/^Hi Lead/);

    await b.workspace.push([ch('run', ws.runs[0].id, { ...ws.runs[0], status: 'Completed' })]);
    ws = await b.workspace.load();
    expect(ws.runs[0].status).toBe('Failed');
    expect(ws.runs[0].log!.at(-1)).toMatchObject({ ok: false, text: expect.stringContaining('not sent') });
    expect(ws.conversations[0].msgs[0]).toMatchObject({ me: true, status: 'saved' });
    expect(ws.leads[0].stage).toBe('interested'); // the step after the failed send did not run
  });

  it('keeps a reply typed in the inbox, marked as not sent', async () => {
    const b = local();
    const conv: Conversation = { id: 'k', name: 'Ada', company: '', channel: 'Email', address: 'ada@example.com', unread: true, important: false, intent: '', sentiment: '', suggestion: '', notes: [], msgs: [] };
    await b.workspace.push([ch('conversation', 'k', conv)]);
    expect(await b.workspace.push([ch('message', 'm1', { id: 'm1', conversationId: 'k', text: 'Hello', at: NOW.toISOString() })])).toEqual({ effects: true });
    const got = (await b.workspace.load()).conversations[0];
    expect(got.unread).toBe(false);
    expect(got.msgs).toEqual([{ id: 'm1', me: true, text: 'Hello', at: NOW.toISOString(), status: 'saved', error: expect.stringContaining('without a server') }]);
  });

  it('a test run changes nothing', async () => {
    const b = local();
    const wf = { id: 'w3', name: 'Dry', on: false, steps: [makeStep('manual'), makeStep('lead.set_stage', { stage: 'lost' })] };
    await b.workspace.push([ch('workflow', 'w3', wf), ch('lead', 'a', lead('a'))]);
    await b.workspace.push([ch('run', 'r1', { id: 'r1', workflowId: 'w3', test: true, subject: { leadId: 'a' } })]);
    const ws = await b.workspace.load();
    expect(ws.runs[0]).toMatchObject({ status: 'Completed', test: true });
    expect(ws.runs[0].log![0].text).toBe('Would: Move the lead to Lost');
    expect(ws.leads[0].stage).toBe('new');
  });

  it('continues a waiting run once its delay has passed', async () => {
    let t = NOW;
    const b = createDemoBackend(() => t, false);
    const wf = { id: 'w4', name: 'Later', on: true, steps: [makeStep('lead.created'), makeStep('wait', { amount: '2', unit: 'hours' }), makeStep('lead.add_tag', { tag: 'waited' })] };
    await b.workspace.push([ch('workflow', 'w4', wf), ch('lead', 'a', lead('a'))]);
    expect((await b.workspace.load()).runs[0].status).toBe('Waiting');
    t = new Date(NOW.getTime() + 2 * 3_600_000 + 1000);
    const ws = await b.workspace.load();
    expect(ws.runs[0].status).toBe('Completed');
    expect(ws.leads[0].tags).toEqual(['waited']);
  });
});

describe('workspaceMetrics', () => {
  it('counts replies received in the period they arrived', async () => {
    const ws = await local().workspace.load();
    const at = (daysAgo: number) => new Date(2026, 10, 24 - daysAgo, 9, 0).toISOString();
    const conv: Conversation = {
      id: 'c', name: 'Ada', company: 'Engines Ltd', channel: 'Email', unread: true, important: false, intent: '', sentiment: '', suggestion: '', notes: [],
      msgs: [{ me: false, text: 'today', at: at(0) }, { me: true, text: 'mine', at: at(0) }, { me: false, text: 'last week', at: at(8) }, { me: false, text: 'in October', at: at(40) }],
    };
    const withReplies = { ...ws, conversations: [conv] };
    const week = workspaceMetrics(withReplies, '7d', NOW);
    expect(week.bars.map((b) => b.value)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(week.bars.map((b) => b.label).join('')).toBe('WTFSSMT');
    expect(workspaceMetrics(withReplies, '30d', NOW).bars.map((b) => b.value)).toEqual([0, 0, 1, 1]);
    const quarter = workspaceMetrics(withReplies, '90d', NOW);
    expect(quarter.bars.map((b) => b.label)).toEqual(['Sep', 'Oct', 'Nov']);
    expect(quarter.bars.map((b) => b.value)).toEqual([0, 1, 2]);
  });
});
