import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newLead } from '../../src/lib/types.ts';
import { makeStep } from '../../src/lib/workflow.ts';
import { tick } from '../src/workspace/automation.ts';
import { change, Device, harness, type Harness } from './helpers.ts';

// The AI provider is scripted: these tests are about what the engine does with a draft, not the provider.

let h: Harness;
let d: Device;
let ws: string;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const push = (c: unknown) => d.post('/v1/workspace/changes', c);
const snap = async () => (await d.get('/v1/workspace')).body;
const lead = (name: string, rest: object = {}) => { const id = randomUUID(); return newLead(id, name, 'Acme', h.ctx.now().toISOString(), rest); };
const workflow = async (name: string, steps: ReturnType<typeof makeStep>[], on = true) => {
  const id = randomUUID();
  const r = await push(change('workflow', id, { id, name, on, steps }));
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return id;
};
const runsOf = async (workflowId: string) => (await snap()).runs.filter((r: any) => r.workflowId === workflowId);
const off = async (id: string) => { const f = (await snap()).workflows.find((x: any) => x.id === id); await push(change('workflow', id, { ...f, on: false })); };

beforeAll(async () => {
  h = await harness();
  const lic = await h.license();
  ws = lic.workspaceId;
  d = new Device(h, 'native', 'PC');
  await d.activate(lic.key);
  await push(change('icp', 'icp', { industry: 'Marketing', title: 'Founder', sizeMin: '10', sizeMax: '100', location: 'United States' }));
  h.respond = (url) => (url.includes('/models') ? json({ data: [] }) : json({ model: 'm', choices: [{ message: { content: 'Hi Ada — quick question about Acme?' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  await d.post('/v1/ai/providers/verify', { name: 'OpenAI', key: 'sk-good' });
});
afterAll(async () => { await h.close(); });
beforeEach(() => { h.advance(60_000); h.mails.length = 0; });

describe('workflows run when their trigger fires', () => {
  it('runs for a new lead, stops at a failed condition, and tells the client something changed', async () => {
    const wf = await workflow('Tag good leads', [makeStep('lead.created'), makeStep('if.lead_score', { op: 'gte', value: '70' }), makeStep('lead.add_tag', { tag: 'priority' }),
      makeStep('task.create', { text: 'Call {{lead.name}}', days: '2' })]);
    const good = lead('Ada Okafor', { title: 'Founder', industry: 'Marketing', size: 40, country: 'United States' });
    const poor = lead('Ben Ito', { title: 'Intern', industry: 'Mining', size: 9000, country: 'Japan' });

    const r = await push(change('lead', good.id, good));
    expect([r.status, r.body]).toEqual([200, { effects: true }]);
    await push(change('lead', poor.id, poor));

    const s = await snap();
    expect(s.leads.find((l: any) => l.id === good.id).tags).toEqual(['priority']);
    expect(s.leads.find((l: any) => l.id === poor.id).tags).toEqual([]);
    expect(s.tasks.find((t: any) => t.leadId === good.id)).toMatchObject({ text: 'Call Ada Okafor', dueDate: '2026-11-25', done: false });
    const runs = await runsOf(wf);
    expect(runs.map((x: any) => [x.subject.label, x.status]).sort()).toEqual([['Ada Okafor', 'Completed'], ['Ben Ito', 'Stopped']]);
    expect(runs.find((x: any) => x.status === 'Stopped').log.at(-1)).toMatchObject({ step: 2, ok: true, text: expect.stringContaining('no') });
    await off(wf);
  });

  it('does not run a workflow that is switched off, or for an edit that changes nothing it watches', async () => {
    const wf = await workflow('Off', [makeStep('lead.created'), makeStep('lead.add_tag', { tag: 'x' })], false);
    const l = lead('Cara Diaz');
    expect((await push(change('lead', l.id, l))).status).toBe(204);
    expect((await push(change('lead', l.id, { ...l, title: 'CEO' }))).status).toBe(204);
    expect(await runsOf(wf)).toHaveLength(0);
  });

  it('waits for approval, drafts with AI, and only then changes the stage; a rejected run does nothing more', async () => {
    const wf = await workflow('Draft and contact', [makeStep('lead.stage_changed', { to: 'interested' }), makeStep('message.draft', { channel: 'Email' }), makeStep('approval'),
      makeStep('lead.set_stage', { stage: 'contacted' })]);
    const [a, b] = [lead('Ada Lovelace', { email: 'ada@example.com' }), lead('Bob Stone')];
    await push(change('lead', a.id, a)); await push(change('lead', b.id, b));
    await push(change('lead', a.id, { ...a, stage: 'interested' }));
    await push(change('lead', b.id, { ...b, stage: 'interested' }));
    await push(change('lead', b.id, { ...b, stage: 'lost' })); // a different stage: not this workflow's trigger

    let runs = await runsOf(wf);
    expect(runs.map((r: any) => r.status)).toEqual(['Awaiting approval', 'Awaiting approval']);
    let s = await snap();
    const conv = s.conversations.find((c: any) => c.leadId === a.id);
    expect(conv).toMatchObject({ name: 'Ada Lovelace', channel: 'Email', address: 'ada@example.com', suggestion: 'Hi Ada — quick question about Acme?', msgs: [] });
    expect(s.leads.find((l: any) => l.id === a.id).stage).toBe('interested');

    const [ra, rb] = [runs.find((r: any) => r.subject.leadId === a.id), runs.find((r: any) => r.subject.leadId === b.id)];
    // Approving twice (a double click, a replayed queue) continues the run once.
    await Promise.all([push(change('run', ra.id, { ...ra, status: 'Completed' })), push(change('run', ra.id, { ...ra, status: 'Completed' }))]);
    await push(change('run', rb.id, { ...rb, status: 'Rejected' }));
    s = await snap();
    expect(s.leads.find((l: any) => l.id === a.id).stage).toBe('contacted');
    expect(s.leads.find((l: any) => l.id === b.id).stage).toBe('lost');
    runs = await runsOf(wf);
    expect(runs.find((r: any) => r.id === ra.id)).toMatchObject({ status: 'Completed', cursor: 4 });
    expect(runs.find((r: any) => r.id === ra.id).log.filter((x: any) => x.text === 'Approved')).toHaveLength(1);
    expect(runs.find((r: any) => r.id === rb.id).status).toBe('Rejected');
    await off(wf);
  });

  it('continues after a delay only once the time has passed, and emails the owner when asked', async () => {
    const wf = await workflow('Remind', [makeStep('lead.created'), makeStep('wait', { amount: '2', unit: 'hours' }), makeStep('notify', { text: 'Follow up with {{lead.first_name}}', email: 'yes' })]);
    const l = lead('Dina Roy');
    await push(change('lead', l.id, l));
    expect((await runsOf(wf))[0]).toMatchObject({ status: 'Waiting', cursor: 2 });
    h.advance(3_600_000);
    expect(await tick(h.ctx)).toMatchObject({ resumed: 0 });
    h.advance(3_600_000);
    expect(await tick(h.ctx)).toMatchObject({ resumed: 1 });
    expect(await tick(h.ctx)).toMatchObject({ resumed: 0 });
    expect((await runsOf(wf))[0].status).toBe('Completed');
    expect((await snap()).activity[0].text).toBe('Follow up with Dina');
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].text).toContain('Follow up with Dina');
    await off(wf);
  });

  it('lets one workflow trigger another but never itself, and stops at the daily limit', async () => {
    const first = await workflow('Mark contacted', [makeStep('lead.created'), makeStep('lead.set_stage', { stage: 'contacted' })]);
    const second = await workflow('Then tag', [makeStep('lead.stage_changed'), makeStep('lead.add_tag', { tag: 'reached' }), makeStep('lead.set_stage', { stage: 'interested' })]);
    const l = lead('Eve Park');
    await push(change('lead', l.id, l));
    const got = (await snap()).leads.find((x: any) => x.id === l.id);
    expect(got).toMatchObject({ stage: 'interested', tags: ['reached'] });
    // "Then tag" moved the lead itself, but that change does not start "Then tag" again.
    expect(await runsOf(second)).toHaveLength(1);
    expect(await runsOf(first)).toHaveLength(1);

    const used = (await snap()).runs.length;
    await h.ctx.db.query('UPDATE workspaces SET automation_daily_run_limit = $2 WHERE id = $1', [ws, used + 1]);
    const [m, n] = [lead('Fay One'), lead('Gil Two')];
    await push(change('lead', m.id, m)); await push(change('lead', n.id, n));
    expect((await snap()).runs.length).toBe(used + 1);
    const manual = randomUUID();
    const r = await push(change('run', manual, { id: manual, workflowId: first }));
    expect([r.status, r.body.message]).toEqual([429, `The daily limit of ${used + 1} runs has been reached.`]);
    await h.ctx.db.query('UPDATE workspaces SET automation_daily_run_limit = 500 WHERE id = $1', [ws]);
    await off(first); await off(second);
  });

  it('a test run reports what each step would do and changes nothing', async () => {
    const wf = await workflow('Dry', [makeStep('manual'), makeStep('lead.set_stage', { stage: 'converted' }), makeStep('wait'), makeStep('approval'), makeStep('notify', { text: 'done' })], false);
    const l = lead('Hal Vega');
    await push(change('lead', l.id, l));
    const before = await snap();
    const id = randomUUID();
    await push(change('run', id, { id, workflowId: wf, test: true, subject: { leadId: l.id } }));
    const s = await snap();
    const run = s.runs.find((r: any) => r.id === id);
    expect(run).toMatchObject({ status: 'Completed', test: true, subject: { leadId: l.id, label: 'Hal Vega' } });
    expect(run.log.map((x: any) => x.text)).toEqual(['Would: Move the lead to Converted', 'Would: Wait 24 hours', 'Would: Wait for approval: Review before continuing', 'Would notify: “done”']);
    expect(s.leads.find((x: any) => x.id === l.id).stage).toBe('new');
    expect(s.activity).toEqual(before.activity);
    // A real run of the same workflow does change the lead, then waits.
    const real = randomUUID();
    await push(change('run', real, { id: real, workflowId: wf, subject: { leadId: l.id } }));
    expect((await snap()).leads.find((x: any) => x.id === l.id).stage).toBe('converted');
    expect((await snap()).runs.find((r: any) => r.id === real).status).toBe('Waiting');
  });

  it('fires a schedule once on its day, in the workflow’s own time zone, for each matching lead', async () => {
    h.setNow('2026-11-30T02:30:00Z'); // Monday 08:30 in Dhaka
    const wf = await workflow('Monday review', [makeStep('schedule', { every: 'week', weekday: '1', time: '09:00', each: 'converted', zone: 'Asia/Dhaka' }), makeStep('lead.add_tag', { tag: 'reviewed' })]);
    expect((await tick(h.ctx)).scheduled).toBe(0); // 08:30 local: too early
    h.setNow('2026-11-30T03:05:00Z'); // 09:05 local
    const converted = (await snap()).leads.filter((l: any) => l.stage === 'converted').length;
    expect(converted).toBeGreaterThan(0);
    expect((await tick(h.ctx)).scheduled).toBe(converted);
    expect((await tick(h.ctx)).scheduled).toBe(0); // already fired today
    h.setNow('2026-12-01T03:05:00Z'); // Tuesday
    expect((await tick(h.ctx)).scheduled).toBe(0);
    expect((await snap()).leads.filter((l: any) => l.tags.includes('reviewed'))).toHaveLength(converted);
    await off(wf);
  });

  it('records a failed step and stops, without failing the write that triggered it', async () => {
    h.respond = () => json({ error: { message: 'down' } }, 503);
    const wf = await workflow('Draft on create', [makeStep('lead.created'), makeStep('message.draft'), makeStep('lead.add_tag', { tag: 'drafted' })]);
    const l = lead('Ian Wu');
    expect((await push(change('lead', l.id, l))).status).toBe(200);
    const run = (await runsOf(wf))[0];
    expect(run.status).toBe('Failed');
    expect(run.log.at(-1)).toMatchObject({ step: 2, ok: false });
    expect((await snap()).leads.find((x: any) => x.id === l.id).tags).toEqual([]);
    await off(wf);
  });
});
