import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newLead } from '../../src/lib/types.ts';
import { makeStep } from '../../src/lib/workflow.ts';
import { costUsd, priceFor } from '../src/ai/pricing.ts';
import { loadConfig } from '../src/config.ts';
import { dailyBackups } from '../src/workspace/backups.ts';
import { change, codeFrom, Device, harness, type Harness } from './helpers.ts';

let h: Harness;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const push = (d: Device, c: unknown) => d.post('/v1/workspace/changes', c);
const snap = async (d: Device) => (await d.get('/v1/workspace')).body;

beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h.close(); });
beforeEach(() => { h.mails.length = 0; h.advance(60_000); });

describe('moving a license with several seats', () => {
  it('lists the devices and gives up only the chosen one', async () => {
    const lic = await h.license({ maxDevices: 3 });
    const [a, b, c] = [new Device(h, 'native', 'ALPHA'), new Device(h, 'native', 'BRAVO'), new Device(h, 'native', 'CHARLIE')];
    for (const d of [a, b, c]) { await d.activate(lic.key); h.advance(60_000); }

    const d = new Device(h, 'native', 'DELTA');
    const full = (await d.activate(lic.key)).body;
    expect(full).toMatchObject({ ok: false, code: 'in_use' });
    expect(full.devices.map((x: any) => x.name)).toEqual(['ALPHA', 'BRAVO', 'CHARLIE']);
    expect(JSON.stringify(full)).not.toContain(a.info.id); // the list never carries a device's own registration id

    await d.requestTransfer(lic.key);
    const code = codeFrom(h.mails.at(-1)!);
    const bravo = full.devices.find((x: any) => x.name === 'BRAVO').id;
    const r = await d.post('/v1/license/transfer/confirm', { key: lic.key, code, device: d.info, replaceDeviceId: bravo });
    expect(r.body.ok).toBe(true);
    d.token = r.body.sessionToken;
    expect((await b.get('/v1/workspace')).status).toBe(401); // BRAVO lost its seat
    expect((await a.get('/v1/workspace')).status).toBe(200); // the others kept theirs
    expect((await c.get('/v1/workspace')).status).toBe(200);
    expect((await snap(d)).sessions.map((s: any) => s.device).sort()).toEqual(['ALPHA · Windows 11', 'CHARLIE · Windows 11', 'DELTA · this device']);

    // With no choice made, the device that has gone longest without checking in gives up its seat.
    await c.status(); h.advance(60_000); await d.status();
    const e = new Device(h, 'native', 'ECHO');
    await e.requestTransfer(lic.key);
    expect((await e.confirmTransfer(lic.key, codeFrom(h.mails.at(-1)!))).body.ok).toBe(true);
    expect((await a.get('/v1/workspace')).status).toBe(401);
    expect((await c.get('/v1/workspace')).status).toBe(200);
  });

  it('shows roughly where each session is', async () => {
    const lic = await h.license({ maxDevices: 2 });
    const d = new Device(h, 'native', 'DHAKA-PC');
    (d.info as any).timeZone = 'Asia/Dhaka';
    d.ip = '203.0.113.77';
    await d.activate(lic.key);
    const other = new Device(h, 'native', 'ELSEWHERE');
    (other.info as any).timeZone = '<script>'; // not a time zone: ignored
    other.ip = '2001:db8:85a3::8a2e:370:7334';
    await other.activate(lic.key);
    h.advance(3 * 3_600_000);
    const sessions = (await snap(d)).sessions;
    expect(sessions[0]).toMatchObject({ current: true, meta: 'active now · Dhaka · 203.0.113.•' });
    expect(sessions[1].meta).toBe('3 hours ago · 2001:db8:85a3:…');
  });
});

describe('backups', () => {
  let d: Device;
  let other: Device;
  let ws: string;

  beforeAll(async () => {
    const lic = await h.license({ workspace: 'Backed Up' });
    ws = lic.workspaceId;
    d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    other = new Device(h, 'native', 'OTHER');
    await other.activate((await h.license()).key);
  });

  it('downloads a backup and restores it, replacing what is there and undoing nothing else', async () => {
    const campaign = randomUUID();
    await push(d, change('campaign', campaign, { id: campaign, name: 'Q4', goal: '', channel: 'Email', status: 'Active', startDate: null, endDate: null }));
    const ada = newLead(randomUUID(), 'Ada Okafor', 'Lumen', h.ctx.now().toISOString(), { email: 'ada@lumen.example', tags: ['vip'], stage: 'interested', campaignId: campaign, notes: [{ text: 'Met at the fair', at: h.ctx.now().toISOString() }] });
    await push(d, change('lead', ada.id, ada));
    const conv = randomUUID();
    await push(d, change('conversation', conv, { id: conv, name: 'Ada Okafor', company: 'Lumen', channel: 'Email', address: 'ada@lumen.example', leadId: ada.id, unread: false, important: true, intent: '', sentiment: '', suggestion: '', msgs: [{ me: false, text: 'Hello', at: h.ctx.now().toISOString() }], notes: [] }));
    const task = randomUUID();
    await push(d, change('task', task, { id: task, text: 'Call Ada', due: '', dueDate: '2026-12-01', leadId: ada.id, done: false }));
    const wf = randomUUID();
    await push(d, change('workflow', wf, { id: wf, name: 'Tag', on: true, steps: [makeStep('lead.created'), makeStep('lead.add_tag', { tag: 'new' })] }));
    await push(d, change('icp', 'icp', { industry: 'Marketing', title: 'CEO', sizeMin: '', sizeMax: '', location: '' }));

    const made = await d.post('/v1/backups');
    expect(made.body.completedAt).toBe(h.ctx.now().toISOString());
    const list = (await d.get('/v1/backups')).body;
    expect(list).toEqual([{ id: expect.any(String), createdAt: made.body.completedAt, automatic: false, sizeBytes: expect.any(Number), leads: 1 }]);
    const file = (await d.get(`/v1/backups/${list[0].id}`)).body;
    expect(file).toMatchObject({ format: 'nexora-backup', version: 2, workspace: 'Backed Up' });
    expect(JSON.stringify(file)).not.toMatch(/secret|token|password/i);
    expect((await other.get(`/v1/backups/${list[0].id}`)).status).toBe(404); // another workspace cannot read it

    // Things change after the backup…
    h.advance(60_000);
    await push(d, change('lead', ada.id, undefined, 'delete'));
    const junk = newLead(randomUUID(), 'Junk Lead', 'Nowhere', h.ctx.now().toISOString());
    await push(d, change('lead', junk.id, junk));

    // …and the backup brings the earlier state back.
    const r = await d.post(`/v1/backups/${list[0].id}/restore`);
    expect(r.body).toEqual({ leads: 1, campaigns: 1, posts: 0, conversations: 1, workflows: 1, tasks: 1, prompts: 0 });
    const s = await snap(d);
    expect(s.leads.map((l: any) => l.name)).toEqual(['Ada Okafor']);
    const lead = s.leads[0];
    expect(lead).toMatchObject({ email: 'ada@lumen.example', tags: ['vip'], stage: 'interested', notes: [{ text: 'Met at the fair' }] });
    expect(lead.id).not.toBe(ada.id); // new ids…
    expect(lead.campaignId).toBe(s.campaigns[0].id); // …with the links between records kept
    expect(s.conversations[0]).toMatchObject({ leadId: lead.id, important: true, msgs: [{ text: 'Hello' }] });
    expect(s.tasks[0]).toMatchObject({ text: 'Call Ada', dueDate: '2026-12-01', leadId: lead.id });
    expect(s.workflows).toMatchObject([{ name: 'Tag', on: false }]); // off until a person switches it on
    expect(s.icp.industry).toBe('Marketing');
    expect(s.activity[0].text).toMatch(/restored from a backup/);
    // The state before the restore was saved, so the restore itself can be undone.
    const after = (await d.get('/v1/backups')).body;
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ automatic: true, leads: 1 });
    expect(JSON.stringify((await d.get(`/v1/backups/${after[0].id}`)).body)).toContain('Junk Lead');
  });

  it('restores a file from another workspace without touching that workspace, and refuses what is not a backup', async () => {
    const theirs = newLead(randomUUID(), 'Their Lead', 'Their Co', h.ctx.now().toISOString());
    await push(other, change('lead', theirs.id, theirs));
    await other.post('/v1/backups');
    const file = (await other.get(`/v1/backups/${(await other.get('/v1/backups')).body[0].id}`)).body;

    expect((await d.post('/v1/backups/restore', { backup: file })).status).toBe(200);
    const mine = (await snap(d)).leads;
    expect(mine.map((l: any) => l.name)).toEqual(['Their Lead']);
    expect(mine[0].id).not.toBe(theirs.id);
    // Editing or deleting my copy leaves theirs alone.
    await push(d, change('lead', mine[0].id, undefined, 'delete'));
    expect((await snap(other)).leads.map((l: any) => l.name)).toEqual(['Their Lead']);

    for (const bad of [{ leads: [{ id: 'x' }] }, 'a string', { leads: 'many' }]) {
      const r = await d.post('/v1/backups/restore', { backup: bad });
      expect([r.status, r.body.code], JSON.stringify(bad)).toEqual([400, 'invalid_backup']);
    }
    expect((await d.post('/v1/backups/00000000-0000-0000-0000-000000000000/restore')).status).toBe(404);
  });

  it('backs every workspace with content up once a day and keeps the newest fourteen automatic ones', async () => {
    const count = async (automatic: boolean) => (await h.ctx.db.query('SELECT count(*)::int AS n FROM backups WHERE workspace_id = $1 AND automatic = $2', [ws, automatic])).rows[0].n;
    const l = newLead(randomUUID(), 'Kept', 'Co', h.ctx.now().toISOString());
    await push(d, change('lead', l.id, l));
    const manual = await count(false);
    h.advance(25 * 3_600_000);
    expect(await dailyBackups(h.ctx)).toBeGreaterThan(0);
    expect(await dailyBackups(h.ctx)).toBe(0); // not twice in a day
    for (let i = 0; i < 16; i++) { h.advance(25 * 3_600_000); await dailyBackups(h.ctx); }
    expect(await count(true)).toBe(14);
    expect(await count(false)).toBe(manual); // backups a person asked for are never pruned
  });
});

describe('AI cost', () => {
  it('prices a request from its tokens when the provider reports no cost, and says so when it cannot', async () => {
    const lic = await h.license();
    const d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    h.respond = (url) => (url.includes('/models') ? json({ data: [] }) : json({ model: 'gpt-4o-mini-2024-07-18', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 500_000 } }));
    await d.post('/v1/ai/providers/verify', { name: 'OpenAI', key: 'sk-good' });
    await d.post('/v1/ai/chat', { history: [{ me: true, text: 'hi' }], task: 'Reply suggestions' });
    let usage = (await snap(d)).aiUsage;
    expect(usage.byProvider).toEqual([{ provider: 'OpenAI', requests: 1, tokens: 1_500_000, costUsd: 0.45, priced: true }]); // 1M × $0.15 + 0.5M × $0.60
    expect(usage.costThisMonthUsd).toBeCloseTo(0.45);

    h.advance(120_000);
    h.respond = (url) => (url.includes('/models') ? json({ data: [] }) : json({ model: 'some-future-model', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    await d.post('/v1/ai/chat', { history: [{ me: true, text: 'hi again' }], task: 'Reply suggestions' });
    usage = (await snap(d)).aiUsage;
    expect(usage.byProvider[0]).toMatchObject({ requests: 2, priced: false, costUsd: 0.45 });
  });

  it('matches dated model ids and lets the operator add or correct prices', () => {
    const base = { DATABASE_URL: 'x', LICENSE_SIGNING_KEY: Buffer.alloc(32).toString('base64'), DATA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), HASH_SECRET: 'x'.repeat(24) };
    const plain = loadConfig(base);
    expect(priceFor(plain, 'claude-opus-5-5')).toEqual([4, 20]);
    expect(priceFor(plain, 'gpt-4o-mini-2024-07-18')).toEqual([0.15, 0.6]);
    expect(priceFor(plain, 'gpt-4o')).toBeNull(); // a different model that merely shares a prefix
    expect(priceFor(plain, 'gemini-2.0-flash')).toBeNull();
    expect(costUsd(plain, 'claude-haiku-5-5', 2_000_000, 1_000_000)).toBeCloseTo(0.7);
    const set = loadConfig({ ...base, AI_PRICES: '{"gemini-2.0-flash": [0.1, 0.4], "gpt-4o-mini": [1, 2], "bad": "x"}' });
    expect(priceFor(set, 'gemini-2.0-flash')).toEqual([0.1, 0.4]);
    expect(priceFor(set, 'gpt-4o-mini')).toEqual([1, 2]);
    expect(priceFor(set, 'bad')).toBeNull();
    expect(priceFor(loadConfig({ ...base, AI_PRICES: 'not json' }), 'claude-opus-5-5')).toEqual([4, 20]);
  });
});
