// Outgoing webhooks: events posted to the address a workspace connected under "Webhooks" or
// "n8n". When the connection has a signing secret, each request carries
//   X-Nexora-Timestamp: <unix seconds>
//   X-Nexora-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the secret>
// so the receiver can check where it came from and reject replays.

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Ctx } from './context.ts';
import { decrypt } from './crypto.ts';

export interface HookTarget { url: string; secret?: string }

/** A stored webhook credential: the address alone (older connections), or the address and a signing secret. */
export function parseHook(stored: string): HookTarget {
  if (stored.trim().startsWith('{')) {
    try { const o = JSON.parse(stored) as HookTarget; if (typeof o.url === 'string') return { url: o.url, secret: o.secret || undefined }; } catch { /* a plain address */ }
  }
  return { url: stored.trim() };
}

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string): boolean => {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(v) === 4) return PRIVATE_V4.some((r) => r.test(v));
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
};

/**
 * Why the server will not call an address a user supplied, or null when it may. Only public https
 * addresses are called, so a workspace cannot point the server at its own network.
 */
export async function unsafeUrlReason(ctx: Ctx, raw: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Enter the full https:// address.'; }
  if (u.protocol !== 'https:') return 'Enter the full https:// address.';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return 'That address is not reachable from the internet.';
  if (isIP(host.replace(/^\[|\]$/g, ''))) return isPrivate(host) ? 'That address is not reachable from the internet.' : null;
  if (ctx.resolve) {
    const ips = await ctx.resolve(host).catch(() => [] as string[]);
    if (!ips.length) return 'That address could not be found.';
    if (ips.some(isPrivate)) return 'That address is not reachable from the internet.';
  }
  return null;
}

export async function postHook(ctx: Ctx, target: HookTarget, body: Record<string, unknown>): Promise<Response> {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'NexoraAI-Webhooks/1' };
  if (target.secret) {
    const ts = String(Math.floor(ctx.now().getTime() / 1000));
    headers['X-Nexora-Timestamp'] = ts;
    headers['X-Nexora-Signature'] = `sha256=${createHmac('sha256', target.secret).update(`${ts}.${text}`).digest('hex')}`;
  }
  return ctx.fetch(target.url, { method: 'POST', headers, body: text, redirect: 'error', signal: AbortSignal.timeout(10_000) });
}

/** Posts an event to every webhook address the workspace has connected. */
export async function sendWebhook(ctx: Ctx, workspaceId: string, event: string, payload: Record<string, unknown>): Promise<{ ok: boolean; note: string }> {
  const rows = (await ctx.db.query("SELECT integration_id, secret_enc FROM integration_connections WHERE workspace_id = $1 AND integration_id IN ('wh', 'n8')", [workspaceId])).rows;
  if (!rows.length) return { ok: false, note: 'No webhook address is connected. Connect Webhooks or n8n on the Integrations page.' };
  const failures: string[] = [];
  for (const r of rows) {
    const name = r.integration_id === 'n8' ? 'n8n' : 'Webhooks';
    try {
      const target = parseHook(decrypt(ctx.config.dataEncryptionKey, r.secret_enc));
      const reason = await unsafeUrlReason(ctx, target.url);
      if (reason) { failures.push(`${name}: ${reason}`); continue; }
      const res = await postHook(ctx, target, { type: event, at: ctx.now().toISOString(), data: payload });
      if (!res.ok) failures.push(`${name} answered ${res.status}`);
    } catch {
      failures.push(`${name} did not respond`);
    }
  }
  return failures.length ? { ok: false, note: `Webhook “${event}” failed: ${failures.join('; ')}` } : { ok: true, note: `Sent the webhook event “${event}”` };
}

/** True when the workspace has a webhook address connected, so events are worth building. */
export async function hasWebhook(ctx: Ctx, workspaceId: string): Promise<boolean> {
  return Boolean((await ctx.db.query("SELECT 1 FROM integration_connections WHERE workspace_id = $1 AND integration_id IN ('wh', 'n8') LIMIT 1", [workspaceId])).rowCount);
}
