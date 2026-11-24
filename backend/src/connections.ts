// Stored credentials and per-connection state of a workspace's integrations. Secrets are
// encrypted with DATA_ENCRYPTION_KEY and never leave the server.

import type { Ctx } from './context.ts';
import { decrypt, encrypt, hmac, newToken } from './crypto.ts';

export async function saveSecret(ctx: Ctx, workspaceId: string, id: string, secret: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO integration_connections (workspace_id, integration_id, secret_enc, connected_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, integration_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, connected_at = EXCLUDED.connected_at`,
    [workspaceId, id, encrypt(ctx.config.dataEncryptionKey, secret), ctx.now()]);
}

/** The stored credential, or null when the integration is not connected. */
export async function getSecret(ctx: Ctx, workspaceId: string, id: string): Promise<string | null> {
  const r = await ctx.db.query('SELECT secret_enc FROM integration_connections WHERE workspace_id = $1 AND integration_id = $2', [workspaceId, id]);
  return r.rows[0] ? decrypt(ctx.config.dataEncryptionKey, r.rows[0].secret_enc) : null;
}

/** A credential made of several named fields (stored as JSON), or null. */
export async function getFields<T extends Record<string, string>>(ctx: Ctx, workspaceId: string, id: string): Promise<T | null> {
  const s = await getSecret(ctx, workspaceId, id);
  if (!s) return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? (o as T) : null; } catch { return null; }
}

export async function getState<T extends Record<string, unknown>>(ctx: Ctx, workspaceId: string, id: string): Promise<T> {
  const r = await ctx.db.query('SELECT state FROM integration_connections WHERE workspace_id = $1 AND integration_id = $2', [workspaceId, id]);
  return (r.rows[0]?.state ?? {}) as T;
}

export async function patchState(ctx: Ctx, workspaceId: string, id: string, patch: Record<string, unknown>): Promise<void> {
  await ctx.db.query('UPDATE integration_connections SET state = state || $3::jsonb WHERE workspace_id = $1 AND integration_id = $2', [workspaceId, id, JSON.stringify(patch)]);
}

export async function removeConnection(ctx: Ctx, workspaceId: string, id: string): Promise<void> {
  await ctx.db.query('DELETE FROM integration_connections WHERE workspace_id = $1 AND integration_id = $2', [workspaceId, id]);
  await ctx.db.query('DELETE FROM inbound_hooks WHERE workspace_id = $1 AND integration_id = $2', [workspaceId, id]);
}

const hookHash = (ctx: Ctx, token: string) => hmac(ctx.config.hashSecret, `hook:${token}`);

/** Issues the token that goes in a connection's inbound webhook address, replacing any earlier one. Only its hash is stored. */
export async function issueHook(ctx: Ctx, workspaceId: string, id: string): Promise<string> {
  const token = newToken();
  await ctx.db.query(
    `INSERT INTO inbound_hooks (token_hash, workspace_id, integration_id, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, integration_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = EXCLUDED.created_at`,
    [hookHash(ctx, token), workspaceId, id, ctx.now()]);
  return token;
}

/** The workspace an inbound webhook token belongs to, when it is this integration's current token. */
export async function hookWorkspace(ctx: Ctx, id: string, token: string): Promise<string | null> {
  if (!token || token.length > 200) return null;
  const r = await ctx.db.query('SELECT workspace_id FROM inbound_hooks WHERE token_hash = $1 AND integration_id = $2', [hookHash(ctx, token), id]);
  return r.rows[0]?.workspace_id ?? null;
}
