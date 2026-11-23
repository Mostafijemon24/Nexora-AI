import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AiTask, DeviceInfo, ProviderName, Range } from '../../src/lib/types.ts';
import * as gateway from './ai/gateway.ts';
import type { Ctx } from './context.ts';
import { badRequest, HttpError, licenseRequired } from './errors.ts';
import * as integrations from './integrations.ts';
import * as license from './license/service.ts';
import type { Auth, Client } from './license/service.ts';
import { applyChange } from './workspace/changes.ts';
import { loadMetrics, loadSnapshot, PROVIDERS } from './workspace/snapshot.ts';

const DEVICE_COOKIE = 'nxr_device';
const SESSION_COOKIE = 'nxr_session';
const YEAR = 365 * 86_400;
/** Origins of the packaged Tauri app. Native clients authenticate with a bearer token, not cookies. */
const NATIVE_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
const AI_TASKS: AiTask[] = ['Content generation', 'Lead research', 'Reply suggestions'];

type Env = { Variables: { auth: Auth } };

export function createApp(ctx: Ctx) {
  const app = new Hono<Env>();
  const secure = ctx.config.publicApiUrl.startsWith('https://');
  const allowed = new Set([...ctx.config.appOrigins, ...NATIVE_ORIGINS]);
  const cookieOpts = { httpOnly: true, secure, sameSite: 'Lax' as const, path: '/', maxAge: YEAR };

  const bearer = (c: Context) => { const h = c.req.header('authorization'); return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined; };
  const ip = (c: Context): string => {
    if (ctx.config.trustProxy) { const f = c.req.header('x-forwarded-for'); if (f) return f.split(',')[0].trim(); }
    return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? 'unknown';
  };
  /** Only identity the server can vouch for: its own cookies or a bearer token, plus request metadata. */
  const identity = (c: Context) => ({
    userAgent: c.req.header('user-agent') ?? '', ip: ip(c),
    webDeviceId: getCookie(c, DEVICE_COOKIE), sessionToken: bearer(c) ?? getCookie(c, SESSION_COOKIE),
  });
  const json = async (c: Context): Promise<Record<string, unknown>> => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw badRequest('Send a JSON object.');
    return b as Record<string, unknown>;
  };
  const clientOf = (c: Context, body: Record<string, unknown>): Client => {
    const d = body.device as Partial<DeviceInfo> | undefined;
    if (!d || typeof d !== 'object') throw badRequest('Device information is missing.');
    return { ...identity(c), device: { id: String(d.id ?? ''), name: String(d.name ?? ''), os: String(d.os ?? ''), platform: (d.platform ?? 'web') as DeviceInfo['platform'], appVersion: String(d.appVersion ?? '') } };
  };
  /** Browsers get httpOnly cookies and never see the token; native apps get it once, for the OS keystore. */
  const deliver = (c: Context, r: license.ActivateResult | license.ConfirmResult) => {
    if (!r.ok) return c.json(r);
    const { sessionToken, deviceId, native, ...body } = r;
    if (native) return c.json({ ...body, sessionToken });
    setCookie(c, DEVICE_COOKIE, deviceId, cookieOpts);
    setCookie(c, SESSION_COOKIE, sessionToken, cookieOpts);
    return c.json(body);
  };

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && allowed.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    // CSRF: browsers always send Origin on cross-site writes, so a foreign Origin is refused outright,
    // and cookies are only honoured on writes that name one of our own origins.
    const usesCookies = !bearer(c) && Boolean(getCookie(c, SESSION_COOKIE) ?? getCookie(c, DEVICE_COOKIE));
    if (c.req.method !== 'GET' && ((origin && !allowed.has(origin)) || (!origin && usesCookies))) {
      return c.json({ code: 'bad_origin', message: 'This request did not come from the Nexora AI app.' }, 403);
    }
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });
  app.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ code: 'too_large', message: 'Request too large.' }, 413) }));

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ code: e.code, message: e.message }, e.status as 400);
    console.error('[unhandled]', e);
    return c.json({ code: 'internal', message: 'Something went wrong on the server.' }, 500);
  });
  app.notFound((c) => c.json({ code: 'not_found', message: 'Not found.' }, 404));

  app.get('/healthz', async (c) => { await ctx.db.query('SELECT 1'); return c.json({ ok: true }); });

  // ── license (no session required) ──────────────────────────────────────
  app.post('/v1/license/status', async (c) => c.json(await license.status(ctx, clientOf(c, await json(c)))));
  app.post('/v1/license/activate', async (c) => { const b = await json(c); return deliver(c, await license.activate(ctx, String(b.key ?? ''), clientOf(c, b))); });
  app.post('/v1/license/transfer/request', async (c) => {
    const b = await json(c);
    const r = await license.requestTransfer(ctx, String(b.key ?? ''), clientOf(c, b));
    if (r.deviceId && !r.native) setCookie(c, DEVICE_COOKIE, r.deviceId, cookieOpts);
    return c.body(null, 204);
  });
  app.post('/v1/license/transfer/confirm', async (c) => {
    const b = await json(c);
    return deliver(c, await license.confirmTransfer(ctx, String(b.key ?? ''), String(b.code ?? ''), clientOf(c, b)));
  });

  // The OAuth provider redirects the browser here; the single-use state identifies the workspace.
  app.get('/v1/integrations/:id/callback', async (c) =>
    c.redirect(await integrations.oauthCallback(ctx, c.req.param('id'), { code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') })));

  // ── everything below needs a session backed by an active license on this device ──
  // Checked on every request, so revocation, expiry, transfer and deactivation take effect at once.
  app.use('/v1/*', async (c, next) => {
    const auth = await license.authenticate(ctx, identity(c));
    if (!auth) throw licenseRequired();
    c.set('auth', auth);
    await next();
  });

  app.post('/v1/license/deactivate', async (c) => {
    await license.deactivate(ctx, c.get('auth'));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.get('/v1/workspace', async (c) => c.json(await loadSnapshot(ctx, c.get('auth'))));
  app.get('/v1/workspace/metrics', async (c) => {
    const range = c.req.query('range');
    if (range !== '7d' && range !== '30d' && range !== '90d') throw badRequest('range must be 7d, 30d or 90d.');
    return c.json(await loadMetrics(ctx, c.get('auth'), range as Range));
  });
  app.post('/v1/workspace/changes', async (c) => { await applyChange(ctx, c.get('auth'), await json(c)); return c.body(null, 204); });

  app.post('/v1/ai/chat', async (c) => {
    const b = await json(c);
    const task = AI_TASKS.includes(b.task as AiTask) ? (b.task as AiTask) : 'Reply suggestions';
    return c.json(await gateway.chat(ctx, c.get('auth'), b.history, task));
  });
  app.post('/v1/ai/posts/generate', async (c) => c.json(await gateway.generatePost(ctx, c.get('auth'), await json(c))));
  app.post('/v1/ai/leads/:id/draft', async (c) => c.json(await gateway.draftMessage(ctx, c.get('auth'), c.req.param('id'))));
  app.post('/v1/ai/providers/verify', async (c) => {
    const b = await json(c);
    if (!PROVIDERS.includes(b.name as ProviderName)) throw badRequest('Unknown provider.');
    return c.json({ verified: await gateway.verifyKey(ctx, c.get('auth'), b.name as ProviderName, String(b.key ?? '')) });
  });
  app.get('/v1/ai/openrouter/models', async (c) => c.json(await gateway.listOpenRouterModels(ctx, c.get('auth'))));

  app.post('/v1/integrations/:id/test', async (c) => c.json(await integrations.test(ctx, c.get('auth'), c.req.param('id'))));
  app.post('/v1/integrations/:id/connect', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json(await integrations.connect(ctx, c.get('auth'), c.req.param('id'), typeof b?.apiKey === 'string' ? b.apiKey : undefined));
  });
  app.delete('/v1/integrations/:id', async (c) => { await integrations.disconnect(ctx, c.get('auth'), c.req.param('id')); return c.body(null, 204); });

  app.post('/v1/backups', async (c) => {
    const auth = c.get('auth');
    const snapshot = await loadSnapshot(ctx, auth);
    const r = await ctx.db.query('INSERT INTO backups (workspace_id, snapshot, created_at) VALUES ($1, $2, $3) RETURNING created_at', [auth.workspaceId, JSON.stringify(snapshot), ctx.now()]);
    return c.json({ completedAt: new Date(r.rows[0].created_at).toISOString() });
  });

  app.delete('/v1/sessions/:id', async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');
    if (id === auth.sessionId) throw badRequest('To sign this device out, deactivate it in Settings → License.');
    await ctx.db.query('UPDATE sessions SET revoked_at = $3 WHERE id::text = $1 AND workspace_id = $2 AND revoked_at IS NULL', [id, auth.workspaceId, ctx.now()]);
    return c.body(null, 204);
  });

  return app;
}
