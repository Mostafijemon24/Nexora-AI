// Integrations: the catalogue, connecting by key or OAuth, connection tests, disconnecting.
// Credentials are encrypted at rest and never returned. Nothing here scrapes, automates clicks or
// reads a private inbox: LinkedIn is reachable only through its official OAuth and approved scopes.

import { CATALOG as SHARED, type CatalogEntry } from '../../src/lib/integrations.ts';
import type { ConnectDetail, ProviderName } from '../../src/lib/types.ts';
import { removeKey, verifyKey } from './ai/gateway.ts';
import { EMAIL_RE, graphUrl, type EmailAccount, type WhatsAppAccount } from './channels.ts';
import { getSecret, issueHook, patchState, removeConnection, saveSecret } from './connections.ts';
import type { Ctx } from './context.ts';
import { hmac, newToken } from './crypto.ts';
import { badRequest, HttpError, notFound } from './errors.ts';
import type { Auth } from './license/service.ts';
import { parseHook, postHook, unsafeUrlReason } from './webhooks.ts';

interface OAuthSpec { env: string; authUrl: string; tokenUrl: string; scopes: string; probeUrl: string; extraAuthParams?: Record<string, string> }
type Entry = CatalogEntry & { oauth?: OAuthSpec };

const OAUTH: Record<string, OAuthSpec> = {
  // w_member_social lets the app publish posts the user approved; LinkedIn must grant it to the developer app.
  li: { env: 'LINKEDIN', authUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken', scopes: 'openid profile w_member_social', probeUrl: 'https://api.linkedin.com/v2/userinfo' },
  hs: { env: 'HUBSPOT', authUrl: 'https://app.hubspot.com/oauth/authorize', tokenUrl: 'https://api.hubapi.com/oauth/v1/token', scopes: 'crm.objects.contacts.read crm.objects.contacts.write', probeUrl: 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1' },
  sf: { env: 'SALESFORCE', authUrl: 'https://login.salesforce.com/services/oauth2/authorize', tokenUrl: 'https://login.salesforce.com/services/oauth2/token', scopes: 'api refresh_token', probeUrl: 'https://login.salesforce.com/services/oauth2/userinfo' },
  gc: { env: 'GOOGLE_CALENDAR', authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', scopes: 'https://www.googleapis.com/auth/calendar.events',
    probeUrl: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1', extraAuthParams: { access_type: 'offline', prompt: 'consent' } },
};

export const CATALOG: Entry[] = SHARED.map((e) => ({ ...e, oauth: OAUTH[e.id] }));

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

const save = saveSecret;

async function secretFor(ctx: Ctx, auth: Auth, id: string): Promise<string> {
  const s = await getSecret(ctx, auth.workspaceId, id);
  if (s === null) throw badRequest('This integration is not connected.');
  return s;
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
export async function accessToken(ctx: Ctx, workspaceId: string, e: Entry, secret: string, force = false): Promise<string> {
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
      const acct = JSON.parse(secret) as WhatsAppAccount;
      res = await ctx.fetch(graphUrl(ctx, `${encodeURIComponent(acct.phoneNumberId)}?fields=display_phone_number`), { headers: { Authorization: `Bearer ${acct.token}` }, signal: AbortSignal.timeout(15_000) });
    } else if (e.id === 'em') {
      const acct = JSON.parse(secret) as EmailAccount;
      try {
        await ctx.smtp(acct).verify?.();
        if (acct.imapHost) await ctx.mailbox({ host: acct.imapHost, port: acct.imapPort || '993', user: acct.user, password: acct.password }).fetchAfter(null);
      } catch (err) {
        throw new HttpError(400, 'integration_rejected', `The mail server did not accept these details: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
      return;
    } else if (e.kind === 'hook') {
      return;
    } else {
      // n8n and generic webhooks: a signed ping to the stored address.
      const target = parseHook(secret);
      const reason = await unsafeUrlReason(ctx, target.url);
      if (reason) throw badRequest(reason);
      res = await postHook(ctx, target, { type: 'nexora.ping', at: ctx.now().toISOString() });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'integration_unreachable', `${e.name} did not respond.`);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(400, 'integration_rejected', `${e.name} rejected the stored credential. Reconnect it.`);
  if (!res.ok) throw new HttpError(502, 'integration_error', `${e.name} answered with an error (${res.status}).`);
}

/** The values a person typed for a `fields` integration, trimmed and checked. */
function readFields(e: Entry, input: unknown): Record<string, string> {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of e.fields ?? []) {
    const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim() : '';
    if (!v && !f.optional) throw badRequest(`Enter: ${f.label}.`);
    if (v.length > 2000) throw badRequest(`“${f.label}” is too long.`);
    out[f.key] = v;
  }
  return out;
}

export interface ConnectResult { redirectUrl?: string; details?: ConnectDetail[] }

/**
 * Connects an integration. OAuth ones return the provider's sign-in address; the others check the
 * credentials with the service before storing them ("test and connect"). `input` is an API key, or
 * the named fields the integration asks for.
 */
export async function connect(ctx: Ctx, auth: Auth, id: string, input?: unknown): Promise<ConnectResult> {
  const e = entry(id);
  const w = auth.workspaceId;
  if (e.kind === 'oauth') {
    const app = oauthApp(ctx, e.oauth!);
    if (!app) throw new HttpError(501, 'integration_not_configured', `${e.name} sign-in is not set up on this server yet.`);
    const state = newToken();
    await ctx.db.query('INSERT INTO oauth_states (state_hash, workspace_id, integration_id, expires_at) VALUES ($1, $2, $3, $4)',
      [hmac(ctx.config.hashSecret, `oauth:${state}`), w, id, new Date(ctx.now().getTime() + 10 * 60_000)]);
    const url = new URL(e.oauth!.authUrl);
    url.search = new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: callbackUrl(ctx, id), scope: app.scopes, state, ...e.oauth!.extraAuthParams }).toString();
    return { redirectUrl: url.toString() };
  }
  if (e.kind === 'provider') {
    const key = typeof input === 'string' ? input.trim() : '';
    if (!key) throw badRequest('Enter a key to continue.');
    if (!(await verifyKey(ctx, auth, e.name as ProviderName, key))) throw badRequest(`${e.name} rejected this key.`);
    return {};
  }
  if (e.kind === 'hook') {
    await save(ctx, w, id, '{}');
    const token = await issueHook(ctx, w, id);
    return { details: [
      { label: 'Post messages to this address', value: `${ctx.config.publicApiUrl}/v1/hooks/in/${token}` },
      { label: 'Body (JSON)', value: '{"channel": "Email" or "WhatsApp", "from": "address or phone", "name": "optional", "text": "the message", "id": "optional unique id"}' },
    ] };
  }

  // A single pasted value is accepted for the webhook integrations, as before.
  const f = readFields(e, typeof input === 'string' ? { url: input } : input);
  if (id === 'wh' || id === 'n8') {
    const reason = await unsafeUrlReason(ctx, f.url);
    if (reason) throw badRequest(reason);
    if (f.secret && f.secret.length < 16) throw badRequest('Use a signing secret of at least 16 characters, or leave it empty.');
  }
  if (id === 'em') {
    if (!EMAIL_RE.test(f.from)) throw badRequest('Enter your email address.');
    if (!/^\d{2,5}$/.test(f.port)) throw badRequest('Enter the SMTP port as a number, usually 465 or 587.');
    if (f.imapHost && f.imapPort && !/^\d{2,5}$/.test(f.imapPort)) throw badRequest('Enter the IMAP port as a number, usually 993.');
  }
  const secret = JSON.stringify(f);
  if (id !== 'wh') await probe(ctx, e, secret); // a credential that does not work is not stored
  await save(ctx, w, id, secret);
  if (id === 'em') {
    // Only mail that arrives from now on is brought in; the existing mailbox is left alone.
    const start = f.imapHost ? await ctx.mailbox({ host: f.imapHost, port: f.imapPort || '993', user: f.user, password: f.password }).fetchAfter(null) : null;
    await patchState(ctx, w, id, { imapValidity: start?.validity ?? null, imapLastUid: start?.lastUid ?? null });
    return {};
  }
  if (id === 'wa') {
    const token = await issueHook(ctx, w, id);
    return { details: [
      { label: 'Callback URL (Meta for Developers → WhatsApp → Configuration)', value: `${ctx.config.publicApiUrl}/v1/hooks/wa/${token}` },
      { label: 'Verify token', value: token },
      { label: 'Webhook field to subscribe to', value: 'messages' },
    ] };
  }
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
  await removeConnection(ctx, auth.workspaceId, id);
}
