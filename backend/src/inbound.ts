// Messages arriving from outside: WhatsApp's webhook, the generic "incoming messages" address,
// and mail read from a workspace's own mailbox. Each ends up in the inbox through receiveMessage,
// and can start the workflows that a received message triggers.

import { createHmac } from 'node:crypto';
import type { WfEvent } from '../../src/lib/workflow.ts';
import { EMAIL_RE, type EmailAccount, type WhatsAppAccount } from './channels.ts';
import { getFields, getState, hookWorkspace, patchState } from './connections.ts';
import type { Ctx } from './context.ts';
import { safeEqual } from './crypto.ts';
import { badRequest, HttpError, notFound, tooMany } from './errors.ts';
import { receiveMessage, type Inbound } from './messaging.ts';
import { emit } from './workspace/automation.ts';

async function workspaceFor(ctx: Ctx, integration: string, token: string): Promise<string> {
  const w = await hookWorkspace(ctx, integration, token);
  if (!w) throw notFound();
  if (!(await ctx.limiter.allow(`hook:${w}:${integration}`, 600, 60))) throw tooMany('Too many messages. Try again in a minute.');
  return w;
}

async function deliver(ctx: Ctx, workspaceId: string, messages: Inbound[]): Promise<number> {
  const events: WfEvent[] = [];
  for (const m of messages) {
    const ev = await receiveMessage(ctx, workspaceId, m);
    if (ev) events.push(ev);
  }
  await emit(ctx, { workspaceId, licenseId: null }, events);
  return events.length;
}

/** Meta's subscription check: echo the challenge when the verify token is this connection's token. */
export async function whatsappVerify(ctx: Ctx, token: string, query: { mode?: string; verifyToken?: string; challenge?: string }): Promise<string> {
  if (!(await hookWorkspace(ctx, 'wa', token)) || query.mode !== 'subscribe' || query.verifyToken !== token || !query.challenge) throw new HttpError(403, 'forbidden', 'Verification failed.');
  return query.challenge;
}

/** A WhatsApp webhook delivery. The body must carry Meta's signature made with the connection's app secret. */
export async function whatsappReceive(ctx: Ctx, token: string, rawBody: string, signature: string | undefined): Promise<number> {
  const w = await workspaceFor(ctx, 'wa', token);
  const acct = await getFields<WhatsAppAccount & Record<string, string>>(ctx, w, 'wa');
  if (!acct?.appSecret) throw notFound();
  const expected = `sha256=${createHmac('sha256', acct.appSecret).update(rawBody).digest('hex')}`;
  if (!signature || !safeEqual(signature, expected)) throw new HttpError(401, 'bad_signature', 'The signature does not match.');
  let body: any;
  try { body = JSON.parse(rawBody); } catch { throw badRequest('Send JSON.'); }
  const out: Inbound[] = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = change?.value;
      // Only messages for this connection's own number.
      if (!v || v.metadata?.phone_number_id !== acct.phoneNumberId) continue;
      const names = new Map<string, string>((Array.isArray(v.contacts) ? v.contacts : []).map((c: any) => [String(c.wa_id), String(c.profile?.name ?? '')]));
      for (const m of Array.isArray(v.messages) ? v.messages : []) {
        const text = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : `[${m.type ?? 'message'} — open WhatsApp to see it]`;
        if (typeof m.from !== 'string' || typeof text !== 'string') continue;
        const ts = Number(m.timestamp);
        out.push({ channel: 'WhatsApp', address: `+${m.from.replace(/\D/g, '')}`, name: names.get(m.from) || undefined, text, ref: typeof m.id === 'string' ? m.id : undefined, at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : undefined });
      }
    }
  }
  return deliver(ctx, w, out);
}

/** The generic incoming-message address: one message as JSON. The token in the address is the credential. */
export async function hookReceive(ctx: Ctx, token: string, body: Record<string, unknown>): Promise<number> {
  const w = await workspaceFor(ctx, 'in', token);
  const str = (k: string, max: number) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, max) : '');
  const from = str('from', 320);
  const text = str('text', 10_000);
  const channel = str('channel', 20) || (EMAIL_RE.test(from) ? 'Email' : 'WhatsApp');
  if (channel !== 'Email' && channel !== 'WhatsApp') throw badRequest('channel must be "Email" or "WhatsApp".');
  if (!from || !text) throw badRequest('"from" and "text" are required.');
  if (channel === 'Email' && !EMAIL_RE.test(from)) throw badRequest('"from" must be an email address for the Email channel.');
  return deliver(ctx, w, [{ channel, address: from, name: str('name', 200) || undefined, text, ref: str('id', 200) || undefined, subject: str('subject', 300) || undefined }]);
}

interface MailState extends Record<string, unknown> { imapValidity?: string | null; imapLastUid?: number | null }

/** Background job: brings new mail from every connected mailbox into its workspace's inbox. */
export async function pollMailboxes(ctx: Ctx): Promise<number> {
  const rows = (await ctx.db.query("SELECT workspace_id FROM integration_connections WHERE integration_id = 'em'")).rows;
  let total = 0;
  for (const { workspace_id: w } of rows) {
    try {
      const acct = await getFields<EmailAccount & Record<string, string>>(ctx, w, 'em');
      if (!acct?.imapHost) continue;
      const box = ctx.mailbox({ host: acct.imapHost, port: acct.imapPort || '993', user: acct.user, password: acct.password });
      const state = await getState<MailState>(ctx, w, 'em');
      const known = typeof state.imapLastUid === 'number';
      const r = await box.fetchAfter(known ? (state.imapLastUid as number) : null);
      if (!known || r.validity !== state.imapValidity) {
        // First pass, or the mailbox was rebuilt: start from where it ends now rather than re-reading old mail.
        const start = known ? await box.fetchAfter(null) : r;
        await patchState(ctx, w, 'em', { imapValidity: start.validity, imapLastUid: start.lastUid });
        continue;
      }
      const mine = acct.from.toLowerCase();
      const messages = r.messages.filter((m) => m.text && EMAIL_RE.test(m.from) && m.from.toLowerCase() !== mine)
        .map((m): Inbound => ({ channel: 'Email', address: m.from, name: m.name || undefined, text: m.text, at: m.date, ref: m.messageId || `uid:${m.uid}`, replyRef: m.messageId || undefined, subject: m.subject || undefined }));
      total += await deliver(ctx, w, messages);
      await patchState(ctx, w, 'em', { imapLastUid: r.lastUid, sync: { at: ctx.now().toISOString(), ok: true, note: messages.length ? `${messages.length} new message${messages.length === 1 ? '' : 's'}` : 'No new mail' } });
    } catch (e) {
      await patchState(ctx, w, 'em', { sync: { at: ctx.now().toISOString(), ok: false, note: `Could not read the mailbox: ${e instanceof Error ? e.message : 'unknown error'}`.slice(0, 300) } }).catch(() => {});
    }
  }
  return total;
}
