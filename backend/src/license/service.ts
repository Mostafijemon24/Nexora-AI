// The license server. This module is the only authority on whether a device may run the app:
// keys are checked here, seats are allocated here inside a transaction, and the database's
// partial unique indexes back that up. Nothing the client stores or sends is trusted on its own.

import type { ActivationFailure, DeviceInfo, LicenseEvent, LicenseState } from '../../../src/lib/types.ts';
import { fullDate, shortDate, type Ctx } from '../context.ts';
import { hmac, newLicenseKey, newToken, newTransferCode, normalizeKey, safeEqual, signEntitlement } from '../crypto.ts';
import { tx, type Q } from '../db.ts';
import { badRequest, tooMany } from '../errors.ts';
import { transferCodeMail } from '../mail.ts';

export const GRACE_PERIOD_MS = 7 * 86_400_000;
const TRANSFER_TTL_MS = 10 * 60_000;
const TRANSFER_MAX_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who is calling, as far as the server can establish it. */
export interface Client {
  device: DeviceInfo;
  userAgent: string;
  ip: string;
  /** Web: the server-issued device cookie. */
  webDeviceId?: string;
  /** Session cookie (web) or bearer token (native). */
  sessionToken?: string;
}

export interface Auth {
  sessionId: string;
  workspaceId: string;
  userId: string;
  deviceId: string;
  activationId: string;
  licenseId: string;
  native: boolean;
}

export interface Granted {
  ok: true;
  license: LicenseState;
  /** Native only; empty for web, which revalidates with the server every session. */
  entitlementToken: string;
  /** Raw session token. Sent to native clients in the body and to browsers as an httpOnly cookie. */
  sessionToken: string;
  deviceId: string;
  native: boolean;
}
export type ActivateResult = Granted | ({ ok: false } & ActivationFailure);
export type ConfirmResult = ActivateResult | { ok: false; code: 'bad_code' };

interface LicenseRow {
  id: string; workspace_id: string; owner_user_id: string; key_last4: string; status: string; expires_at: Date;
  plan_code: string; plan_name: string; price_cents: number; period: string; plan_max_devices: number;
}
interface DeviceRow { id: string; kind: 'web' | 'native'; client_ref: string | null; name: string; os: string; ua_hash: string | null }

const isNative = (d: DeviceInfo) => d.platform !== 'web';
const label = (d: { name: string; os: string }) => `${d.name} · ${d.os}`;
const clean = (s: unknown, max: number, fallback: string) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : fallback);

const LICENSE_SELECT = `
  SELECT l.id, l.workspace_id, l.owner_user_id, l.key_last4, l.status, l.expires_at,
         p.code AS plan_code, p.name AS plan_name, p.price_cents, p.period, p.max_devices AS plan_max_devices
  FROM licenses l JOIN subscriptions s ON s.id = l.subscription_id JOIN subscription_plans p ON p.id = s.plan_id`;

async function logEvent(q: Q, type: string, detail: string, licenseId: string | null, deviceId: string | null, at: Date) {
  await q.query('INSERT INTO license_events (license_id, device_id, type, detail, created_at) VALUES ($1, $2, $3, $4, $5)', [licenseId, deviceId, type, detail, at]);
}

/** Seats allowed: a per-license entitlement override, else the plan default (1). */
async function maxDevices(q: Q, lic: LicenseRow): Promise<number> {
  const r = await q.query("SELECT value FROM license_entitlements WHERE license_id = $1 AND feature = 'max_devices'", [lic.id]);
  const v = r.rows[0]?.value;
  return Number.isInteger(v) && v >= 1 ? v : lic.plan_max_devices;
}

/**
 * Finds or registers the calling device.
 * Native installs are known by their registration id. A browser is known by a device cookie this
 * server issued, bound to a hash of its user agent — so every tab of one browser is one device,
 * and the cookie alone does not move to another browser.
 */
async function resolveDevice(ctx: Ctx, q: Q, c: Client): Promise<DeviceRow> {
  const name = clean(c.device.name, 80, 'Unknown device');
  const os = clean(c.device.os, 80, 'Unknown');
  if (isNative(c.device)) {
    const ref = typeof c.device.id === 'string' ? c.device.id.trim() : '';
    if (ref.length < 16 || ref.length > 128) throw badRequest('This device has no valid registration id.');
    const r = await q.query(
      `INSERT INTO license_devices (kind, client_ref, platform, name, os) VALUES ('native', $1, $2, $3, $4)
       ON CONFLICT (client_ref) WHERE client_ref IS NOT NULL
       DO UPDATE SET platform = EXCLUDED.platform, name = EXCLUDED.name, os = EXCLUDED.os, last_seen_at = now()
       RETURNING id, kind, client_ref, name, os, ua_hash`,
      [ref, clean(c.device.platform, 20, 'unknown'), name, os]);
    return r.rows[0];
  }
  const uaHash = hmac(ctx.config.hashSecret, `ua:${c.userAgent}`);
  if (c.webDeviceId && UUID.test(c.webDeviceId)) {
    const r = await q.query(
      `UPDATE license_devices SET name = $3, last_seen_at = now() WHERE id = $1 AND kind = 'web' AND ua_hash = $2
       RETURNING id, kind, client_ref, name, os, ua_hash`, [c.webDeviceId, uaHash, name]);
    if (r.rows[0]) return r.rows[0];
  }
  const r = await q.query(
    `INSERT INTO license_devices (kind, platform, name, os, ua_hash) VALUES ('web', 'web', $1, $2, $3)
     RETURNING id, kind, client_ref, name, os, ua_hash`, [name, os, uaHash]);
  return r.rows[0];
}

async function licenseState(ctx: Ctx, q: Q, lic: LicenseRow, activationId: string): Promise<{ state: LicenseState; device: DeviceRow }> {
  const a = await q.query(
    `SELECT a.activated_at, d.id, d.kind, d.client_ref, d.name, d.os, d.ua_hash
     FROM license_activations a JOIN license_devices d ON d.id = a.device_id WHERE a.id = $1`, [activationId]);
  const row = a.rows[0];
  const active = await q.query('SELECT count(*)::int AS n FROM license_activations WHERE license_id = $1 AND deactivated_at IS NULL', [lic.id]);
  const native = row.kind === 'native';
  const grace = new Date(Math.min(ctx.now().getTime() + GRACE_PERIOD_MS, lic.expires_at.getTime()));
  return {
    device: row,
    state: {
      keyMasked: `NXR-••••-${lic.key_last4}`,
      plan: lic.plan_name,
      priceLabel: `$${(lic.price_cents / 100).toFixed(lic.price_cents % 100 ? 2 : 0)} / ${lic.period}`,
      renewsOn: fullDate(lic.expires_at),
      deviceName: row.name,
      deviceOs: row.os,
      activatedAt: shortDate(row.activated_at),
      activeDevices: active.rows[0].n,
      maxDevices: await maxDevices(q, lic),
      graceUntil: native ? grace.toISOString() : undefined,
    },
  };
}

function entitlementFor(ctx: Ctx, lic: LicenseRow, device: DeviceRow): string {
  if (device.kind !== 'native' || !device.client_ref) return '';
  return signEntitlement(ctx.config.licenseSigningKey, {
    license_id: lic.id,
    device_id: device.client_ref,
    plan: lic.plan_code,
    issued_at: Math.floor(ctx.now().getTime() / 1000),
    license_expires_at: Math.floor(lic.expires_at.getTime() / 1000),
  });
}

async function openSession(ctx: Ctx, q: Q, lic: LicenseRow, deviceId: string, activationId: string): Promise<string> {
  const token = newToken();
  await q.query(
    'INSERT INTO sessions (workspace_id, user_id, device_id, activation_id, token_hash, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $6)',
    [lic.workspace_id, lic.owner_user_id, deviceId, activationId, hmac(ctx.config.hashSecret, `session:${token}`), ctx.now()]);
  return token;
}

async function grant(ctx: Ctx, q: Q, lic: LicenseRow, device: DeviceRow, activationId: string): Promise<Granted> {
  const { state } = await licenseState(ctx, q, lic, activationId);
  return {
    ok: true, license: state, entitlementToken: entitlementFor(ctx, lic, device),
    sessionToken: await openSession(ctx, q, lic, device.id, activationId), deviceId: device.id, native: device.kind === 'native',
  };
}

/** Lowest free seat number. The caller holds the license row lock. */
async function freeSlot(q: Q, licenseId: string, max: number): Promise<number | null> {
  const r = await q.query('SELECT slot FROM license_activations WHERE license_id = $1 AND deactivated_at IS NULL', [licenseId]);
  const used = new Set(r.rows.map((x) => x.slot as number));
  for (let s = 0; s < max; s++) if (!used.has(s)) return s;
  return null;
}

/** The session behind a token, if it is still backed by an active license on its device. */
export async function authenticate(ctx: Ctx, c: Pick<Client, 'sessionToken' | 'webDeviceId' | 'userAgent'>): Promise<Auth | null> {
  if (!c.sessionToken) return null;
  const now = ctx.now();
  const r = await ctx.db.query(
    `SELECT s.id AS session_id, s.workspace_id, s.user_id, s.device_id, s.activation_id, s.last_seen_at,
            a.license_id, d.kind, d.ua_hash
     FROM sessions s
     JOIN license_activations a ON a.id = s.activation_id
     JOIN licenses l ON l.id = a.license_id
     JOIN license_devices d ON d.id = s.device_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND a.deactivated_at IS NULL
       AND l.status = 'active' AND l.expires_at > $2`,
    [hmac(ctx.config.hashSecret, `session:${c.sessionToken}`), now]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.kind === 'web') {
    // The session cookie only counts together with this browser's own device cookie.
    if (c.webDeviceId !== row.device_id) return null;
    if (!safeEqual(row.ua_hash ?? '', hmac(ctx.config.hashSecret, `ua:${c.userAgent}`))) return null;
  }
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 60_000) {
    await ctx.db.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [row.session_id, now]);
  }
  return {
    sessionId: row.session_id, workspaceId: row.workspace_id, userId: row.user_id, deviceId: row.device_id,
    activationId: row.activation_id, licenseId: row.license_id, native: row.kind === 'native',
  };
}

export async function recentEvents(q: Q, licenseId: string): Promise<LicenseEvent[]> {
  const r = await q.query('SELECT detail, created_at FROM license_events WHERE license_id = $1 ORDER BY seq DESC LIMIT 6', [licenseId]);
  return r.rows.map((e) => ({ text: e.detail, at: new Date(e.created_at).toISOString() }));
}

/** What this device currently holds. Also refreshes the native entitlement token and its grace period. */
export async function status(ctx: Ctx, c: Client): Promise<{ license: LicenseState | null; entitlementToken?: string; events: LicenseEvent[] }> {
  const auth = await authenticate(ctx, c);
  if (!auth) return { license: null, events: [] };
  const lic: LicenseRow = (await ctx.db.query(`${LICENSE_SELECT} WHERE l.id = $1`, [auth.licenseId])).rows[0];
  await ctx.db.query('UPDATE license_activations SET last_validated_at = $2 WHERE id = $1', [auth.activationId, ctx.now()]);
  const { state, device } = await licenseState(ctx, ctx.db, lic, auth.activationId);
  return { license: state, entitlementToken: entitlementFor(ctx, lic, device) || undefined, events: await recentEvents(ctx.db, lic.id) };
}

async function checkUsable(q: Q, lic: LicenseRow, deviceId: string | null, now: Date): Promise<({ ok: false } & ActivationFailure) | null> {
  if (lic.status === 'revoked') {
    await logEvent(q, 'activation_failed', 'Failed activation: License revoked', lic.id, deviceId, now);
    return { ok: false, code: 'revoked' };
  }
  if (lic.expires_at.getTime() <= now.getTime()) {
    await logEvent(q, 'activation_failed', 'Failed activation: License expired', lic.id, deviceId, now);
    return { ok: false, code: 'expired', expiredOn: fullDate(lic.expires_at) };
  }
  return null;
}

export async function activate(ctx: Ctx, rawKey: string, c: Client): Promise<ActivateResult> {
  const key = normalizeKey(String(rawKey ?? ''));
  const keyHash = hmac(ctx.config.hashSecret, `license:${key}`);
  if (!(await ctx.limiter.allow(`act:ip:${c.ip}`, 20, 600)) || !(await ctx.limiter.allow(`act:key:${keyHash}`, 20, 600))) throw tooMany();
  const now = ctx.now();
  const auth = await authenticate(ctx, c);

  return tx(ctx.db, async (q) => {
    // Lock the license row: every activation, transfer and deactivation of one license runs in turn.
    const lic: LicenseRow | undefined = (await q.query(`${LICENSE_SELECT} WHERE l.key_hash = $1 FOR UPDATE OF l`, [keyHash])).rows[0];
    if (!lic) {
      await logEvent(q, 'activation_failed', 'Failed activation: Invalid license key', null, null, now);
      return { ok: false, code: 'invalid' } as const;
    }
    const device = await resolveDevice(ctx, q, c);
    const unusable = await checkUsable(q, lic, device.id, now);
    if (unusable) return unusable;

    const active = await q.query(
      `SELECT a.id, a.device_id, a.activated_at, d.name, d.os FROM license_activations a JOIN license_devices d ON d.id = a.device_id
       WHERE a.license_id = $1 AND a.deactivated_at IS NULL ORDER BY a.activated_at`, [lic.id]);
    const mine = active.rows.find((a) => a.device_id === device.id);
    // Already active here — but only a caller holding this activation's session is believed to be
    // this device. A device id on its own (it comes from the client) proves nothing.
    if (mine && auth?.activationId === mine.id) return grant(ctx, q, lic, device, mine.id);

    const slot = mine ? null : await freeSlot(q, lic.id, await maxDevices(q, lic));
    if (slot === null) {
      const other = active.rows[0];
      await logEvent(q, 'activation_failed', 'Failed activation: Already active on another device', lic.id, device.id, now);
      return { ok: false, code: 'in_use', deviceName: other.name, deviceOs: other.os, activatedAt: shortDate(other.activated_at) } as const;
    }
    const a = await q.query(
      'INSERT INTO license_activations (license_id, device_id, slot, activated_at, last_validated_at) VALUES ($1, $2, $3, $4, $4) RETURNING id',
      [lic.id, device.id, slot, now]);
    await logEvent(q, 'activated', `Activated on ${label(device)}`, lic.id, device.id, now);
    return grant(ctx, q, lic, device, a.rows[0].id);
  });
}

/**
 * Starts a transfer: emails a 6-digit code to the license owner. Returns the device id so a browser
 * can be given its device cookie. Reveals nothing about whether the key exists.
 */
export async function requestTransfer(ctx: Ctx, rawKey: string, c: Client): Promise<{ deviceId: string | null; native: boolean }> {
  const keyHash = hmac(ctx.config.hashSecret, `license:${normalizeKey(String(rawKey ?? ''))}`);
  if (!(await ctx.limiter.allow(`xfer:ip:${c.ip}`, 10, 900)) || !(await ctx.limiter.allow(`xfer:key:${keyHash}`, 3, 900))) throw tooMany();
  const now = ctx.now();
  const out = await tx(ctx.db, async (q) => {
    const lic: LicenseRow | undefined = (await q.query(`${LICENSE_SELECT} WHERE l.key_hash = $1 FOR UPDATE OF l`, [keyHash])).rows[0];
    const device = await resolveDevice(ctx, q, c);
    if (!lic || lic.status !== 'active' || lic.expires_at.getTime() <= now.getTime()) return { device, mail: null };
    const code = newTransferCode();
    await q.query('UPDATE license_transfers SET consumed_at = $3 WHERE license_id = $1 AND device_id = $2 AND consumed_at IS NULL', [lic.id, device.id, now]);
    await q.query('INSERT INTO license_transfers (license_id, device_id, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      [lic.id, device.id, hmac(ctx.config.hashSecret, `transfer:${lic.id}:${code}`), new Date(now.getTime() + TRANSFER_TTL_MS), now]);
    await logEvent(q, 'transfer_requested', `Transfer requested from ${label(device)}`, lic.id, device.id, now);
    const owner = await q.query('SELECT email FROM users WHERE id = $1', [lic.owner_user_id]);
    return { device, mail: transferCodeMail(owner.rows[0].email, code, device.name) };
  });
  if (out.mail) await ctx.mail(out.mail);
  return { deviceId: out.device.id, native: out.device.kind === 'native' };
}

export async function confirmTransfer(ctx: Ctx, rawKey: string, code: string, c: Client): Promise<ConfirmResult> {
  const keyHash = hmac(ctx.config.hashSecret, `license:${normalizeKey(String(rawKey ?? ''))}`);
  if (!(await ctx.limiter.allow(`xferc:ip:${c.ip}`, 30, 900))) throw tooMany();
  const now = ctx.now();
  return tx(ctx.db, async (q) => {
    const lic: LicenseRow | undefined = (await q.query(`${LICENSE_SELECT} WHERE l.key_hash = $1 FOR UPDATE OF l`, [keyHash])).rows[0];
    if (!lic) return { ok: false, code: 'bad_code' } as const;
    const device = await resolveDevice(ctx, q, c);
    const unusable = await checkUsable(q, lic, device.id, now);
    if (unusable) return unusable;

    const t = (await q.query(
      `SELECT id, code_hash, attempts FROM license_transfers
       WHERE license_id = $1 AND device_id = $2 AND consumed_at IS NULL AND expires_at > $3
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [lic.id, device.id, now])).rows[0];
    const good = t && t.attempts < TRANSFER_MAX_ATTEMPTS
      && safeEqual(t.code_hash, hmac(ctx.config.hashSecret, `transfer:${lic.id}:${String(code ?? '').trim()}`));
    if (!good) {
      // A wrong guess is counted and committed; after five the code is dead.
      if (t) await q.query('UPDATE license_transfers SET attempts = attempts + 1 WHERE id = $1', [t.id]);
      await logEvent(q, 'transfer_failed', `Failed transfer to ${label(device)}: wrong or expired code`, lic.id, device.id, now);
      return { ok: false, code: 'bad_code' } as const;
    }
    await q.query('UPDATE license_transfers SET consumed_at = $2 WHERE id = $1', [t.id, now]);

    const old = await q.query(
      `UPDATE license_activations a SET deactivated_at = $2, deactivation_reason = 'transferred'
       FROM license_devices d WHERE d.id = a.device_id AND a.license_id = $1 AND a.deactivated_at IS NULL
       RETURNING a.id, d.name, d.os`, [lic.id, now]);
    await q.query('UPDATE sessions SET revoked_at = $2 WHERE activation_id = ANY($1) AND revoked_at IS NULL', [old.rows.map((r) => r.id), now]);
    const a = await q.query(
      'INSERT INTO license_activations (license_id, device_id, slot, activated_at, last_validated_at) VALUES ($1, $2, 0, $3, $3) RETURNING id',
      [lic.id, device.id, now]);
    const from = old.rows.map((r) => r.name).join(', ') || 'no device';
    await logEvent(q, 'transferred', `Transferred from ${from} to ${label(device)}`, lic.id, device.id, now);
    return grant(ctx, q, lic, device, a.rows[0].id);
  });
}

/** Releases this device's seat. The app locks here immediately; the seat is free for one other device. */
export async function deactivate(ctx: Ctx, auth: Auth): Promise<void> {
  const now = ctx.now();
  await tx(ctx.db, async (q) => {
    await q.query('SELECT id FROM licenses WHERE id = $1 FOR UPDATE', [auth.licenseId]);
    const r = await q.query(
      `UPDATE license_activations a SET deactivated_at = $2, deactivation_reason = 'user'
       FROM license_devices d WHERE d.id = a.device_id AND a.id = $1 AND a.deactivated_at IS NULL RETURNING d.name, d.os`, [auth.activationId, now]);
    if (!r.rows[0]) return;
    await q.query('UPDATE sessions SET revoked_at = $2 WHERE activation_id = $1 AND revoked_at IS NULL', [auth.activationId, now]);
    await logEvent(q, 'deactivated', `Deactivated on ${label(r.rows[0])}`, auth.licenseId, auth.deviceId, now);
  });
}

// ── administration (CLI / billing webhooks) ──────────────────────────────
export interface NewLicense { email: string; name: string; workspace: string; plan: string; months: number; maxDevices?: number }

/** Creates the owner's workspace if needed, a subscription, and a license. Returns the key — shown once, never stored. */
export async function createLicense(ctx: Ctx, input: NewLicense): Promise<{ key: string; licenseId: string; workspaceId: string }> {
  const now = ctx.now();
  return tx(ctx.db, async (q) => {
    const plan = (await q.query('SELECT id FROM subscription_plans WHERE code = $1', [input.plan])).rows[0];
    if (!plan) throw badRequest(`Unknown plan "${input.plan}".`);
    let user = (await q.query('SELECT id, workspace_id FROM users WHERE lower(email) = lower($1)', [input.email])).rows[0];
    if (!user) {
      const ws = await q.query('INSERT INTO workspaces (name) VALUES ($1) RETURNING id', [input.workspace]);
      user = (await q.query('INSERT INTO users (workspace_id, email, name) VALUES ($1, $2, $3) RETURNING id, workspace_id', [ws.rows[0].id, input.email, input.name])).rows[0];
    }
    const end = new Date(now);
    end.setUTCMonth(end.getUTCMonth() + input.months);
    const sub = await q.query('INSERT INTO subscriptions (workspace_id, plan_id, current_period_end) VALUES ($1, $2, $3) RETURNING id', [user.workspace_id, plan.id, end]);
    const key = newLicenseKey();
    const lic = await q.query(
      'INSERT INTO licenses (workspace_id, subscription_id, owner_user_id, key_hash, key_last4, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [user.workspace_id, sub.rows[0].id, user.id, hmac(ctx.config.hashSecret, `license:${key}`), key.slice(-4), end]);
    if (input.maxDevices && input.maxDevices > 1) {
      await q.query("INSERT INTO license_entitlements (license_id, feature, value) VALUES ($1, 'max_devices', $2)", [lic.rows[0].id, JSON.stringify(input.maxDevices)]);
    }
    await logEvent(q, 'created', 'License issued', lic.rows[0].id, null, now);
    return { key, licenseId: lic.rows[0].id, workspaceId: user.workspace_id };
  });
}

/** Revokes a license: every device is deactivated and every session ended, effective on the next request. */
export async function revokeLicense(ctx: Ctx, rawKey: string): Promise<boolean> {
  const now = ctx.now();
  return tx(ctx.db, async (q) => {
    const lic = (await q.query("UPDATE licenses SET status = 'revoked', revoked_at = $2 WHERE key_hash = $1 AND status = 'active' RETURNING id",
      [hmac(ctx.config.hashSecret, `license:${normalizeKey(rawKey)}`), now])).rows[0];
    if (!lic) return false;
    const acts = await q.query("UPDATE license_activations SET deactivated_at = $2, deactivation_reason = 'revoked' WHERE license_id = $1 AND deactivated_at IS NULL RETURNING id", [lic.id, now]);
    await q.query('UPDATE sessions SET revoked_at = $2 WHERE activation_id = ANY($1) AND revoked_at IS NULL', [acts.rows.map((r) => r.id), now]);
    await logEvent(q, 'revoked', 'License revoked', lic.id, null, now);
    return true;
  });
}

/** Extends a license (and its subscription period) from the later of now and its current end. */
export async function renewLicense(ctx: Ctx, rawKey: string, months: number): Promise<Date | null> {
  const now = ctx.now();
  return tx(ctx.db, async (q) => {
    const lic = (await q.query('SELECT id, subscription_id, expires_at FROM licenses WHERE key_hash = $1 FOR UPDATE',
      [hmac(ctx.config.hashSecret, `license:${normalizeKey(rawKey)}`)])).rows[0];
    if (!lic) return null;
    const end = new Date(Math.max(now.getTime(), new Date(lic.expires_at).getTime()));
    end.setUTCMonth(end.getUTCMonth() + months);
    await q.query('UPDATE licenses SET expires_at = $2 WHERE id = $1', [lic.id, end]);
    await q.query("UPDATE subscriptions SET current_period_end = $2, status = 'active' WHERE id = $1", [lic.subscription_id, end]);
    await logEvent(q, 'renewed', `Renewed until ${fullDate(end)}`, lic.id, null, now);
    return end;
  });
}
