import type {
  AiTask, DashboardMetrics, Integration, OpenRouterSettings, ProviderName, Range, SyncSettings, WorkspaceSnapshot,
} from '../../../src/lib/types.ts';
import type { Ctx } from '../context.ts';
import type { Q } from '../db.ts';
import { notFound } from '../errors.ts';
import { listWorkspaces, loadTeam } from '../auth/accounts.ts';
import { CATALOG } from '../integrations.ts';
import type { Auth } from '../license/service.ts';
import { loadCampaigns, loadConversations, loadLeads, loadRuns, loadTasks, loadWorkflows } from './store.ts';

export { loadConversations, loadLeads };

export const PROVIDERS: ProviderName[] = ['OpenAI', 'Google Gemini', 'Anthropic Claude', 'OpenRouter'];
const iso = (d: Date | string) => new Date(d).toISOString();

/**
 * Roughly where a session is: the city of the device's time zone and the network address the
 * server saw, with its last part hidden. Neither is exact; together they are enough to notice a
 * session that is not yours.
 */
function place(zone: string | null, ip: string | null): string {
  const city = zone && zone.includes('/') ? zone.split('/').at(-1)!.replace(/_/g, ' ') : '';
  const masked = !ip ? '' : ip.includes(':') ? `${ip.split(':').slice(0, 3).join(':')}:…` : ip.replace(/\.\d+$/, '.•');
  return [city, masked].filter(Boolean).join(' · ');
}

function ago(then: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (s < 120) return 'active now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86_400) { const h = Math.round(s / 3600); return `${h} hour${h === 1 ? '' : 's'} ago`; }
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Connection state for every integration in the catalog. AI entries mirror the provider keys. */
export async function loadIntegrations(q: Q, workspaceId: string): Promise<Integration[]> {
  const conn = new Map((await q.query('SELECT integration_id, state FROM integration_connections WHERE workspace_id = $1', [workspaceId])).rows.map((r) => [r.integration_id as string, r.state as Record<string, any>]));
  const keys = new Set((await q.query('SELECT provider FROM provider_credentials WHERE workspace_id = $1 AND verified', [workspaceId])).rows.map((r) => r.provider as string));
  return CATALOG.map((c) => {
    const sync = conn.get(c.id)?.sync;
    return {
      id: c.id, name: c.name, cat: c.cat, desc: c.desc, oauth: c.kind === 'oauth',
      connected: c.kind === 'provider' ? keys.has(c.name) : conn.has(c.id),
      ...(c.fields ? { fields: c.fields } : {}), ...(c.kind === 'hook' ? { hook: true } : {}),
      ...(sync && typeof sync.at === 'string' ? { sync: { at: sync.at, note: String(sync.note ?? ''), ok: sync.ok !== false } } : {}),
    };
  });
}

/** Everything the client needs for one workspace. Secrets (keys, tokens) are never part of it. */
export async function loadSnapshot(ctx: Ctx, auth: Auth, q: Q = ctx.db): Promise<WorkspaceSnapshot> {
  const w = auth.workspaceId;
  const now = ctx.now();
  const ws = (await q.query('SELECT * FROM workspaces WHERE id = $1', [w])).rows[0];
  if (!ws) throw notFound('Workspace not found.');
  const one = async (sql: string, params: unknown[] = [w]) => (await q.query(sql, params)).rows;

  const [user] = await one('SELECT name, email, totp_enabled, (password_hash IS NOT NULL) AS has_password FROM users WHERE id = $1', [auth.userId]);
  const [plan] = await one(
    `SELECT p.name FROM licenses l JOIN subscriptions s ON s.id = l.subscription_id JOIN subscription_plans p ON p.id = s.plan_id WHERE l.id = $1`, [auth.licenseId]);
  const sessions = await one(
    `SELECT s.id, s.last_seen_at, s.time_zone, s.ip, d.name, d.os, u.name AS user_name FROM sessions s JOIN license_devices d ON d.id = s.device_id
     JOIN license_activations a ON a.id = s.activation_id JOIN users u ON u.id = s.user_id
     WHERE s.workspace_id = $1 AND s.revoked_at IS NULL AND a.deactivated_at IS NULL ORDER BY (s.id = $2) DESC, s.last_seen_at DESC`, [w, auth.sessionId]);
  const admin = auth.role === 'owner' || auth.role === 'admin';
  const creds = await one('SELECT provider, verified FROM provider_credentials WHERE workspace_id = $1');
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [usage] = await one(
    `SELECT count(*) FILTER (WHERE kind = 'post')::int AS posts,
            coalesce(sum(input_tokens + output_tokens) FILTER (WHERE created_at >= $2), 0)::int AS tokens,
            coalesce(sum(cost_usd) FILTER (WHERE created_at >= $2), 0)::float AS cost
     FROM usage_records WHERE workspace_id = $1`, [w, monthStart]);
  const byProvider = await one(
    `SELECT provider, count(*)::int AS requests, coalesce(sum(input_tokens + output_tokens), 0)::int AS tokens, coalesce(sum(cost_usd), 0)::float AS cost,
            bool_and(cost_usd IS NOT NULL) AS priced
     FROM usage_records WHERE workspace_id = $1 AND created_at >= $2 GROUP BY provider ORDER BY provider`, [w, monthStart]);
  const [backup] = await one('SELECT created_at FROM backups WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1');

  return {
    plan: { name: plan?.name ?? '', hosting: 'Hybrid hosting', features: auth.features },
    profile: { name: user.name, email: user.email, workspace: ws.name },
    me: { id: auth.userId, name: user.name, email: user.email, role: auth.role, hasPassword: user.has_password, mfa: user.totp_enabled },
    ...(admin ? { team: await loadTeam(q, w, now) } : {}),
    workspaces: await listWorkspaces(q, auth),
    leads: await loadLeads(q, w),
    campaigns: await loadCampaigns(q, w),
    icp: ws.icp,
    prompts: await one('SELECT id, title, text FROM prompts WHERE workspace_id = $1 ORDER BY created_at, id'),
    posts: (await one('SELECT id, title, body, status, date, published_url, publish_error FROM posts WHERE workspace_id = $1 ORDER BY created_at DESC, id'))
      .map((p) => ({ id: p.id, title: p.title, body: p.body, status: p.status, date: p.date, ...(p.published_url ? { publishedUrl: p.published_url } : {}), ...(p.publish_error ? { publishError: p.publish_error } : {}) })),
    conversations: await loadConversations(q, w),
    savedReplies: await one('SELECT title, text FROM saved_replies WHERE workspace_id = $1 ORDER BY position, id'),
    workflows: await loadWorkflows(q, w),
    runs: await loadRuns(q, w),
    integrations: await loadIntegrations(q, w),
    tasks: await loadTasks(q, w),
    activity: (await one('SELECT text, at FROM activity WHERE workspace_id = $1 ORDER BY at DESC, id LIMIT 6')).map((a) => ({ text: a.text, at: iso(a.at) })),
    routing: ws.routing as Record<AiTask, ProviderName>,
    providers: PROVIDERS.map((name) => ({ name, verified: creds.some((c) => c.provider === name && c.verified) })),
    openRouter: ws.openrouter as OpenRouterSettings,
    mfa: ws.mfa,
    sessions: sessions.map((s) => ({
      id: s.id, current: s.id === auth.sessionId,
      device: s.id === auth.sessionId ? `${s.name} · this device` : `${s.name} · ${s.os}`,
      meta: [s.id === auth.sessionId ? 'active now' : ago(new Date(s.last_seen_at), now), place(s.time_zone, s.ip), sessions.some((x) => x.user_name !== s.user_name) ? s.user_name : ''].filter(Boolean).join(' · '),
    })),
    // The region is where this server runs, as its operator set it; it is not something a workspace can choose.
    sync: { ...(ws.sync as Omit<SyncSettings, 'lastBackupAt'>), region: ctx.config.env.REGION?.trim().slice(0, 60) || 'Not stated by this server', lastBackupAt: backup ? iso(backup.created_at) : '' },
    aiUsage: {
      postsGenerated: usage.posts, tokensThisMonth: usage.tokens, costThisMonthUsd: usage.cost,
      byProvider: byProvider.map((p) => ({ provider: p.provider, requests: p.requests, tokens: p.tokens, costUsd: p.cost, priced: p.priced })),
    },
    brandVoice: ws.brand_voice,
    autoPublish: ws.auto_publish,
    automationDailyRunLimit: ws.automation_daily_run_limit,
  };
}

const DAY = 86_400_000;
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Dashboard numbers for a range, computed from stored data.
 * Bars: replies received (inbound messages) per day / week / month.
 * Funnel: leads created in the range, by the furthest stage each has reached.
 */
export async function loadMetrics(ctx: Ctx, auth: Auth, range: Range): Promise<DashboardMetrics> {
  const now = ctx.now();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let buckets: { label: string; from: number; to: number }[];
  if (range === '7d') {
    buckets = Array.from({ length: 7 }, (_, i) => { const from = today - (6 - i) * DAY; return { label: WEEKDAY[new Date(from).getUTCDay()], from, to: from + DAY }; });
  } else if (range === '30d') {
    buckets = Array.from({ length: 4 }, (_, i) => { const to = today + DAY - (3 - i) * 7 * DAY; return { label: `W${i + 1}`, from: to - 7 * DAY, to }; });
  } else {
    buckets = Array.from({ length: 3 }, (_, i) => {
      const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (2 - i), 1);
      const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (2 - i) + 1, 1);
      return { label: MONTH[new Date(from).getUTCMonth()], from, to };
    });
  }
  const start = buckets[0].from;
  const counts = buckets.map(() => 0);
  for (const c of await loadConversations(ctx.db, auth.workspaceId)) {
    for (const m of c.msgs) {
      if (m.me) continue;
      const t = Date.parse(m.at);
      const i = buckets.findIndex((b) => t >= b.from && t < b.to);
      if (i >= 0) counts[i] += 1;
    }
  }
  const f = (await ctx.db.query(
    `SELECT count(*)::int AS new,
            count(*) FILTER (WHERE status IN ('contacted', 'interested', 'converted'))::int AS contacted,
            count(*) FILTER (WHERE status IN ('interested', 'converted'))::int AS interested,
            count(*) FILTER (WHERE status = 'converted')::int AS converted
     FROM leads WHERE workspace_id = $1 AND created_at >= $2`, [auth.workspaceId, new Date(start)])).rows[0];
  return { bars: buckets.map((b, i) => ({ label: b.label, value: counts[i] })), funnel: [f.new, f.contacted, f.interested, f.converted] };
}
