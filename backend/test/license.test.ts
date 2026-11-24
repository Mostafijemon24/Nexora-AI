import { createPublicKey, verify } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicKeyBase64 } from '../src/crypto.ts';
import { renewLicense, revokeLicense } from '../src/license/service.ts';
import { codeFrom, Device, harness, TEST_SEED, type Harness } from './helpers.ts';

let h: Harness;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h.close(); });
beforeEach(() => { h.mails.length = 0; h.setNow('2026-11-23T09:00:00Z'); });

const DAY = 86_400_000;
const activeCount = async (licenseId: string) =>
  (await h.ctx.db.query('SELECT count(*)::int AS n FROM license_activations WHERE license_id = $1 AND deactivated_at IS NULL', [licenseId])).rows[0].n;
const events = async (licenseId: string | null) =>
  (await h.ctx.db.query('SELECT type, detail FROM license_events WHERE license_id IS NOT DISTINCT FROM $1 ORDER BY seq', [licenseId])).rows;

function decodeToken(token: string) {
  const [body, sig] = token.split('.');
  return { payload: JSON.parse(Buffer.from(body, 'base64url').toString()), body: Buffer.from(body, 'base64url'), sig: Buffer.from(sig, 'base64url') };
}

describe('activation', () => {
  it('locks every protected route until a license is activated', async () => {
    const d = new Device(h, 'native', 'PC-1');
    expect((await d.status()).body).toEqual({ license: null, events: [] });
    for (const [m, p] of [['GET', '/v1/workspace'], ['GET', '/v1/workspace/metrics?range=7d'], ['POST', '/v1/ai/chat'], ['POST', '/v1/backups'], ['POST', '/v1/license/deactivate']] as const) {
      const r = await d.req(m, p, m === 'POST' ? {} : undefined);
      expect([r.status, r.body.code], p).toEqual([401, 'license_required']);
    }
  });

  it('activates a valid key on a first device and reports the license', async () => {
    const lic = await h.license();
    const d = new Device(h, 'native', 'RAFIQ-WORKSTATION');
    const r = await d.activate(` ${lic.key.toLowerCase()} `); // keys are case- and whitespace-insensitive
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      license: { keyMasked: `NXR-••••-${lic.key.slice(-4)}`, plan: 'Professional', priceLabel: '$29 / month', renewsOn: '23 December 2026',
        deviceName: 'RAFIQ-WORKSTATION', deviceOs: 'Windows 11', activatedAt: '23 Nov 2026', activeDevices: 1, maxDevices: 1 },
    });
    expect((await d.get('/v1/workspace')).status).toBe(200);
    const st = await d.status();
    expect(st.body.license.deviceName).toBe('RAFIQ-WORKSTATION');
    expect(st.body.events.map((e: any) => e.text)).toEqual(['Activated on RAFIQ-WORKSTATION · Windows 11', 'License issued']);
  });

  it('rejects unknown, expired and revoked keys with distinct results and audits each failure', async () => {
    const d = new Device(h, 'native', 'PC-2');
    expect((await d.activate('NXR-NOPE0-NOPE0-NOPE0-NOPE0')).body).toEqual({ ok: false, code: 'invalid' });
    expect((await events(null)).at(-1)).toEqual({ type: 'activation_failed', detail: 'Failed activation: Invalid license key' });

    const expired = await h.license();
    h.advance(40 * DAY);
    expect((await d.activate(expired.key)).body).toEqual({ ok: false, code: 'expired', expiredOn: '23 December 2026' });

    const revoked = await h.license();
    await revokeLicense(h.ctx, revoked.key);
    expect((await d.activate(revoked.key)).body).toEqual({ ok: false, code: 'revoked' });
    expect((await events(revoked.licenseId)).map((e) => e.type)).toEqual(['created', 'revoked', 'activation_failed']);
    expect(d.token).toBeUndefined();
  });

  it('rejects a second device while the first is active', async () => {
    const lic = await h.license();
    const a = new Device(h, 'native', 'RAFIQ-LAPTOP');
    const b = new Device(h, 'native', 'RAFIQ-WORKSTATION');
    await a.activate(lic.key);
    const r = await b.activate(lic.key);
    expect(r.body).toEqual({ ok: false, code: 'in_use', deviceName: 'RAFIQ-LAPTOP', deviceOs: 'Windows 11', activatedAt: '23 Nov 2026' });
    expect((await b.get('/v1/workspace')).status).toBe(401);
    expect(await activeCount(lic.licenseId)).toBe(1);
    expect((await a.get('/v1/workspace')).status).toBe(200);
  });

  it('admits exactly one of many simultaneous activations from different devices', async () => {
    const lic = await h.license();
    const devices = Array.from({ length: 12 }, (_, i) => new Device(h, 'native', `RACE-${i}`));
    const results = await Promise.all(devices.map((d) => d.activate(lic.key)));
    expect(results.filter((r) => r.body.ok).length).toBe(1);
    expect(results.filter((r) => r.body.code === 'in_use').length).toBe(11);
    expect(await activeCount(lic.licenseId)).toBe(1);
  });

  it('is backed by a database constraint, not only by application logic', async () => {
    const lic = await h.license();
    const mk = async () => (await h.ctx.db.query("INSERT INTO license_devices (kind, client_ref, platform, name, os) VALUES ('native', gen_random_uuid()::text, 'windows', 'X', 'Y') RETURNING id")).rows[0].id;
    const [d1, d2] = [await mk(), await mk()];
    await h.ctx.db.query('INSERT INTO license_activations (license_id, device_id, slot) VALUES ($1, $2, 0)', [lic.licenseId, d1]);
    await expect(h.ctx.db.query('INSERT INTO license_activations (license_id, device_id, slot) VALUES ($1, $2, 0)', [lic.licenseId, d2]))
      .rejects.toMatchObject({ code: '23505', constraint: 'license_activations_active_slot_key' });
  });

  it('honours a per-license device limit above one', async () => {
    const lic = await h.license({ maxDevices: 2 });
    const [a, b, c] = ['A', 'B', 'C'].map((n) => new Device(h, 'native', n));
    expect((await a.activate(lic.key)).body.ok).toBe(true);
    const second = await b.activate(lic.key);
    expect(second.body).toMatchObject({ ok: true, license: { activeDevices: 2, maxDevices: 2 } });
    expect((await c.activate(lic.key)).body.code).toBe('in_use');
  });

  it('lets an install that lost its session back in with the key, and never runs two sessions on one seat', async () => {
    const lic = await h.license();
    const real = new Device(h, 'native', 'REAL');
    await real.activate(lic.key);
    // The install lost its saved session but still has its registration id, which it keeps in the
    // OS secure store and which is never shown or sent to anyone but this server.
    const again = new Device(h, 'native', 'REAL');
    again.info.id = real.info.id;
    expect((await again.activate(lic.key)).body.ok).toBe(true);
    expect((await again.get('/v1/workspace')).status).toBe(200);
    expect(await activeCount(lic.licenseId)).toBe(1);
    // The earlier session ended: one seat never carries two sessions.
    expect((await real.get('/v1/workspace')).status).toBe(401);
    // Another install, which knows the key but not that id, is still refused.
    const other = new Device(h, 'native', 'OTHER');
    expect((await other.activate(lic.key)).body.code).toBe('in_use');
    expect((await other.get('/v1/workspace')).status).toBe(401);
    // A browser gets its seat back the same way: by the device cookie only this server issued it.
    const lic2 = await h.license();
    const web = new Device(h, 'web', 'Chrome');
    await web.activate(lic2.key);
    web.cookies.delete('nxr_session');
    expect((await web.get('/v1/workspace')).status).toBe(401);
    expect((await web.activate(lic2.key)).body.ok).toBe(true);
    expect((await web.get('/v1/workspace')).status).toBe(200);
    expect(await activeCount(lic2.licenseId)).toBe(1);
  });

  it('rate-limits repeated attempts', async () => {
    const d = new Device(h, 'native', 'GUESSER');
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await d.activate('NXR-GUESS-GUESS-GUESS-GUESS')).status);
    expect(codes.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
    h.advance(11 * 60_000);
  });
});

describe('web devices', () => {
  it('treats every tab of one browser as one device, with the token kept in httpOnly cookies', async () => {
    const lic = await h.license();
    const browser = new Device(h, 'web', 'Chrome on Windows');
    const r = await browser.activate(lic.key);
    expect(r.body.ok).toBe(true);
    expect(r.body.sessionToken).toBeUndefined();
    expect(r.body.entitlementToken).toBe('');
    expect(r.headers.getSetCookie().every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);

    // A second tab shares the cookie jar: same device, no second seat, activation is idempotent.
    const tab2 = new Device(h, 'web', 'Chrome on Windows', browser.userAgent);
    tab2.cookies = browser.cookies;
    expect((await tab2.status()).body.license.deviceName).toBe('Chrome on Windows');
    expect((await tab2.activate(lic.key)).body.ok).toBe(true);
    expect(await activeCount(lic.licenseId)).toBe(1);
    expect((await h.ctx.db.query("SELECT count(*)::int AS n FROM license_devices WHERE name = 'Chrome on Windows'")).rows[0].n).toBe(1);
  });

  it('refuses cookies replayed from a different browser', async () => {
    const lic = await h.license();
    const browser = new Device(h, 'web', 'Chrome');
    await browser.activate(lic.key);
    const thief = new Device(h, 'web', 'Other', 'SomeOtherBrowser/9');
    thief.cookies = new Map(browser.cookies);
    expect((await thief.get('/v1/workspace')).status).toBe(401);
    // Session cookie without the matching device cookie is not enough either.
    const partial = new Device(h, 'web', 'Chrome', browser.userAgent);
    partial.cookies.set('nxr_session', browser.cookies.get('nxr_session')!);
    expect((await partial.get('/v1/workspace')).status).toBe(401);
  });

  it('refuses cookie-authenticated writes from another origin (CSRF)', async () => {
    const lic = await h.license();
    const browser = new Device(h, 'web', 'Chrome');
    await browser.activate(lic.key);
    for (const origin of ['https://evil.example', '']) {
      const r = await browser.req('POST', '/v1/license/deactivate', {}, { origin });
      expect([r.status, r.body.code]).toEqual([403, 'bad_origin']);
    }
    expect((await browser.get('/v1/workspace')).status).toBe(200);
  });
});

describe('deactivation and transfer', () => {
  it('frees the seat on deactivation and locks the old device immediately', async () => {
    const lic = await h.license();
    const a = new Device(h, 'native', 'OLD');
    const b = new Device(h, 'native', 'NEW');
    await a.activate(lic.key);
    expect((await a.post('/v1/license/deactivate')).status).toBe(204);
    expect((await a.get('/v1/workspace')).status).toBe(401);
    expect((await a.status()).body.license).toBeNull();
    expect((await b.activate(lic.key)).body.ok).toBe(true);
    expect((await events(lic.licenseId)).map((e) => e.detail)).toEqual(
      ['License issued', 'Activated on OLD · Windows 11', 'Deactivated on OLD · Windows 11', 'Activated on NEW · Windows 11']);
  });

  it('transfers to a new device only with the code emailed to the owner', async () => {
    const lic = await h.license({ email: 'owner@northwind.example' });
    const old = new Device(h, 'native', 'RAFIQ-LAPTOP');
    const next = new Device(h, 'native', 'RAFIQ-WORKSTATION');
    await old.activate(lic.key);
    expect((await next.activate(lic.key)).body.code).toBe('in_use');

    expect((await next.requestTransfer(lic.key)).status).toBe(204);
    expect(h.mails).toHaveLength(1);
    expect(h.mails[0].to).toBe('owner@northwind.example');
    const code = codeFrom(h.mails[0]);
    const stored = (await h.ctx.db.query('SELECT code_hash FROM license_transfers WHERE license_id = $1', [lic.licenseId])).rows[0].code_hash;
    expect(stored).not.toContain(code); // only a keyed hash is kept

    const wrong = code === '000000' ? '000001' : '000000';
    expect((await next.confirmTransfer(lic.key, wrong)).body).toEqual({ ok: false, code: 'bad_code' });
    expect((await old.get('/v1/workspace')).status).toBe(200); // nothing moved yet

    const ok = await next.confirmTransfer(lic.key, code);
    expect(ok.body).toMatchObject({ ok: true, license: { deviceName: 'RAFIQ-WORKSTATION', activeDevices: 1 } });
    expect((await old.get('/v1/workspace')).status).toBe(401); // old device deactivated server-side
    expect((await next.get('/v1/workspace')).status).toBe(200);
    expect(await activeCount(lic.licenseId)).toBe(1);
    expect((await events(lic.licenseId)).map((e) => e.type)).toEqual(
      ['created', 'activated', 'activation_failed', 'transfer_requested', 'transfer_failed', 'transferred']);
    expect((await next.confirmTransfer(lic.key, code)).body.code).toBe('bad_code'); // single use
  });

  it('kills a code after five wrong guesses, after ten minutes, and when used from another device', async () => {
    const lic = await h.license();
    const old = new Device(h, 'native', 'OLD');
    await old.activate(lic.key);

    const guesser = new Device(h, 'native', 'GUESS');
    await guesser.requestTransfer(lic.key);
    const code = codeFrom(h.mails.at(-1)!);
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) expect((await guesser.confirmTransfer(lic.key, wrong)).body.code).toBe('bad_code');
    expect((await guesser.confirmTransfer(lic.key, code)).body.code).toBe('bad_code');

    h.advance(16 * 60_000); // also resets the request rate limit window
    const late = new Device(h, 'native', 'LATE');
    await late.requestTransfer(lic.key);
    const code2 = codeFrom(h.mails.at(-1)!);
    const bystander = new Device(h, 'native', 'BYSTANDER');
    expect((await bystander.confirmTransfer(lic.key, code2)).body.code).toBe('bad_code'); // bound to the requesting device
    h.advance(11 * 60_000);
    expect((await late.confirmTransfer(lic.key, code2)).body.code).toBe('bad_code'); // expired
    expect((await old.get('/v1/workspace')).status).toBe(200);
  });

  it('sends no email and reveals nothing for an unknown key', async () => {
    const d = new Device(h, 'native', 'X');
    expect((await d.requestTransfer('NXR-AAAAA-BBBBB-CCCCC-DDDDD')).status).toBe(204);
    expect(h.mails).toHaveLength(0);
  });
});

describe('expiry, revocation and renewal', () => {
  it('cuts an active device off the moment its license is revoked', async () => {
    const lic = await h.license();
    const d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    expect(await revokeLicense(h.ctx, lic.key)).toBe(true);
    expect((await d.get('/v1/workspace')).status).toBe(401);
    expect((await d.status()).body.license).toBeNull();
    expect((await d.activate(lic.key)).body.code).toBe('revoked');
  });

  it('cuts an active device off when the license expires, and restores it on renewal', async () => {
    const lic = await h.license();
    const d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    h.advance(31 * DAY);
    expect((await d.get('/v1/workspace')).status).toBe(401);
    expect((await d.activate(lic.key)).body.code).toBe('expired');
    await renewLicense(h.ctx, lic.key, 1);
    expect((await d.get('/v1/workspace')).status).toBe(200); // same seat, same session
  });
});

describe('offline entitlement token', () => {
  it('is signed by the server key, bound to the device and limited to the license period', async () => {
    const lic = await h.license();
    const d = new Device(h, 'native', 'PC');
    const r = await d.activate(lic.key);
    const { payload, body, sig } = decodeToken(r.body.entitlementToken);
    expect(payload).toEqual({
      license_id: lic.licenseId, device_id: d.info.id, plan: 'professional',
      issued_at: Date.parse('2026-11-23T09:00:00Z') / 1000, license_expires_at: Date.parse('2026-12-23T09:00:00Z') / 1000,
    });
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyBase64(TEST_SEED), 'base64')]);
    expect(verify(null, body, createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig)).toBe(true);
    expect(r.body.license.graceUntil).toBe('2026-11-30T09:00:00.000Z'); // 7 days
  });

  it('reissues a fresh token on each status check and never extends grace past expiry', async () => {
    const lic = await h.license();
    const d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    h.advance(27 * DAY);
    const st = await d.status();
    expect(decodeToken(st.body.entitlementToken).payload.issued_at).toBe(Date.parse('2026-12-20T09:00:00Z') / 1000);
    expect(st.body.license.graceUntil).toBe('2026-12-23T09:00:00.000Z'); // capped at license end, not +7 days
  });

  it('stops issuing tokens once the device is deactivated or the license revoked', async () => {
    const lic = await h.license();
    const d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    await revokeLicense(h.ctx, lic.key);
    const st = await d.status();
    expect(st.body).toEqual({ license: null, events: [] });
  });
});
