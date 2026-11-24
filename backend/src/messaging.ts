// Sending replies and receiving messages. A reply is delivered through the conversation's channel
// when that channel is connected (email by SMTP, WhatsApp by the Cloud API); otherwise it is kept
// in the conversation and marked as not delivered. Nothing is ever sent through LinkedIn.

import { randomUUID } from 'node:crypto';
import type { Conversation, Message } from '../../src/lib/types.ts';
import type { WfEvent } from '../../src/lib/workflow.ts';
import { CHANNELS } from './channels.ts';
import type { Ctx } from './context.ts';
import { tx } from './db.ts';
import { notFound } from './errors.ts';
import * as store from './workspace/store.ts';

export interface SendResult { ok: boolean; note: string; status: NonNullable<Message['status']> }

/**
 * Adds a reply to a conversation and delivers it. `messageId` makes this safe to repeat: a
 * second call with the same id sends nothing and returns the first result.
 */
export async function sendReply(ctx: Ctx, workspaceId: string, conversationId: string, text: string, messageId: string, at?: string): Promise<SendResult> {
  const body = text.trim();
  const conv = await store.getConversation(ctx.db, workspaceId, conversationId);
  if (!conv) throw notFound('That conversation does not exist.');

  // Claim the message id before sending, so a retry (or a replayed offline queue) cannot deliver twice.
  const claim = await ctx.db.query(
    `INSERT INTO outbound_messages (id, workspace_id, conversation_id, channel, status, created_at) VALUES ($1, $2, $3, $4, 'saved', $5) ON CONFLICT (id) DO NOTHING`,
    [messageId, workspaceId, conv.id, conv.channel, ctx.now()]);
  if (!claim.rowCount) {
    const prev = (await ctx.db.query('SELECT status, error FROM outbound_messages WHERE id = $1 AND workspace_id = $2', [messageId, workspaceId])).rows[0];
    const status = (prev?.status ?? 'saved') as SendResult['status'];
    return { ok: status === 'sent', status, note: status === 'sent' ? `Reply sent to ${conv.name}` : prev?.error ?? 'The reply was kept in the conversation.' };
  }

  const channel = CHANNELS[conv.channel];
  let result: SendResult;
  let ref: string | undefined;
  if (!channel) {
    result = { ok: false, status: 'saved', note: `Replies in a “${conv.channel}” conversation are kept here only. Send it yourself, then come back.` };
  } else {
    try {
      const out = await channel.send(ctx, workspaceId, conv, body);
      if (out.delivered) { ref = out.ref; result = { ok: true, status: 'sent', note: `Reply sent to ${conv.name} by ${channel.label}` }; }
      else result = { ok: false, status: 'saved', note: out.reason };
    } catch (e) {
      result = { ok: false, status: 'failed', note: `Could not send by ${channel.label}: ${e instanceof Error ? e.message : 'unknown error'}` };
    }
  }

  const msg: Message = { id: messageId, me: true, text: body, at: at && !Number.isNaN(Date.parse(at)) ? at : ctx.now().toISOString(), status: result.status };
  if (!result.ok) msg.error = result.note;
  await tx(ctx.db, async (q) => {
    const row = (await q.query('SELECT msgs, external FROM conversations WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [conv.id, workspaceId])).rows[0];
    if (!row) return;
    const msgs = (row.msgs as Message[]).filter((m) => m.id !== messageId);
    const external = ref ? { ...row.external, lastSentRef: ref } : row.external;
    await q.query('UPDATE conversations SET msgs = $3, unread = false, external = $4 WHERE id = $1 AND workspace_id = $2',
      [conv.id, workspaceId, JSON.stringify([...msgs, msg].slice(-2000)), JSON.stringify(external)]);
    await q.query('UPDATE outbound_messages SET status = $2, error = $3, provider_ref = $4 WHERE id = $1', [messageId, result.status, result.ok ? null : result.note, ref ?? null]);
  });
  return result;
}

export interface Inbound {
  /** 'Email' or 'WhatsApp'. */
  channel: string;
  /** The sender's email address or phone number. */
  address: string;
  name?: string;
  text: string;
  at?: string;
  /** The provider's id for this message, so a redelivery is not added twice. */
  ref?: string;
  /** For email: the Message-ID to answer, and the subject. */
  replyRef?: string;
  subject?: string;
}

const digits = (s: string) => s.replace(/\D/g, '');

/**
 * Adds an incoming message to the sender's conversation, creating the conversation (linked to the
 * lead with that address, when there is one) if this is the first message. Returns the workflow
 * event for it, or null when the message had already been received.
 */
export async function receiveMessage(ctx: Ctx, workspaceId: string, m: Inbound): Promise<WfEvent | null> {
  const address = m.address.trim();
  const text = m.text.trim().slice(0, 10_000);
  if (!address || !text) return null;
  const at = m.at && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : ctx.now().toISOString();
  return tx(ctx.db, async (q) => {
    const phone = m.channel === 'WhatsApp';
    const found = (await q.query(
      phone
        ? "SELECT id FROM conversations WHERE workspace_id = $1 AND channel = $2 AND regexp_replace(coalesce(address, ''), '\\D', '', 'g') = $3 ORDER BY created_at DESC LIMIT 1 FOR UPDATE"
        : 'SELECT id FROM conversations WHERE workspace_id = $1 AND channel = $2 AND lower(address) = lower($3) ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [workspaceId, m.channel, phone ? digits(address) : address])).rows[0];

    let conv: Conversation;
    let external: Record<string, unknown> = {};
    if (found) {
      conv = (await store.getConversation(q, workspaceId, found.id))!;
      external = (await q.query('SELECT external FROM conversations WHERE id = $1', [found.id])).rows[0].external;
    } else {
      const lead = (await q.query(
        phone
          ? "SELECT id, name, company FROM leads WHERE workspace_id = $1 AND regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = $2 ORDER BY created_at LIMIT 1"
          : 'SELECT id, name, company FROM leads WHERE workspace_id = $1 AND lower(email) = lower($2) ORDER BY created_at LIMIT 1',
        [workspaceId, phone ? digits(address) : address])).rows[0];
      conv = {
        id: randomUUID(), name: lead?.name ?? m.name?.trim().slice(0, 200) ?? address, company: lead?.company ?? '', channel: m.channel, address,
        leadId: lead?.id ?? null, unread: true, important: false, intent: '', sentiment: '', suggestion: '', msgs: [], notes: [],
      };
    }
    const seen = Array.isArray(external.seen) ? (external.seen as string[]) : [];
    if (m.ref && seen.includes(m.ref)) return null;

    conv = { ...conv, unread: true, msgs: [...conv.msgs, { me: false, text, at, id: m.ref }].slice(-2000) };
    await store.saveConversation(q, workspaceId, conv, ctx.now());
    const next = { ...external, seen: m.ref ? [...seen, m.ref].slice(-200) : seen, ...(m.replyRef ? { replyRef: m.replyRef } : {}), ...(m.subject ? { subject: m.subject.slice(0, 300) } : {}) };
    await q.query('UPDATE conversations SET external = $3 WHERE id = $1 AND workspace_id = $2', [conv.id, workspaceId, JSON.stringify(next)]);
    return { kind: 'message.received', conversationId: conv.id, leadId: conv.leadId ?? undefined, label: conv.name } satisfies WfEvent;
  });
}
