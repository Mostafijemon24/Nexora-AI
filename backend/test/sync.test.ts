import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newLead } from '../../src/lib/types.ts';
import { makeStep } from '../../src/lib/workflow.ts';
import { saveSecret } from '../src/connections.ts';
import { syncAll, syncOne } from '../src/sync/index.ts';
import { apiVersion, publishDue } from '../src/sync/linkedin.ts';
import { change, Device, harness, type Harness } from './helpers.ts';

// HubSpot, Salesforce, Google Calendar and LinkedIn are scripted here: the request shapes are
// asserted, but none of this has been run against the live services.

let h: Harness;
let d: Device;
let ws: string;
type Call = { url: string; method: string; body: any; headers: Headers };
const calls = (): Call[] => h.calls.map((c) => ({ url: c.url, method: c.init?.method ?? 'GET', body: c.init?.body ? JSON.parse(String(c.init.body)) : undefined, headers: new Headers(c.init?.headers) }));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const push = (c: unknown) => d.post('/v1/workspace/changes', c);
const snap = async () => (await d.get('/v1/workspace')).body;
const connect = (id: string, extra: object = {}) => saveSecret(h.ctx, ws, id, JSON.stringify({ access_token: `${id}-token`, ...extra }));
const addLead = async (name: string, rest: object = {}) => { const l = newLead(randomUUID(), name, 'Acme', h.ctx.now().toISOString(), rest); await push(change('lead', l.id, l)); return l; };
const leadBy = async (name: string) => (await snap()).leads.find((l: any) => l.name === name);

beforeAll(async () => {
  h = await harness();
  const lic = await h.license();
  ws = lic.workspaceId;
  d = new Device(h, 'native', 'PC');
  await d.activate(lic.key);
});
afterAll(async () => { await h.close(); });
beforeEach(() => { h.calls.length = 0; h.advance(10 * 60_000); });

describe('HubSpot contact sync', () => {
  const contact = (id: string, p: object, modified = h.ctx.now().toISOString()) => ({ id, properties: { lastmodifieddate: modified, ...p } });

  it('brings contacts in, links by email, sends leads out and does not echo', async () => {
    const existing = await addLead('Ada Okafor', { email: 'ADA@lumen.example', tags: ['vip'] });
    const noEmail = await addLead('No Email');
    await connect('hs');
    const wf = randomUUID();
    await push(change('workflow', wf, { id: wf, name: 'Tag synced', on: true, steps: [makeStep('lead.created'), makeStep('lead.add_tag', { tag: 'from-crm' })] }));

    h.advance(1000);
    let created = 0;
    h.respond = (url, init) => {
      if (url.endsWith('/contacts/search')) return json({ results: [
        contact('101', { firstname: 'Ada', lastname: 'Okafor', email: 'ada@lumen.example', jobtitle: 'CTO', company: 'Lumen', hs_lead_status: 'CONNECTED' }),
        contact('102', { firstname: 'Ben', lastname: 'Ito', email: 'ben@kite.example', company: '', numemployees: '40' }),
      ] });
      if (init?.method === 'POST') { created++; return json({ id: `9${created}` }, 201); }
      return json({ id: 'x' });
    };
    expect(await syncOne(h.ctx, ws, 'hs')).toEqual({ ok: true, note: expect.stringMatching(/^2 leads updated here, 0 leads sent · 1 lead not sent \(they have no email address\)$/) });

    const ada = await leadBy('Ada Okafor');
    expect(ada).toMatchObject({ id: existing.id, title: 'CTO', company: 'Lumen', stage: 'interested', tags: ['vip'], email: 'ADA@lumen.example' });
    const ben = await leadBy('Ben Ito');
    expect(ben).toMatchObject({ email: 'ben@kite.example', company: 'kite.example', size: 40, stage: 'new', tags: ['from-crm'] }); // the workflow ran for the new lead
    expect((await leadBy('No Email')).id).toBe(noEmail.id);
    const search = calls().find((c) => c.url.endsWith('/search'))!;
    expect(search.headers.get('authorization')).toBe('Bearer hs-token');
    expect(search.body.filterGroups[0].filters[0]).toMatchObject({ propertyName: 'lastmodifieddate', operator: 'GT', value: '0' });

    // Nothing changed on either side: the next pass asks only for newer contacts and sends nothing back.
    h.calls.length = 0;
    h.advance(1000);
    h.respond = (url) => (url.endsWith('/search') ? json({ results: [] }) : json({}, 500));
    expect((await syncOne(h.ctx, ws, 'hs')).note).toBe('Everything is up to date · 1 lead not sent (they have no email address)');
    expect(calls().map((c) => c.method)).toEqual(['POST']);
    expect(Number(calls()[0].body.filterGroups[0].filters[0].value)).toBeGreaterThan(0);

    // An edit here goes out as an update of the linked contact; a new lead with an email is created there.
    h.advance(1000);
    await push(change('lead', ada.id, { ...ada, stage: 'converted', phone: '+1 555 0100' }));
    const cy = await addLead('Cy Young', { email: 'cy@mound.example', title: 'Pitcher' });
    h.calls.length = 0;
    h.respond = (url, init) => (url.endsWith('/search') ? json({ results: [] }) : init?.method === 'POST' ? json({ id: '555' }, 201) : json({ id: '101' }));
    expect((await syncOne(h.ctx, ws, 'hs')).note).toMatch(/^0 leads updated here, 2 leads sent/);
    const patch = calls().find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/101');
    expect(patch.body.properties).toMatchObject({ firstname: 'Ada', lastname: 'Okafor', hs_lead_status: 'OPEN_DEAL', phone: '+1 555 0100', jobtitle: 'CTO' });
    const post = calls().find((c) => c.method === 'POST' && !c.url.endsWith('/search'))!;
    expect(post.body.properties).toMatchObject({ firstname: 'Cy', lastname: 'Young', email: 'cy@mound.example', company: 'Acme', hs_lead_status: 'NEW' });
    expect((await h.ctx.db.query("SELECT external->>'hs' AS hs FROM leads WHERE id = $1", [cy.id])).rows[0].hs).toBe('555');
    await push(change('workflow', wf, { ...(await snap()).workflows.find((f: any) => f.id === wf), on: false }));
  });

  it('applies the conflict rule when both sides changed, and never erases a value with an empty one', async () => {
    const ada = await leadBy('Ada Okafor');
    const edit = async (title: string) => { h.advance(1000); await push(change('lead', ada.id, { ...(await leadBy('Ada Okafor')), title })); };
    const remote = (title: string, modified: string) => { h.respond = (url) => (url.endsWith('/search') ? json({ results: [contact('101', { firstname: 'Ada', lastname: 'Okafor', email: 'ada@lumen.example', jobtitle: title, phone: '' }, modified)] }) : json({ id: '101' })); };
    const setRule = (conflict: string) => push(change('sync', 'sync', { region: 'Singapore', endpoint: '', offlineCache: true, conflict }));

    // "ask": Nexora AI's version is kept and the difference is reported.
    await setRule('ask');
    await edit('VP Engineering');
    h.advance(1000);
    remote('Chief Architect', h.ctx.now().toISOString());
    expect((await syncOne(h.ctx, ws, 'hs')).note).toMatch(/1 lead was changed on both sides; Nexora AI’s version was kept/);
    expect(await leadBy('Ada Okafor')).toMatchObject({ title: 'VP Engineering', phone: '+1 555 0100' });

    // "latest": the newer edit wins. Here the CRM's edit is the older one, so Nexora AI's stays…
    await setRule('latest');
    await edit('Head of Platform');
    const before = h.ctx.now().toISOString();
    remote('Older Title', new Date(h.ctx.now().getTime() - 60_000).toISOString());
    h.advance(1000);
    await syncOne(h.ctx, ws, 'hs');
    expect((await leadBy('Ada Okafor')).title).toBe('Head of Platform');
    // …and here it is the newer one, so it is taken.
    await edit('Stale Local Title');
    h.advance(5000);
    remote('Newest Title', h.ctx.now().toISOString());
    await syncOne(h.ctx, ws, 'hs');
    expect(await leadBy('Ada Okafor')).toMatchObject({ title: 'Newest Title', phone: '+1 555 0100' });
    expect(before < h.ctx.now().toISOString()).toBe(true);
    await setRule('ask');
  });

  it('links to an existing contact instead of duplicating it, pages through a long list, and reports failures on the card', async () => {
    const dup = await addLead('Dee Dupe', { email: 'dee@dupe.example' });
    h.respond = (url, init) => {
      if (url.endsWith('/search')) {
        const after = JSON.parse(String(init?.body)).after;
        return after ? json({ results: [contact('302', { firstname: 'Page', lastname: 'Two', email: 'two@p.example' })] })
          : json({ results: [contact('301', { firstname: 'Page', lastname: 'One', email: 'one@p.example' })], paging: { next: { after: 'A1' } } });
      }
      if (init?.method === 'POST') return json({ status: 'error', message: 'Contact already exists. Existing ID: 777', category: 'CONFLICT' }, 409);
      return json({ id: '777' });
    };
    await syncOne(h.ctx, ws, 'hs');
    expect((await h.ctx.db.query("SELECT external->>'hs' AS hs FROM leads WHERE id = $1", [dup.id])).rows[0].hs).toBe('777');
    expect(await leadBy('Page One')).toBeTruthy();
    expect(await leadBy('Page Two')).toBeTruthy();

    h.advance(6 * 60_000);
    h.respond = () => json({ message: 'expired' }, 401);
    expect(await syncAll(h.ctx)).toBe(1);
    expect((await snap()).integrations.find((g: any) => g.id === 'hs').sync).toMatchObject({ ok: false, note: 'HubSpot no longer accepts the stored authorization. Reconnect it.' });
    expect(await syncAll(h.ctx)).toBe(0); // not again within five minutes
    const now = await d.post('/v1/integrations/hs/sync');
    expect(now.body.ok).toBe(false);
    expect((await d.post('/v1/integrations/wh/sync')).body.message).toBe('This integration has nothing to sync.');
    await d.del('/v1/integrations/hs');
  });
});

describe('Salesforce lead sync', () => {
  it('queries the signed-in org, maps statuses, and creates and updates Lead records', async () => {
    await connect('sf', { instance_url: 'https://northwind.my.salesforce.com' });
    h.advance(1000);
    h.respond = (url, init) => {
      if (url.includes('/query?q=')) return json({ done: false, nextRecordsUrl: '/services/data/v60.0/query/01gNEXT-2000', records: [
        { Id: '00Q1', FirstName: 'Sam', LastName: 'Force', Company: 'Cloud Co', Title: 'VP Sales', Email: 'sam@cloud.example', Status: 'Working - Contacted', IsConverted: false, NumberOfEmployees: 300, LastModifiedDate: h.ctx.now().toISOString() }] });
      if (url.includes('/query/01gNEXT-2000')) return json({ done: true, records: [
        { Id: '00Q2', FirstName: null, LastName: 'Converted', Company: 'Done Co', Status: 'Qualified', IsConverted: true, LastModifiedDate: h.ctx.now().toISOString() }] });
      if (init?.method === 'POST') return json({ id: `00QNEW${Math.random().toString(36).slice(2, 6)}`, success: true }, 201);
      return json(null, 204);
    };
    const r = await syncOne(h.ctx, ws, 'sf');
    expect(r.ok, r.note).toBe(true);
    expect(await leadBy('Sam Force')).toMatchObject({ company: 'Cloud Co', title: 'VP Sales', stage: 'contacted', size: 300 });
    expect((await leadBy('Converted')).stage).toBe('converted');
    const q = calls().find((c) => c.url.includes('/query?q='))!;
    expect(q.url.startsWith('https://northwind.my.salesforce.com/services/data/v60.0/query?q=')).toBe(true);
    expect(decodeURIComponent(q.url.split('q=')[1])).toMatch(/^SELECT Id, FirstName, .* FROM Lead WHERE LastModifiedDate > 1970-01-01T00:00:00Z ORDER BY LastModifiedDate ASC LIMIT 200$/);
    // Every other lead in the workspace was created there; LastName and Company are always sent.
    const posts = calls().filter((c) => c.method === 'POST');
    expect(posts.length).toBeGreaterThan(3);
    expect(posts.every((c) => c.url === 'https://northwind.my.salesforce.com/services/data/v60.0/sobjects/Lead' && c.body.LastName && c.body.Company)).toBe(true);
    expect(posts.find((c) => c.body.LastName === 'Okafor')!.body).not.toHaveProperty('Status'); // "converted" is not pushed

    h.advance(1000);
    const sam = await leadBy('Sam Force');
    await push(change('lead', sam.id, { ...sam, stage: 'lost' }));
    h.calls.length = 0;
    h.respond = (url) => (url.includes('/query') ? json({ done: true, records: [] }) : json(null, 204));
    await syncOne(h.ctx, ws, 'sf');
    const patch = calls().find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://northwind.my.salesforce.com/services/data/v60.0/sobjects/Lead/00Q1');
    expect(patch.body).toMatchObject({ LastName: 'Force', Status: 'Closed - Not Converted' });

    // An org address that is not Salesforce's is refused rather than called.
    await connect('sf', { instance_url: 'https://evil.example' });
    h.calls.length = 0;
    expect(await syncOne(h.ctx, ws, 'sf')).toEqual({ ok: false, note: 'Salesforce did not say which org to use. Reconnect it.' });
    expect(h.calls).toHaveLength(0);
    await d.del('/v1/integrations/sf');
  });
});

describe('Google Calendar', () => {
  it('puts dated tasks on the calendar, follows a moved event, and removes the event of a finished task', async () => {
    await connect('gc');
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    await push(change('task', a, { id: a, text: 'Call Ada', due: '', dueDate: '2026-12-01', done: false }));
    await push(change('task', b, { id: b, text: 'No date', due: 'Soon', done: false }));
    await push(change('task', c, { id: c, text: 'Already done', due: '', dueDate: '2026-12-02', done: true }));
    h.advance(1000);
    h.respond = (_url, init) => (init?.method === 'POST' ? json({ id: 'ev-1' }) : json({ items: [] }));
    expect((await syncOne(h.ctx, ws, 'gc')).note).toBe('0 tasks updated here, 1 event sent');
    const post = calls().find((x) => x.method === 'POST')!;
    expect(post.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(post.body).toEqual({ summary: 'Call Ada', start: { date: '2026-12-01' }, end: { date: '2026-12-02' }, extendedProperties: { private: { nexoraTask: a } } });

    // The event was dragged to another day in Google Calendar; an event that is not ours is ignored.
    h.advance(60_000);
    h.calls.length = 0;
    h.respond = (url) => (url.includes('updatedMin') ? json({ items: [
      { id: 'ev-1', status: 'confirmed', start: { date: '2026-12-05' }, extendedProperties: { private: { nexoraTask: a } } },
      { id: 'other', status: 'confirmed', start: { date: '2026-12-09' } }] }) : json({}));
    expect((await syncOne(h.ctx, ws, 'gc')).note).toBe('1 task updated here, 0 events sent');
    expect((await snap()).tasks.find((t: any) => t.id === a).dueDate).toBe('2026-12-05');
    expect(calls().filter((x) => x.method !== 'GET')).toEqual([]); // the change is not sent straight back

    // Finishing the task removes its event.
    h.advance(60_000);
    await push(change('task', a, { id: a, text: 'Call Ada', due: '', dueDate: '2026-12-05', done: true }));
    h.calls.length = 0;
    h.respond = (_url, init) => (init?.method === 'DELETE' ? json(null, 204) : json({ items: [] }));
    await syncOne(h.ctx, ws, 'gc');
    expect(calls().find((x) => x.method === 'DELETE')!.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/ev-1');

    // Deleting an event in the calendar unlinks the task; it is not recreated.
    const e = randomUUID();
    await push(change('task', e, { id: e, text: 'Keep me', due: '', dueDate: '2026-12-10', done: false }));
    h.advance(1000);
    h.respond = (_url, init) => (init?.method === 'POST' ? json({ id: 'ev-2' }) : json({ items: [] }));
    await syncOne(h.ctx, ws, 'gc');
    h.advance(60_000);
    h.respond = (url) => (url.includes('updatedMin') ? json({ items: [{ id: 'ev-2', status: 'cancelled', extendedProperties: { private: { nexoraTask: e } } }] }) : json({}));
    await syncOne(h.ctx, ws, 'gc');
    h.advance(60_000);
    h.calls.length = 0;
    h.respond = () => json({ items: [] });
    await syncOne(h.ctx, ws, 'gc');
    expect(calls().filter((x) => x.method !== 'GET')).toEqual([]);
    expect((await snap()).tasks.find((t: any) => t.id === e)).toMatchObject({ dueDate: '2026-12-10', done: false });
    await d.del('/v1/integrations/gc');
  });
});

describe('publishing to LinkedIn', () => {
  const post = async (status: string, date: string | null = null) => {
    const id = randomUUID();
    await push(change('post', id, { id, title: 'A hook', body: 'The body.', status, date }));
    return id;
  };
  const linkedin = (url: string) => {
    if (url.endsWith('/v2/userinfo')) return json({ sub: 'abc123' });
    if (url.endsWith('/rest/posts')) return json(null, 201, { 'x-restli-id': 'urn:li:share:7001' });
    return json({}, 500);
  };

  it('publishes only an approved post, once, as the signed-in member', async () => {
    const draft = await post('Draft');
    const approved = await post('Approved');
    expect((await d.post(`/v1/posts/${approved}/publish`)).body.message).toMatch(/LinkedIn is not connected/);
    expect((await snap()).posts.find((p: any) => p.id === approved)).toMatchObject({ status: 'Approved', publishError: expect.stringContaining('not connected') });

    await connect('li');
    h.respond = linkedin;
    expect((await d.post(`/v1/posts/${draft}/publish`)).body.message).toBe('Approve the post before publishing it.');
    const [r1, r2] = await Promise.all([d.post(`/v1/posts/${approved}/publish`), d.post(`/v1/posts/${approved}/publish`)]);
    // The second request either waited its turn (and got the same link) or was told the post is being published.
    expect([r1.status, r2.status].sort()[0]).toBe(200);
    expect([200, 409]).toContain([r1.status, r2.status].sort()[1]);
    const sent = calls().filter((c) => c.url.endsWith('/rest/posts'));
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get('linkedin-version')).toBe(apiVersion(h.ctx));
    expect(sent[0].headers.get('x-restli-protocol-version')).toBe('2.0.0');
    expect(sent[0].body).toMatchObject({ author: 'urn:li:person:abc123', commentary: 'A hook\n\nThe body.', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
    const p = (await snap()).posts.find((x: any) => x.id === approved);
    expect(p).toMatchObject({ status: 'Published', publishedUrl: 'https://www.linkedin.com/feed/update/urn%3Ali%3Ashare%3A7001/' });
    expect(p.publishError).toBeUndefined();
    // Asking again returns the same link and posts nothing.
    h.calls.length = 0;
    expect((await d.post(`/v1/posts/${approved}/publish`)).body).toEqual({ url: p.publishedUrl });
    expect(h.calls).toHaveLength(0);
    expect(apiVersion(h.ctx)).toMatch(/^20\d{4}$/);
  });

  it('explains a missing posting permission and lets the post be tried again after an edit', async () => {
    const id = await post('Approved');
    h.respond = (url) => (url.endsWith('/rest/posts') ? json({ message: 'Not enough permissions' }, 403) : json({ sub: 'abc123' }));
    const r = await d.post(`/v1/posts/${id}/publish`);
    expect([r.status, r.body.code]).toEqual([400, 'publish_failed']);
    expect(r.body.message).toMatch(/w_member_social/);
    expect((await snap()).posts.find((p: any) => p.id === id)).toMatchObject({ status: 'Approved', publishError: expect.stringContaining('w_member_social') });
    h.respond = linkedin;
    expect((await d.post(`/v1/posts/${id}/publish`)).status).toBe(200);
  });

  it('publishes scheduled posts by itself only when the workspace switched that on, and only when due', async () => {
    const today = h.ctx.now().toISOString().slice(0, 10);
    const due = await post('Scheduled', today);
    const later = await post('Scheduled', '2099-01-01');
    const unapproved = await post('In review', today);
    h.respond = linkedin;
    expect(await publishDue(h.ctx)).toBe(0); // off by default
    await push(change('publishing', 'publishing', { auto: true }));
    expect((await snap()).autoPublish).toBe(true);
    expect(await publishDue(h.ctx)).toBe(1);
    expect(await publishDue(h.ctx)).toBe(0);
    const posts = (await snap()).posts;
    expect([due, later, unapproved].map((id) => posts.find((p: any) => p.id === id).status)).toEqual(['Published', 'Scheduled', 'In review']);
    expect((await snap()).activity[0].text).toBe('Post “A hook” published to LinkedIn');
  });
});
