// Publishing a post to LinkedIn through the official Posts API, as the member who signed in.
// Only a post the user approved is ever published: by pressing Publish, or — when the workspace
// switched it on — by itself on the day an approved post is scheduled for.

import { getState, patchState } from '../connections.ts';
import type { Ctx } from '../context.ts';
import { badRequest, HttpError } from '../errors.ts';
import { apiFor, SyncError } from './common.ts';

interface State extends Record<string, unknown> { member?: string }

/**
 * LinkedIn's API is versioned by month and each version is retired after about a year. Unless
 * LINKEDIN_API_VERSION names one, the version from three months ago is used: recent enough to be
 * supported, old enough to have been released.
 */
export function apiVersion(ctx: Ctx): string {
  const set = ctx.config.env.LINKEDIN_API_VERSION;
  if (set && /^\d{6}$/.test(set)) return set;
  const d = ctx.now();
  const v = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1));
  return `${v.getUTCFullYear()}${String(v.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface Published { url: string }

/** Publishes one post. It must be approved or scheduled, and LinkedIn must be connected with permission to post. */
export async function publishPost(ctx: Ctx, workspaceId: string, postId: string): Promise<Published> {
  const w = workspaceId;
  // Claim the post so two requests (or a request and the scheduler) cannot publish it twice.
  const claimed = (await ctx.db.query(
    `UPDATE posts SET external = external || '{"publishing": true}' WHERE id::text = $1 AND workspace_id = $2 AND status IN ('Approved', 'Scheduled')
       AND NOT coalesce((external->>'publishing')::boolean, false) RETURNING id, title, body`, [postId, w])).rows[0];
  if (!claimed) {
    const p = (await ctx.db.query('SELECT status, published_url, external FROM posts WHERE id::text = $1 AND workspace_id = $2', [postId, w])).rows[0];
    if (!p) throw badRequest('That post does not exist.');
    if (p.external?.publishing) throw new HttpError(409, 'publishing', 'This post is being published right now.');
    if (p.status === 'Published' && p.published_url) return { url: p.published_url };
    throw badRequest(p.status === 'Published' ? 'This post is already marked as published.' : 'Approve the post before publishing it.');
  }
  const release = (error: string | null) => ctx.db.query("UPDATE posts SET external = external - 'publishing', publish_error = $3 WHERE id = $1 AND workspace_id = $2", [claimed.id, w, error]);
  try {
    const api = await apiFor(ctx, w, 'li');
    if (!api) throw new SyncError('LinkedIn is not connected. Connect it on the Integrations page.');
    const state = await getState<State>(ctx, w, 'li');
    let member = state.member;
    if (!member) {
      const me = await api.call('https://api.linkedin.com/v2/userinfo');
      if (!me.ok || typeof me.json?.sub !== 'string') throw new SyncError(`LinkedIn did not say who is signed in (${me.status}). Reconnect it.`);
      member = me.json.sub as string;
      await patchState(ctx, w, 'li', { member });
    }
    const commentary = [claimed.title, claimed.body].map((s: string) => s.trim()).filter(Boolean).join('\n\n').slice(0, 3000);
    const r = await api.call('https://api.linkedin.com/rest/posts', {
      method: 'POST', headers: { 'LinkedIn-Version': apiVersion(ctx), 'X-Restli-Protocol-Version': '2.0.0' },
      body: {
        author: `urn:li:person:${member}`, commentary, visibility: 'PUBLIC', lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      },
    });
    if (r.status === 403) throw new SyncError('LinkedIn has not given this app permission to post (w_member_social). Ask LinkedIn to approve it for your developer app, then reconnect.');
    const urn = r.headers.get('x-restli-id') ?? (typeof r.json?.id === 'string' ? r.json.id : null);
    if (!r.ok || !urn) throw new SyncError(`LinkedIn did not accept the post (${r.status}${typeof r.json?.message === 'string' ? `: ${r.json.message.slice(0, 200)}` : ''}).`);
    const url = `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}/`;
    await ctx.db.query(
      "UPDATE posts SET status = 'Published', date = coalesce(date, $3), published_url = $4, publish_error = NULL, external = (external - 'publishing') || $5::jsonb WHERE id = $1 AND workspace_id = $2",
      [claimed.id, w, ctx.now().toISOString().slice(0, 10), url, JSON.stringify({ li: urn })]);
    await ctx.db.query('INSERT INTO activity (id, workspace_id, text, at) VALUES (gen_random_uuid(), $1, $2, $3)', [w, `Post “${String(claimed.title).slice(0, 80)}” published to LinkedIn`, ctx.now()]);
    return { url };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'LinkedIn could not be reached.';
    await release(message.slice(0, 500));
    throw e instanceof HttpError ? e : new HttpError(e instanceof SyncError ? 400 : 502, 'publish_failed', message);
  }
}

/** Background job: publishes approved posts whose scheduled day has come, for workspaces that asked for it. */
export async function publishDue(ctx: Ctx): Promise<number> {
  const today = ctx.now().toISOString().slice(0, 10);
  const rows = (await ctx.db.query(
    `SELECT p.id, p.workspace_id FROM posts p JOIN workspaces ws ON ws.id = p.workspace_id AND ws.auto_publish
       JOIN integration_connections c ON c.workspace_id = p.workspace_id AND c.integration_id = 'li'
     WHERE p.status = 'Scheduled' AND p.date <= $1 AND p.publish_error IS NULL ORDER BY p.date LIMIT 50`, [today])).rows;
  let n = 0;
  for (const r of rows) {
    // A failure is recorded on the post (and shown there); it is not retried until the user acts.
    try { await publishPost(ctx, r.workspace_id, r.id); n++; } catch { /* recorded on the post */ }
  }
  return n;
}
