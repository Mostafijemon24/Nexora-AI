// The channels a reply can be delivered through: email (the workspace's own SMTP account) and
// WhatsApp (the Cloud API with the workspace's own business number).

import type { Conversation } from '../../src/lib/types.ts';
import { getFields } from './connections.ts';
import type { Ctx } from './context.ts';

export type Delivery = { delivered: true; ref?: string } | { delivered: false; reason: string };
export interface Channel {
  label: string;
  /** Integration that must be connected for this channel. */
  integration: string;
  send(ctx: Ctx, workspaceId: string, conv: Conversation, text: string): Promise<Delivery>;
}

export interface EmailAccount { from: string; host: string; port: string; user: string; password: string; imapHost?: string; imapPort?: string }
export interface WhatsAppAccount { phoneNumberId: string; token: string; appSecret: string }

export const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** A phone number as WhatsApp expects it: digits only, with the country code. */
export const waNumber = (s: string): string => s.replace(/\D/g, '');

/** The WhatsApp Graph API version used for sending. */
export const graphUrl = (ctx: Ctx, path: string) => `https://graph.facebook.com/${ctx.config.env.WHATSAPP_API_VERSION || 'v21.0'}/${path}`;

const email: Channel = {
  label: 'email', integration: 'em',
  async send(ctx, workspaceId, conv, text) {
    const acct = await getFields<EmailAccount & Record<string, string>>(ctx, workspaceId, 'em');
    if (!acct) return { delivered: false, reason: 'Email is not connected, so the reply was kept here and not sent. Connect Email on the Integrations page.' };
    const to = conv.address?.trim() ?? '';
    if (!EMAIL_RE.test(to)) return { delivered: false, reason: 'This conversation has no email address, so the reply was kept here and not sent.' };
    const ext = (await ctx.db.query('SELECT external FROM conversations WHERE id = $1 AND workspace_id = $2', [conv.id, workspaceId])).rows[0]?.external ?? {};
    const profile = (await ctx.db.query('SELECT name FROM workspaces WHERE id = $1', [workspaceId])).rows[0];
    const subject = typeof ext.subject === 'string' && ext.subject ? (/^re:/i.test(ext.subject) ? ext.subject : `Re: ${ext.subject}`) : `A note from ${profile?.name ?? 'us'}`;
    const info = await ctx.smtp(acct).sendMail({
      from: profile?.name ? { name: profile.name, address: acct.from } : acct.from, to, subject, text,
      ...(typeof ext.replyRef === 'string' ? { inReplyTo: ext.replyRef, references: ext.replyRef } : {}),
    });
    return { delivered: true, ref: info.messageId };
  },
};

const whatsapp: Channel = {
  label: 'WhatsApp', integration: 'wa',
  async send(ctx, workspaceId, conv, text) {
    const acct = await getFields<WhatsAppAccount & Record<string, string>>(ctx, workspaceId, 'wa');
    if (!acct?.phoneNumberId || !acct.token) return { delivered: false, reason: 'WhatsApp is not connected, so the reply was kept here and not sent. Connect WhatsApp on the Integrations page.' };
    const to = waNumber(conv.address ?? '');
    if (to.length < 8) return { delivered: false, reason: 'This conversation has no phone number, so the reply was kept here and not sent.' };
    const res = await ctx.fetch(graphUrl(ctx, `${acct.phoneNumberId}/messages`), {
      method: 'POST', headers: { Authorization: `Bearer ${acct.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok) {
      // 131047: the 24-hour customer-service window has closed, so only an approved template may be sent.
      if (body.error?.code === 131047) throw new Error('more than 24 hours have passed since their last message, and WhatsApp only allows a free-form reply inside that window');
      throw new Error(body.error?.message ?? `WhatsApp answered ${res.status}`);
    }
    return { delivered: true, ref: body.messages?.[0]?.id };
  },
};

export const CHANNELS: Record<string, Channel> = { Email: email, WhatsApp: whatsapp };

/** Channels that can deliver for this workspace right now. */
export async function connectedChannels(ctx: Ctx, workspaceId: string): Promise<string[]> {
  const ids = new Set((await ctx.db.query('SELECT integration_id FROM integration_connections WHERE workspace_id = $1', [workspaceId])).rows.map((r) => r.integration_id as string));
  return Object.entries(CHANNELS).filter(([, c]) => ids.has(c.integration)).map(([name]) => name);
}
