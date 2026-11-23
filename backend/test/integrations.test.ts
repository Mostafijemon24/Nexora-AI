import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Device, harness, ORIGIN, type Harness } from './helpers.ts';

let h: Harness;
let d: Device;
let ws: string;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const state = async (id: string) => (await d.get('/v1/workspace')).body.integrations.find((g: any) => g.id === id).connected;

beforeAll(async () => {
  h = await harness();
  const lic = await h.license();
  ws = lic.workspaceId;
  d = new Device(h, 'web', 'Chrome');
  await d.activate(lic.key);
});
afterAll(async () => { await h.close(); });
beforeEach(() => { h.calls.length = 0; });

describe('key-based integrations', () => {
  it('requires a key, tests it before storing, and encrypts it', async () => {
    expect((await d.post('/v1/integrations/n8/connect', {})).body.message).toBe('Enter a key to continue.');
    expect((await d.post('/v1/integrations/n8/connect', { apiKey: 'not-a-url' })).body.message).toBe('Enter the full https:// webhook address.');

    h.respond = () => json({}, 500);
    const bad = await d.post('/v1/integrations/n8/connect', { apiKey: 'https://n8n.example/webhook/abc' });
    expect([bad.status, bad.body.code]).toEqual([502, 'integration_error']);
    expect(await state('n8')).toBe(false);

    h.respond = () => json({ ok: true });
    expect((await d.post('/v1/integrations/n8/connect', { apiKey: 'https://n8n.example/webhook/abc' })).body).toEqual({});
    expect(await state('n8')).toBe(true);
    const row = (await h.ctx.db.query("SELECT secret_enc FROM integration_connections WHERE workspace_id = $1 AND integration_id = 'n8'", [ws])).rows[0];
    expect(row.secret_enc).not.toContain('n8n.example');

    h.calls.length = 0;
    const t = await d.post('/v1/integrations/n8/test');
    expect(t.body.latencyMs).toBeGreaterThanOrEqual(1);
    expect(h.calls[0].url).toBe('https://n8n.example/webhook/abc');

    expect((await d.del('/v1/integrations/n8')).status).toBe(204);
    expect(await state('n8')).toBe(false);
    expect((await d.post('/v1/integrations/n8/test')).body.message).toBe('This integration is not connected.');
    expect((await d.post('/v1/integrations/zz/test')).status).toBe(404);
  });
});

describe('OAuth integrations', () => {
  it('says so when the server has no OAuth app for a provider', async () => {
    const r = await d.post('/v1/integrations/li/connect', {});
    expect([r.status, r.body.code]).toEqual([501, 'integration_not_configured']);
  });

  it('redirects to the provider with a single-use state and stores tokens on callback', async () => {
    const r = await d.post('/v1/integrations/hs/connect', {});
    const url = new URL(r.body.redirectUrl);
    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'hs-client', redirect_uri: 'http://localhost:8787/v1/integrations/hs/callback',
      scope: 'crm.objects.contacts.read crm.objects.contacts.write' });
    const st = url.searchParams.get('state')!;

    // A forged state connects nothing.
    const forged = await h.app.request('/v1/integrations/hs/callback?code=abc&state=forged');
    expect(forged.headers.get('location')).toBe(`${ORIGIN}/?integration=hs&status=failed`);
    expect(h.calls).toHaveLength(0);

    h.respond = () => json({ access_token: 'at-1', refresh_token: 'rt-1' });
    const ok = await h.app.request(`/v1/integrations/hs/callback?code=abc&state=${st}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe(`${ORIGIN}/?integration=hs&status=connected`);
    expect(String(h.calls[0].init?.body)).toContain('client_secret=hs-secret');
    expect(await state('hs')).toBe(true);
    const row = (await h.ctx.db.query("SELECT secret_enc FROM integration_connections WHERE workspace_id = $1 AND integration_id = 'hs'", [ws])).rows[0];
    expect(row.secret_enc).not.toContain('at-1');

    // The state cannot be replayed.
    const replay = await h.app.request(`/v1/integrations/hs/callback?code=abc&state=${st}`);
    expect(replay.headers.get('location')).toContain('status=failed');

    h.calls.length = 0;
    h.respond = () => json({ results: [] });
    await d.post('/v1/integrations/hs/test');
    expect(new Headers(h.calls[0].init?.headers).get('authorization')).toBe('Bearer at-1');
    h.respond = () => json({}, 401);
    expect((await d.post('/v1/integrations/hs/test')).body.code).toBe('integration_rejected');
  });

  it('refreshes an expired access token with the stored refresh token and keeps the new one', async () => {
    await d.del('/v1/integrations/hs');
    const st = new URL((await d.post('/v1/integrations/hs/connect', {})).body.redirectUrl).searchParams.get('state')!;
    h.respond = () => json({ access_token: 'at-old', refresh_token: 'rt-1', expires_in: 1800 });
    await h.app.request(`/v1/integrations/hs/callback?code=abc&state=${st}`);

    h.advance(3600_000); // the access token has expired
    h.calls.length = 0;
    h.respond = (url) => (url.includes('/oauth/v1/token') ? json({ access_token: 'at-new', expires_in: 1800 }) : json({ results: [] }));
    expect((await d.post('/v1/integrations/hs/test')).status).toBe(200);
    expect(String(h.calls[0].init?.body)).toContain('grant_type=refresh_token');
    expect(String(h.calls[0].init?.body)).toContain('refresh_token=rt-1');
    expect(new Headers(h.calls[1].init?.headers).get('authorization')).toBe('Bearer at-new');

    // The refreshed token was stored (and the refresh token kept), so the next call does not refresh again.
    h.calls.length = 0;
    await d.post('/v1/integrations/hs/test');
    expect(h.calls).toHaveLength(1);
    expect(new Headers(h.calls[0].init?.headers).get('authorization')).toBe('Bearer at-new');

    // A refresh the provider rejects asks the user to reconnect.
    h.advance(3600_000);
    h.respond = () => json({ error: 'invalid_grant' }, 400);
    const r = await d.post('/v1/integrations/hs/test');
    expect([r.status, r.body.message]).toEqual([400, 'HubSpot no longer accepts the stored authorization. Reconnect it.']);
  });

  it('reports a denied authorization without connecting', async () => {
    await d.del('/v1/integrations/hs');
    const st = new URL((await d.post('/v1/integrations/hs/connect', {})).body.redirectUrl).searchParams.get('state')!;
    const res = await h.app.request(`/v1/integrations/hs/callback?error=access_denied&state=${st}`);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/?integration=hs&status=denied`);
    expect(await state('hs')).toBe(false);
  });
});
