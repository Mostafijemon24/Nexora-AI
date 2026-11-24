import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/seed.ts';
import { change, Device, harness, type Harness } from './helpers.ts';

let h: Harness;
let a: Device; // workspace A
let b: Device; // workspace B
let wsA: string;
let wsB: string;

beforeAll(async () => {
  h = await harness();
  const la = await h.license({ email: 'a@example.com', workspace: 'Northwind Growth' });
  const lb = await h.license({ email: 'b@example.com', workspace: 'Other Co' });
  wsA = la.workspaceId; wsB = lb.workspaceId;
  await seedDemo(h.ctx.db, wsA, h.ctx.now());
  await seedDemo(h.ctx.db, wsB, h.ctx.now());
  a = new Device(h, 'native', 'A-PC');
  b = new Device(h, 'web', 'B-Browser');
  await a.activate(la.key);
  await b.activate(lb.key);
});
afterAll(async () => { await h.close(); });

const push = (d: Device, c: unknown) => d.post('/v1/workspace/changes', c);
const snap = async (d: Device) => (await d.get('/v1/workspace')).body;

describe('snapshot', () => {
  it('returns the workspace without any secret', async () => {
    const s = await snap(a);
    expect(s.profile).toEqual({ name: 'Rafiq Hasan', email: 'a@example.com', workspace: 'Northwind Growth' });
    expect(s.plan).toEqual({ name: 'Professional', hosting: 'Hybrid hosting' });
    expect(s.leads).toHaveLength(6);
    expect(s.posts.map((p: any) => p.status).sort()).toEqual(['Draft', 'In review', 'Published', 'Scheduled']);
    expect(s.workflows[0]).toMatchObject({ name: 'Score and draft for new leads', on: true });
    expect(s.sessions).toEqual([{ id: expect.any(String), current: true, device: 'A-PC · this device', meta: 'active now' }]);
    expect(s.integrations).toHaveLength(11);
    expect(s.providers.every((p: any) => p.verified === false)).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/secret|token_hash|key_hash/i);
  });

  it('computes dashboard metrics from stored data', async () => {
    const m = (await a.get('/v1/workspace/metrics?range=7d')).body;
    expect(m.bars).toHaveLength(7);
    expect(m.bars.at(-1)).toEqual({ label: 'M', value: 2 }); // two inbound messages today (Monday)
    expect(m.bars.at(-2).value).toBe(1); // one yesterday
    expect(m.funnel).toEqual([5, 3, 2, 1]); // five leads created this week, by furthest stage
    expect((await a.get('/v1/workspace/metrics?range=90d')).body.funnel[0]).toBe(6);
    expect((await a.get('/v1/workspace/metrics?range=1y')).status).toBe(400);
  });
});

describe('changes', () => {
  it('applies a write once, however many times it is replayed', async () => {
    const id = randomUUID();
    const c = change('task', id, { id, text: 'Follow up with John', due: 'Tomorrow', done: false });
    expect((await push(a, c)).status).toBe(204);
    // Replaying the same change id with different content (a stale offline queue) changes nothing.
    expect((await push(a, { ...c, data: { ...c.data as object, text: 'TAMPERED' } })).status).toBe(204);
    expect((await push(a, c)).status).toBe(204);
    const tasks = (await snap(a)).tasks.filter((t: any) => t.id === id);
    expect(tasks).toEqual([{ id, text: 'Follow up with John', due: 'Tomorrow', dueDate: null, leadId: null, done: false }]);
  });

  it('survives concurrent delivery of the same change', async () => {
    const id = randomUUID();
    const c = change('prompt', id, { id, title: 'T', text: 'Body' });
    const results = await Promise.all(Array.from({ length: 8 }, () => push(a, c)));
    expect(results.every((r) => r.status === 204)).toBe(true);
    expect((await snap(a)).prompts.filter((p: any) => p.id === id)).toHaveLength(1);
  });

  it('updates and deletes records, and stores singletons', async () => {
    const id = randomUUID();
    await push(a, change('post', id, { id, title: 'Hook', body: 'Body', status: 'Draft', date: null }));
    await push(a, change('post', id, { id, title: 'Hook', body: 'Body', status: 'Scheduled', date: '2026-11-25' }));
    expect((await snap(a)).posts.find((p: any) => p.id === id)).toEqual({ id, title: 'Hook', body: 'Body', status: 'Scheduled', date: '2026-11-25' });
    await push(a, change('post', id, undefined, 'delete'));
    expect((await snap(a)).posts.find((p: any) => p.id === id)).toBeUndefined();

    await push(a, change('icp', 'icp', { industry: 'Software', title: 'CTO', sizeMin: '5', sizeMax: '50', location: 'Canada' }));
    await push(a, change('security', 'security', { mfa: false }));
    await push(a, change('profile', 'profile', { name: 'Rafiq H', email: 'rafiq@northwind.example', workspace: 'Northwind' }));
    const actId = randomUUID();
    await push(a, change('activity', actId, { id: actId, text: 'Profile saved', at: h.ctx.now().toISOString() }));
    const s = await snap(a);
    expect(s.icp.industry).toBe('Software');
    expect(s.mfa).toBe(false);
    expect(s.profile).toEqual({ name: 'Rafiq H', email: 'rafiq@northwind.example', workspace: 'Northwind' });
    expect(s.activity[0].text).toBe('Profile saved');
  });

  it('rejects invalid data with a clear message and stores nothing', async () => {
    const id = randomUUID();
    const cases: [unknown, string | RegExp][] = [
      [change('post', id, { id, title: 'x', body: '', status: 'Viral', date: null }), /Invalid/],
      [change('profile', 'profile', { name: 'A', email: 'not-an-email', workspace: 'W' }), 'Enter a valid email address.'],
      [change('profile', 'profile', { name: 'A', email: 'b@example.com', workspace: 'W' }), 'That email address is already in use.'],
      [change('workflow', id, { id, name: 'W', on: true, steps: [{ type: 'Action', label: 'no trigger' }] }), 'A workflow starts with a trigger.'],
      [change('workflow', id, { id, name: 'W', on: true, steps: [{ type: 'Trigger', label: 't' }, { type: 'Action', label: 'send', kind: 'message.send' }] }), 'A message can only be sent after an approval step.'],
      [change('workflow', id, { id, name: 'W', on: true, steps: [{ type: 'Trigger', label: 't' }, { type: 'AutoConnect', label: 'scrape' }] }), /Invalid/],
      [change('lead', id, { id }), /Invalid/],
      [change('nonsense', id, { id }), 'Unknown entity "nonsense".'],
      [change('sync', 'sync', { region: 'X', endpoint: 'http://insecure', offlineCache: true, conflict: 'ask' }), 'Enter a full https:// address.'],
      [{ nonsense: true }, 'Malformed change.'],
    ];
    for (const [c, msg] of cases) {
      const r = await push(a, c);
      expect(r.status, JSON.stringify(c)).toBeGreaterThanOrEqual(400);
      expect(r.body.message).toMatch(msg);
    }
    const s = await snap(a);
    expect(s.posts.find((p: any) => p.id === id)).toBeUndefined();
    expect(s.workflows.find((f: any) => f.id === id)).toBeUndefined();
  });
});

describe('lead import', () => {
  it('imports CSV rows into this workspace only, leaving missing fields unknown', async () => {
    const before = (await snap(b)).leads.length;
    const csv = 'Name,Company,Title,Size,Country\n"Okafor, Ada","Lumen Ltd",CTO,40,Nigeria\nNo Company,,CEO,5,UK\nBen Ito,Kite,,not-a-number,\n';
    const r = await a.post('/v1/leads/import', { csv });
    expect(r.body.imported).toBe(2);
    expect(r.body.skipped).toBe(1);
    const mine = r.body.leads.filter((l: any) => ['Okafor, Ada', 'Ben Ito'].includes(l.name)).sort((x: any, y: any) => y.name.localeCompare(x.name));
    expect(mine).toMatchObject([
      { id: expect.any(String), name: 'Okafor, Ada', title: 'CTO', company: 'Lumen Ltd', industry: null, size: 40, country: 'Nigeria', email: null, stage: 'new', tags: [] },
      { id: expect.any(String), name: 'Ben Ito', title: null, company: 'Kite', industry: null, size: null, country: null },
    ]);
    expect((await snap(b)).leads).toHaveLength(before);
    expect((await a.post('/v1/leads/import', { csv: 'email\nx@y.z' })).body.message).toMatch(/"name" and "company"/);
    expect((await a.post('/v1/leads/import', { csv: '' })).status).toBe(400);
  });
});

describe('workspace isolation', () => {
  it('never shows one workspace another workspace\'s data', async () => {
    const [sa, sb] = [await snap(a), await snap(b)];
    expect(sb.profile.workspace).toBe('Other Co');
    const idsA = new Set([...sa.posts, ...sa.leads, ...sa.conversations, ...sa.workflows, ...sa.tasks, ...sa.prompts].map((x: any) => x.id));
    for (const x of [...sb.posts, ...sb.leads, ...sb.conversations, ...sb.workflows, ...sb.tasks, ...sb.prompts]) expect(idsA.has(x.id)).toBe(false);
    expect(sb.sessions).toHaveLength(1);
  });

  it('refuses to overwrite, delete or reference another workspace\'s records, even with their ids', async () => {
    const sb = await snap(b);
    const victimPost = sb.posts[0];
    const victimWf = sb.workflows[0];
    const victimConv = sb.conversations[0];

    const over = await push(a, change('post', victimPost.id, { ...victimPost, title: 'HIJACKED' }));
    expect([over.status, over.body.code]).toEqual([409, 'forbidden_record']);
    const conv = await push(a, change('conversation', victimConv.id, { ...victimConv, notes: ['planted'] }));
    expect(conv.status).toBe(409);
    expect((await push(a, change('post', victimPost.id, undefined, 'delete'))).status).toBe(204); // deletes nothing
    const runId = randomUUID();
    const run = await push(a, change('run', runId, { id: runId, workflowId: victimWf.id, name: 'x', steps: 2, status: 'Completed', at: new Date().toISOString() }));
    expect(run.body.message).toBe('That workflow does not exist.');

    const after = await snap(b);
    expect(after.posts.find((p: any) => p.id === victimPost.id).title).toBe(victimPost.title);
    expect(after.conversations.find((c: any) => c.id === victimConv.id).notes).toEqual(victimConv.notes);
    expect(after.runs).toHaveLength(0);
  });

  it('cannot revoke another workspace\'s session, and backups stay inside the workspace', async () => {
    const sessionB = (await snap(b)).sessions[0].id;
    expect((await a.del(`/v1/sessions/${sessionB}`)).status).toBe(204);
    expect((await b.get('/v1/workspace')).status).toBe(200); // still signed in

    const done = await a.post('/v1/backups');
    expect(done.body.completedAt).toBe(h.ctx.now().toISOString());
    const rows = (await h.ctx.db.query('SELECT workspace_id FROM backups')).rows;
    expect(rows).toEqual([{ workspace_id: wsA }]);
    expect((await snap(a)).sync.lastBackupAt).toBe(done.body.completedAt);
    expect((await snap(b)).sync.lastBackupAt).toBe('');
  });

  it('keeps a session revoked by its own workspace out', async () => {
    const lic = await h.license({ maxDevices: 2 });
    const d1 = new Device(h, 'native', 'D1');
    const d2 = new Device(h, 'native', 'D2');
    await d1.activate(lic.key); await d2.activate(lic.key);
    const other = (await snap(d1)).sessions.find((s: any) => !s.current);
    expect(other.device).toBe('D2 · Windows 11');
    expect((await d1.del(`/v1/sessions/${other.id}`)).status).toBe(204);
    expect((await d2.get('/v1/workspace')).status).toBe(401);
    expect((await d1.del(`/v1/sessions/${(await snap(d1)).sessions[0].id}`)).status).toBe(400); // not its own
  });
});
