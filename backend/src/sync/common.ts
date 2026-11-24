// Shared by the connectors that exchange data with a signed-in (OAuth) service.

import { getSecret } from '../connections.ts';
import type { Ctx } from '../context.ts';
import { accessToken, CATALOG } from '../integrations.ts';

export class SyncError extends Error {}

/** What one sync pass did, shown on the integration's card. */
export interface SyncResult { pulled: number; pushed: number; notes: string[] }
export const emptyResult = (): SyncResult => ({ pulled: 0, pushed: 0, notes: [] });

export interface Api {
  /** Extra fields the provider returned with its tokens, e.g. Salesforce's instance_url. */
  tokens: Record<string, unknown>;
  /** Calls the service with the stored authorization, refreshing it once if it was rejected. */
  call(url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; ok: boolean; json: any; headers: Headers }>;
}

/** An authorized client for a connected OAuth integration, or null when it is not connected. */
export async function apiFor(ctx: Ctx, workspaceId: string, id: string): Promise<Api | null> {
  const e = CATALOG.find((x) => x.id === id);
  let secret = await getSecret(ctx, workspaceId, id);
  if (!e?.oauth || !secret) return null;
  const once = async (url: string, init: Parameters<Api['call']>[1], force: boolean) => {
    const token = await accessToken(ctx, workspaceId, e, secret!, force);
    if (force) secret = (await getSecret(ctx, workspaceId, id)) ?? secret;
    return ctx.fetch(url, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  };
  return {
    tokens: JSON.parse(secret) as Record<string, unknown>,
    async call(url, init) {
      let res: Response;
      try {
        res = await once(url, init, false);
        if (res.status === 401) res = await once(url, init, true);
      } catch (err) {
        throw new SyncError(err instanceof Error && err.name !== 'TimeoutError' && err.name !== 'TypeError' ? err.message : `${e.name} did not respond.`);
      }
      if (res.status === 401) throw new SyncError(`${e.name} no longer accepts the stored authorization. Reconnect it.`);
      if (res.status === 429) throw new SyncError(`${e.name} is limiting requests. The next sync will continue.`);
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, ok: res.ok, json, headers: res.headers };
    },
  };
}

export const splitName = (name: string): { first: string; last: string } => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? { first: parts.slice(0, -1).join(' '), last: parts.at(-1)! } : { first: '', last: parts[0] ?? '' };
};
export const joinName = (first: unknown, last: unknown): string => [first, last].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
export const str = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
