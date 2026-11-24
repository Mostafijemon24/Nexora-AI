import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newLead } from '../../src/lib/types.ts';
import { makeStep } from '../../src/lib/workflow.ts';
import { pollMailboxes } from '../src/inbound.ts';
import { stripQuoted } from '../src/mailbox.ts';
import { change, Device, harness, type Harness } from './helpers.ts';

// SMTP, IMAP and the WhatsApp Graph API are scripted here. The request shapes are asserted;
// they have not been run against the live services.

let h: Harness;
let d: Device;
let other: Device;
let ws: string;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const push = (c: unknown) => d.post('/v1/workspace/changes', c);
const snap = async (dev = d) => (await dev.get('/v1/workspace')).body;
const EMAIL = { from: 'me@northwind.example', host: 'smtp.northwind.example', port: '465', user: 'me@northwind.example', password: 'app-pass', imapHost: 'imap.northwind.example', imapPort: '993' };
const WA = { phoneNumberId: '1055', token: 'wa-token', appSecret: 'wa-app-secret' };
const conversation = async (rest: object) => {
  const id = randomUUID();
  await push(change('conversation', id, { id, name: 'Ada Okafor', company: 'Lumen', channel: 'Email', address: 'ada@lumen.example', unread: true, important: false, intent: '', sentiment: '', suggestion: '', msgs: [], notes: [], ...rest }));
  return id;
};
const reply = async (conversationId: string, text: string, id = randomUUID()) => ({ id, r: await push(change('message', id, { id, conversationId, text })) });
const convOf = async (id: string, dev = d) => (await snap(dev)).conversations.find((c: any) => c.id === id);
const hook = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  h.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeAll(async () => {
  h = await harness();
  const lic = await h.license();
  ws = lic.workspaceId;
  d = new Device(h, 'native', 'PC');
  await d.activate(lic.key);
  other = new Device(h, 'native', 'Other');
  await other.activate((await h.license()).key);
});
afterAll(async () => { await h.close(); });
beforeEach(() => { h.calls.length = 0; h.sent.length = 0; h.advance(60_000); });

describe('sending replies', () => {
  it('keeps a reply and says it was not sent while the channel is not connected', async () => {
    const id = await conversation({});
    const { r } = await reply(id, 'Hello Ada');
    expect([r.status, r.body]).toEqual([200, { effects: true }]);
    const c = await convOf(id);
    expect(c.unread).toBe(false);
    expect(c.msgs).toEqual([{ id: expect.any(String), me: true, text: 'Hello Ada', at: expect.any(String), status: 'saved', error: expect.stringContaining('Email is not connected') }]);
    expect(h.sent).toHaveLength(0);
    const manual = await conversation({ channel: 'Manual import', address: null });
    await reply(manual, 'Noted');
    expect((await convOf(manual)).msgs[0]).toMatchObject({ status: 'saved', error: expect.stringContaining('kept here only') });
  });

  it('checks mail settings before storing them, never returns the password, and sends once', async () => {
    expect((await d.post('/v1/integrations/em/connect', { fields: { ...EMAIL, port: 'ssl' } })).body.message).toMatch(/SMTP port/);
    expect((await d.post('/v1/integrations/em/connect', { fields: { ...EMAIL, password: '' } })).body.message).toBe('Enter: Password or app password.');
    const bad = await d.post('/v1/integrations/em/connect', { fields: { ...EMAIL, password: 'wrong' } });
    expect([bad.status, bad.body.code]).toEqual([400, 'integration_rejected']);
    expect((await snap()).integrations.find((g: any) => g.id === 'em').connected).toBe(false);

    expect((await d.post('/v1/integrations/em/connect', { fields: EMAIL })).status).toBe(200);
    const s = await snap();
    expect(s.integrations.find((g: any) => g.id === 'em')).toMatchObject({ connected: true, fields: expect.any(Array) });
    expect(JSON.stringify(s)).not.toContain('app-pass');
    const row = (await h.ctx.db.query("SELECT secret_enc FROM integration_connections WHERE workspace_id = $1 AND integration_id = 'em'", [ws])).rows[0];
    expect(row.secret_enc).not.toContain('app-pass');

    const id = await conversation({});
    const { id: mid, r } = await reply(id, '  Thanks for your note.  ');
    expect(r.body).toEqual({ effects: true });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].account).toMatchObject({ host: 'smtp.northwind.example', user: 'me@northwind.example', password: 'app-pass' });
    expect(h.sent[0].mail).toMatchObject({ to: 'ada@lumen.example', text: 'Thanks for your note.', from: { address: 'me@northwind.example' } });
    expect((await convOf(id)).msgs).toEqual([{ id: mid, me: true, text: 'Thanks for your note.', at: expect.any(String), status: 'sent' }]);

    // The same message id again (a retry, a replayed offline queue under a new change id) delivers nothing more.
    await push(change('message', mid, { id: mid, conversationId: id, text: 'Thanks for your note.' }));
    expect(h.sent).toHaveLength(1);
    expect((await convOf(id)).msgs).toHaveLength(1);

    const noAddress = await conversation({ address: null });
    await reply(noAddress, 'x');
    expect((await convOf(noAddress)).msgs[0]).toMatchObject({ status: 'saved', error: expect.stringContaining('no email address') });
    // A conversation in another workspace cannot be written to.
    const theirs = randomUUID();
    await other.post('/v1/workspace/changes', change('conversation', theirs, { id: theirs, name: 'X', company: '', channel: 'Email', address: 'x@x.example', unread: false, important: false, intent: '', sentiment: '', suggestion: '', msgs: [], notes: [] }));
    expect((await reply(theirs, 'hi')).r.body.message).toBe('That conversation does not exist.');
    expect(h.sent).toHaveLength(2 - 1);
  });

  it('sends on WhatsApp through the Cloud API and explains a closed 24-hour window', async () => {
    h.respond = () => json({ error: { message: 'Invalid OAuth access token' } }, 401);
    expect((await d.post('/v1/integrations/wa/connect', { fields: WA })).body.code).toBe('integration_rejected');
    h.respond = () => json({ display_phone_number: '+1 555 0100', id: '1055' });
    const done = await d.post('/v1/integrations/wa/connect', { fields: WA });
    expect(done.body.details.map((x: any) => x.label)).toEqual([expect.stringContaining('Callback URL'), 'Verify token', expect.stringContaining('Webhook field')]);
    expect(h.calls.at(-1)!.url).toBe('https://graph.facebook.com/v21.0/1055?fields=display_phone_number');

    const id = await conversation({ channel: 'WhatsApp', address: '+1 (416) 555-0134' });
    h.calls.length = 0;
    h.respond = () => json({ messages: [{ id: 'wamid.1' }] });
    await reply(id, 'On my way');
    expect(h.calls[0].url).toBe('https://graph.facebook.com/v21.0/1055/messages');
    expect(new Headers(h.calls[0].init?.headers).get('authorization')).toBe('Bearer wa-token');
    expect(JSON.parse(String(h.calls[0].init?.body))).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '14165550134', type: 'text', text: { preview_url: false, body: 'On my way' } });
    expect((await convOf(id)).msgs[0].status).toBe('sent');

    h.respond = () => json({ error: { message: 'Re-engagement message', code: 131047 } }, 400);
    await reply(id, 'Still there?');
    expect((await convOf(id)).msgs[1]).toMatchObject({ status: 'failed', error: expect.stringContaining('24 hours') });
  });

  it('a workflow sends the drafted message only after approval, and fails visibly when delivery fails', async () => {
    h.respond = (url) => (url.includes('/models') ? json({ data: [] }) : json({ model: 'm', choices: [{ message: { content: 'Hi Cy — quick question?' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    await d.post('/v1/ai/providers/verify', { name: 'OpenAI', key: 'sk-good' });
    const wf = randomUUID();
    await push(change('workflow', wf, { id: wf, name: 'Outreach', on: true, steps: [makeStep('lead.created'), makeStep('message.draft', { channel: 'Email' }), makeStep('approval'), makeStep('message.send'), makeStep('lead.set_stage', { stage: 'contacted' })] }));
    const lead = newLead(randomUUID(), 'Cy Young', 'Mound', h.ctx.now().toISOString(), { email: 'cy@mound.example' });
    await push(change('lead', lead.id, lead));
    expect(h.sent).toHaveLength(0); // nothing leaves before approval
    const run = (await snap()).runs.find((r: any) => r.workflowId === wf);
    expect(run.status).toBe('Awaiting approval');
    await push(change('run', run.id, { ...run, status: 'Completed' }));
    expect(h.sent.map((x) => [x.mail.to, x.mail.text])).toEqual([['cy@mound.example', 'Hi Cy — quick question?']]);
    const s = await snap();
    expect(s.runs.find((r: any) => r.id === run.id).status).toBe('Completed');
    expect(s.leads.find((l: any) => l.id === lead.id).stage).toBe('contacted');
    await push(change('workflow', wf, { ...s.workflows.find((f: any) => f.id === wf), on: false }));
  });
});

describe('receiving messages', () => {
  it('brings new mail into the inbox once, links it to the lead, threads the reply and starts workflows', async () => {
    const lead = newLead(randomUUID(), 'Dana Fox', 'Burrow', h.ctx.now().toISOString(), { email: 'Dana@Burrow.example' });
    await push(change('lead', lead.id, lead));
    const wf = randomUUID();
    await push(change('workflow', wf, { id: wf, name: 'On reply', on: true, steps: [makeStep('message.received'), makeStep('if.message_contains', { text: 'price, pricing' }), makeStep('lead.set_stage', { stage: 'interested' })] }));

    // Mail that was already in the mailbox when it was connected is not imported.
    h.inbox.set(EMAIL.user, [{ uid: 7, from: 'old@else.example', name: 'Old', subject: 'Old', text: 'before connecting', messageId: '<old@x>', date: h.ctx.now().toISOString() }]);
    await d.post('/v1/integrations/em/connect', { fields: EMAIL });
    expect(await pollMailboxes(h.ctx)).toBe(0);

    h.inbox.get(EMAIL.user)!.push(
      { uid: 8, from: 'dana@burrow.example', name: 'Dana Fox', subject: 'Pricing', text: 'What is your pricing?', messageId: '<m8@burrow>', date: h.ctx.now().toISOString() },
      { uid: 9, from: 'me@northwind.example', name: 'Me', subject: 'Note to self', text: 'ignore', messageId: '<m9@x>', date: h.ctx.now().toISOString() });
    expect(await pollMailboxes(h.ctx)).toBe(1);
    expect(await pollMailboxes(h.ctx)).toBe(0);
    let s = await snap();
    const c = s.conversations.find((x: any) => x.address === 'dana@burrow.example');
    expect(c).toMatchObject({ name: 'Dana Fox', company: 'Burrow', channel: 'Email', leadId: lead.id, unread: true });
    expect(c.msgs).toEqual([{ me: false, text: 'What is your pricing?', at: expect.any(String), id: '<m8@burrow>' }]);
    expect(s.conversations.some((x: any) => x.address === 'old@else.example' || x.address === 'me@northwind.example')).toBe(false);
    expect(s.leads.find((l: any) => l.id === lead.id).stage).toBe('interested');
    expect(s.integrations.find((g: any) => g.id === 'em').sync).toMatchObject({ ok: true });

    await reply(c.id, 'Happy to share.');
    expect(h.sent.at(-1)!.mail).toMatchObject({ to: 'dana@burrow.example', subject: 'Re: Pricing', inReplyTo: '<m8@burrow>', references: '<m8@burrow>' });

    // A client that still holds an older copy cannot erase the message the server added.
    await push(change('conversation', c.id, { ...c, msgs: [], unread: false, notes: ['seen'] }));
    const again = await convOf(c.id);
    expect(again.msgs.map((m: any) => m.text)).toEqual(['What is your pricing?', 'Happy to share.']);
    expect(again.notes).toEqual(['seen']);

    // A mailbox that cannot be read is reported on the connection, not thrown.
    await h.ctx.db.query("UPDATE integration_connections SET state = state || '{\"imapLastUid\": 9}' WHERE workspace_id = $1 AND integration_id = 'em'", [ws]);
    const real = h.ctx.mailbox;
    h.ctx.mailbox = () => ({ fetchAfter: async () => { throw new Error('Connection refused'); } });
    expect(await pollMailboxes(h.ctx)).toBe(0);
    expect((await snap()).integrations.find((g: any) => g.id === 'em').sync).toMatchObject({ ok: false, note: expect.stringContaining('Connection refused') });
    h.ctx.mailbox = real;
    s = await snap();
    await push(change('workflow', wf, { ...s.workflows.find((f: any) => f.id === wf), on: false }));
  });

  it('accepts WhatsApp webhooks only with Meta’s signature, for this number, once per message', async () => {
    h.respond = () => json({ id: '1055' });
    const details = (await d.post('/v1/integrations/wa/connect', { fields: WA })).body.details;
    const path = new URL(details[0].value).pathname;
    const token = details[1].value;

    const verify = await h.app.request(`${path}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=4242`);
    expect([verify.status, await verify.text()]).toEqual([200, '4242']);
    expect((await h.app.request(`${path}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242`)).status).toBe(403);
    expect((await h.app.request('/v1/hooks/wa/not-a-token?hub.mode=subscribe&hub.verify_token=not-a-token&hub.challenge=1')).status).toBe(403);

    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: '1055' }, contacts: [{ wa_id: '8801712345678', profile: { name: 'Rahim' } }],
      messages: [{ from: '8801712345678', id: 'wamid.A', timestamp: '1795424400', type: 'text', text: { body: 'Is this still available?' } }] } },
    { field: 'messages', value: { metadata: { phone_number_id: '9999' }, messages: [{ from: '111', id: 'wamid.B', timestamp: '1795424400', type: 'text', text: { body: 'for another number' } }] } }] }] });
    const sign = (secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    expect((await hook(path, body)).status).toBe(401);
    expect((await hook(path, body, { 'x-hub-signature-256': sign('guess') })).status).toBe(401);
    expect((await hook(path, body, { 'x-hub-signature-256': sign(WA.appSecret) })).status).toBe(200);
    expect((await hook(path, body, { 'x-hub-signature-256': sign(WA.appSecret) })).status).toBe(200); // Meta retries
    const convs = (await snap()).conversations.filter((c: any) => c.channel === 'WhatsApp' && c.address === '+8801712345678');
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ name: 'Rahim', unread: true });
    expect(convs[0].msgs).toEqual([{ me: false, text: 'Is this still available?', at: '2026-11-23T09:00:00.000Z', id: 'wamid.A' }]);
    expect(JSON.stringify(await snap())).not.toContain('for another number');

    // Disconnecting retires the address.
    await d.del('/v1/integrations/wa');
    expect((await hook(path, body, { 'x-hub-signature-256': sign(WA.appSecret) })).status).toBe(404);
  });

  it('accepts messages on the generic incoming address and nowhere else', async () => {
    const details = (await d.post('/v1/integrations/in/connect', {})).body.details;
    const path = new URL(details[0].value).pathname;
    expect((await hook(path, { text: 'no sender' })).status).toBe(400);
    expect((await hook(path, { channel: 'SMS', from: '+1', text: 'x' })).status).toBe(400);
    const ok = await hook(path, { from: 'pat@else.example', name: 'Pat', text: 'Hello from the form', subject: 'Contact form', id: 'form-1' });
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, added: 1 }]);
    expect(await (await hook(path, { from: 'pat@else.example', text: 'Hello from the form', id: 'form-1' })).json()).toEqual({ ok: true, added: 0 });
    expect((await snap()).conversations.find((c: any) => c.address === 'pat@else.example')).toMatchObject({ name: 'Pat', channel: 'Email', unread: true });
    expect((await snap(other)).conversations.some((c: any) => c.address === 'pat@else.example')).toBe(false);
    expect((await hook('/v1/hooks/in/guess', { from: 'a@b.example', text: 'x' })).status).toBe(404);
    // Reconnecting issues a new address and retires the old one.
    const next = new URL((await d.post('/v1/integrations/in/connect', {})).body.details[0].value).pathname;
    expect(next).not.toBe(path);
    expect((await hook(path, { from: 'a@b.example', text: 'x' })).status).toBe(404);
  });
});

describe('quoted text', () => {
  it('keeps what the person wrote and drops the quoted message below it', () => {
    expect(stripQuoted('Sounds good.\r\n\r\nOn Mon, 23 Nov 2026 at 09:00, Me <me@x.example> wrote:\r\n> Can we talk?\r\n> Thanks')).toBe('Sounds good.');
    expect(stripQuoted('Yes\n> quoted\nand more')).toBe('Yes\nand more');
    expect(stripQuoted('Plain message')).toBe('Plain message');
  });
});
