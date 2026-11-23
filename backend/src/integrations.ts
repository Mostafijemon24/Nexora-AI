// Integrations: the catalogue, connecting by key or OAuth, connection tests, disconnecting.
// Credentials are encrypted at rest and never returned. Nothing here scrapes, automates clicks or
// reads a private inbox: LinkedIn is reachable only through its official OAuth and approved scopes.

import type { IntegrationCategory, ProviderName } from '../../src/lib/types.ts';
import { removeKey, verifyKey } from './ai/gateway.ts';
import type { Ctx } from './context.ts';
import { decrypt, encrypt, hmac, newToken } from './crypto.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import type { Auth } from './license/service.ts';

interface OAuthSpec { env: string; authUrl: string; tokenUrl: string; scopes: string; probeUrl: string; extraAuthParams?: Record<string, string> }
interface Entry {
  id: string; name: string; cat: IntegrationCategory; desc: string;
  /** provider: an AI provider key · key: another API key or URL · oauth: authorization-code flow */
  kind: 'provider' | 'key' | 'oauth';
  oauth?: OAuthSpec;
}

export const CATALOG: Entry[] = [
  { id: 'li', name: 'LinkedIn', cat: 'Social', desc: 'Official OAuth. Approved scopes only.', kind: 'oauth',
    oauth: { env: 'LINKEDIN', authUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken', scopes: 'openid profile', probeUrl: 'https://api.linkedin.com/v2/userinfo' } },
  { id: 'oa', name: 'OpenAI', cat: 'AI', desc: 'Text and image generation.', kind: 'provider' },
  { id: 'ge', name: 'Google Gemini', cat: 'AI', desc: 'Content generation and research.', kind: 'provider' },
  { id: 'cl', name: 'Anthropic Claude', cat: 'AI', desc: 'Reply suggestions and analysis.', kind: 'provider' },
  { id: 'or', name: 'OpenRouter', cat: 'AI', desc: 'Bring your own key. Free and paid models from many providers.', kind: 'provider' },
  { id: 'hs', name: 'HubSpot', cat: 'CRM', desc: 'Two-way contact sync.', kind: 'oauth',
    oauth: { env: 'HUBSPOT', authUrl: 'https://app.hubspot.com/oauth/authorize', tokenUrl: 'https://api.hubapi.com/oauth/v1/token', scopes: 'crm.objects.contacts.read crm.objects.contacts.write', probeUrl: 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1' } },
  { id: 'sf', name: 'Salesforce', cat: 'CRM', desc: 'Lead and account sync.', kind: 'oauth',
    oauth: { env: 'SALESFORCE', authUrl: 'https://login.salesforce.com/services/oauth2/authorize', tokenUrl: 'https://login.salesforce.com/services/oauth2/token', scopes: 'api refresh_token', probeUrl: 'https://login.salesforce.com/services/oauth2/userinfo' } },
  { id: 'n8', name: 'n8n', cat: 'Automation', desc: 'Trigger external workflows by webhook.', kind: 'key' },
  { id: 'wa', name: 'WhatsApp Cloud API', cat: 'Communication', desc: 'Approved business messaging channel.', kind: 'key' },
  { id: 'gc', name: 'Google Calendar', cat: 'Communication', desc: 'Meeting and follow-up scheduling.', kind: 'oauth',
    oauth: { env: 'GOOGLE_CALENDAR', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: 'https://www.googleapis.com/auth/calendar.events',
      probeUrl: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', extraAuthParams: { access_type: 'offline', prompt: 'consent' } } },
  { id: 'wh', name: 'Webhooks', cat: 'Developer', desc: 'Signed events for leads, posts and runs.', kind: 'key' },
];

const entry = (id: string): Entry => {
  const e = CATALOG.find((x) => x.id === id);
  if (!e) throw notFound('Unknown integration.');
  return e;
};

function oauthApp(ctx: Ctx, spec: OAuthSpec) {
  const env = ctx.config.env;
  const clientId = env[`OAUTH_${spec.env}_CLIENT_ID`];
  const clientSecret = env[`OAUTH_${spec.env}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, scopes: env[`OAUTH_${spec.env}_SCOPES`] || spec.scopes };
}
const callbackUrl = (ctx: Ctx, id: string) => `${ctx.config.publicApiUrl}/v1/integrations/${id}/callback`;

const isHttpsUrl = (s: string) => { try { return new URL(s).protocol === 'https:'; } catch { return false; } };

async function save(ctx: Ctx, workspaceId: string, id: string, secret: string) {
  await ctx.db.query(
    `INSERT INTO integration_connections (workspace_id, integration_id, secret_enc, connected_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, integration_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, connected_at = EXCLUDED.connected_at`,
    [workspaceId, id, encrypt(ctx.config.dataEncryptionKey, secret), ctx.now()]);
}

async function secretFor(ctx: Ctx, auth: Auth, id: string): Promise<string> {
  const r = await ctx.db.query('SELECT secret_enc FROM integration_connections WHERE workspace_id = $1 AND integration_id = $2', [auth.workspaceId, id]);
  if (!r.rows[0]) throw badRequest('This integration is not connected.');
  return decrypt(ctx.config.dataEncryptionKey, r.rows[0].secret_enc);
}

interface TokenSet { access_token: string; refresh_token?: string; expires_at?: number }

/** Stamps an absolute expiry on a token response so it can be refreshed before it lapses. */
function stamp(ctx: Ctx, tokens: Record<string, unknown>, previous?: TokenSet): TokenSet {
  const ttl = Number(tokens.expires_in);
  return {
    ...tokens,
    access_token: String(tokens.access_token),
    // Providers often omit the refresh token on refresh; the old one stays valid.
    refresh_token: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : previous?.refresh_token,
    expires_at: Number.isFinite(ttl) && ttl > 0 ? Math.floor(ctx.now().getTime() / 1000) + ttl : undefined,
  };
}

/** A usable access token for an OAuth integration, refreshed with the stored refresh token when it has expired. */
async function accessToken(ctx: Ctx, workspaceId: string, e: Entry, secret: string, force = false): Promise<string> {
  const t = JSON.parse(secret) as TokenSet;
  const expired = t.expires_at !== undefined && t.expires_at - 60 <= ctx.now().getTime() / 1000;
  if (!(force || expired) || !t.refresh_token) return t.access_token;
  const app = oauthApp(ctx, e.oauth!);
  if (!app) return t.access_token;
  let res: Response;
  try {
    res = await ctx.fetch(e.oauth!.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: app.clientId, client_secret: app.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(502, 'integration_unreachable', `${e.name} did not respond.`);
  }
  const fresh = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof fresh.access_token !== 'string') throw new HttpError(400, 'integration_rejected', `${e.name} no longer accepts the stored authorization. Reconnect it.`);
  const next = stamp(ctx, fresh, t);
  await save(ctx, workspaceId, e.id, JSON.stringify(next));
  return next.access_token;
}

/** Calls the service with the stored credential. Throws a user-facing error when it does not answer OK. */
async function probe(ctx: Ctx, e: Entry, secret: string, workspaceId = ''): Promise<void> {
  let res: Response;
  const viaOAuth = async (force: boolean) =>
    ctx.fetch(e.oauth!.probeUrl, { headers: { Authorization: `Bearer ${await accessToken(ctx, workspaceId, e, secret, force)}` }, signal: AbortSignal.timeout(15_000) });
  try {
    if (e.kind === 'oauth') {
      res = await viaOAuth(false);
      // A token revoked or expired early is refreshed once before giving up.
      if (res.status === 401 && (JSON.parse(secret) as TokenSet).refresh_token) res = await viaOAuth(true);
    } else if (e.id === 'wa') {
      res = await ctx.fetch('https://graph.facebook.com/me', { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
    } else {
      // n8n and generic webhooks: the stored value is the endpoint itself.
      res = await ctx.fetch(secret, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'nexora.ping', at: ctx.now().toISOString() }), signal: AbortSignal.timeout(15_000) });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'integration_unreachable', `${e.name} did not respond.`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'integration_rejected', `${e.name} rejected the stored credential. Reconnect it.`);
  if (!res.ok) throw new HttpError(502, 'integration_error', `${e.name} answered with an error (${res.status}).`);
}

export async function connect(ctx: Ctx, auth: Auth, id: string, apiKey?: string): Promise<{ redirectUrl?: string }> {
  const e = entry(id);
  if (e.kind === 'oauth') {
    const app = oauthApp(ctx, e.oauth!);
    if (!app) throw new HttpError(501, 'integration_not_configured', `${e.name} sign-in is not set up on this server yet.`);
    const state = newToken();
    await ctx.db.query('INSERT INTO oauth_states (state_hash, workspace_id, integration_id, expires_at) VALUES ($1, $2, $3, $4)',
      [hmac(ctx.config.hashSecret, `oauth:${state}`), auth.workspaceId, id, new Date(ctx.now().getTime() + 10 * 60_000)]);
    const url = new URL(e.oauth!.authUrl);
    url.search = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: callbackUrl(ctx, id), scope: app.scopes, state, ...e.oauth!.extraAuthParams }).toString();
    return { redirectUrl: url.toString() };
  }
  const key = (apiKey ?? '').trim();
  if (!key) throw badRequest('Enter a key to continue.');
  if (e.kind === 'provider') {
    if (!(await verifyKey(ctx, auth, e.name as ProviderName, key))) throw badRequest(`${e.name} rejected this key.`);
    return {};
  }
  if ((id === 'n8' || id === 'wh') && !isHttpsUrl(key)) throw badRequest('Enter the full https:// webhook address.');
  if (id !== 'wh') await probe(ctx, e, key); // "Test and connect": a credential that does not work is not stored
  await save(ctx, auth.workspaceId, id, key);
  return {};
}

/** OAuth redirect target. Returns the app URL to send the browser back to. */
export async function oauthCallback(ctx: Ctx, id: string, query: { code?: string; state?: string; error?: string }): Promise<string> {
  const e = entry(id);
  const back = (status: string) => `${ctx.config.appOrigins[0] ?? ''}/?integration=${id}&status=${status}`;
  if (e.kind !== 'oauth' || !query.state) return back('failed');
  const st = (await ctx.db.query('DELETE FROM oauth_states WHERE state_hash = $1 AND integration_id = $2 AND expires_at > $3 RETURNING workspace_id',
    [hmac(ctx.config.hashSecret, `oauth:${query.state}`), id, ctx.now()])).rows[0];
  const app = oauthApp(ctx, e.oauth!);
  if (!st || !app || query.error || !query.code) return back(query.error === 'access_denied' ? 'denied' : 'failed');
  try {
    const res = await ctx.fetch(e.oauth!.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: callbackUrl(ctx, id), client_id: app.clientId, client_secret: app.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = (await res.json()) as Record<string, unknown>;
    if (!res.ok || typeof tokens.access_token !== 'string') return back('failed');
    await save(ctx, st.workspace_id, id, JSON.stringify(stamp(ctx, tokens)));
    return back('connected');
  } catch {
    return back('failed');
  }
}

export async function test(ctx: Ctx, auth: Auth, id: string): Promise<{ latencyMs: number }> {
  const e = entry(id);
  const started = performance.now();
  if (e.kind === 'provider') {
    if (!(await verifyKey(ctx, auth, e.name as ProviderName, ''))) throw new HttpError(400, 'integration_rejected', `${e.name} rejected the stored key.`);
  } else {
    await probe(ctx, e, await secretFor(ctx, auth, id), auth.workspaceId);
  }
  return { latencyMs: Math.max(1, Math.round(performance.now() - started)) };
}

export async function disconnect(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  const e = entry(id);
  if (e.kind === 'provider') return removeKey(ctx, auth, e.name as ProviderName);
  await ctx.db.query('DELETE FROM integration_connections WHERE workspace_id = $1 AND integration_id = $2', [auth.workspaceId, id]);
}
