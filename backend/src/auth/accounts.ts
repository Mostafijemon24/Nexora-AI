// Accounts: signing in with email and password, two-step sign-in, password reset, team members
// with roles, invitations, and the workspaces of an account.
//
// A license still decides which devices may run the app (one seat per device). An account decides
// who is using a seat and what they may do. Signing in on a new device takes a free seat of the
// license that covers the person's workspace, so a teammate never needs the license key.

import { z } from 'zod';
import type { Invitation, Member, MfaSetup, Role, SignInFailure, WorkspaceRef } from '../../../src/lib/types.ts';
import type { Ctx } from '../context.ts';
import { decrypt, encrypt, hmac, newToken, newTransferCode, safeEqual } from '../crypto.ts';
import { tx, type Q } from '../db.ts';
import { badRequest, conflict, HttpError, notFound, tooMany } from '../errors.ts';
import {
  checkUsable, grant, LICENSE_SELECT, resolveDevice, seatFor, type ActivateResult, type Auth, type Client, type LicenseRow,
} from '../license/service.ts';
import { hashPassword, newRecoveryCodes, newTotpSecret, normalizeRecovery, passwordProblem, totpUri, totpVerify, verifyPassword } from './secrets.ts';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const INVITE_TTL_MS = 7 * 86_400_000;
const RESET_TTL_MS = 15 * 60_000;
const RESET_MAX_ATTEMPTS = 5;

export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);
/** Refuses unless the caller has at least this role in the session's workspace. */
export function need(auth: Auth, role: Role, what: string): void {
  if (RANK[auth.role] < RANK[role]) throw forbidden(`Only ${role === 'owner' ? 'the owner' : role === 'admin' ? 'an owner or admin' : 'a member'} can ${what}.`);
}
/** Refuses unless the license's plan includes the feature. */
export function needFeature(auth: Auth, feature: string, what: string, plan = 'Professional'): void {
  if (!auth.features.includes(feature)) throw new HttpError(402, 'not_included', `${what} is part of the ${plan} plan. Your current plan does not include it.`);
}

interface UserRow { id: string; email: string; name: string; workspace_id: string; password_hash: string | null; totp_enabled: boolean; totp_secret_enc: string | null; totp_last_step: number; recovery_hashes: string[] }
const USER = 'id, email, name, workspace_id, password_hash, totp_enabled, totp_secret_enc, totp_last_step, recovery_hashes';

/** Checks the second step: a code from the authenticator app, or a single-use recovery code. */
async function secondStep(ctx: Ctx, q: Q, u: UserRow, code: string): Promise<boolean> {
  if (!u.totp_secret_enc) return false;
  const step = totpVerify(decrypt(ctx.config.dataEncryptionKey, u.totp_secret_enc), code, ctx.now(), Number(u.totp_last_step));
  if (step !== null) {
    await q.query('UPDATE users SET totp_last_step = $2 WHERE id = $1', [u.id, step]);
    return true;
  }
  const given = normalizeRecovery(code);
  if (given.length !== 8) return false;
  const hash = hmac(ctx.config.hashSecret, `recovery:${u.id}:${given}`);
  const left = u.recovery_hashes.filter((h) => !safeEqual(h, hash));
  if (left.length === u.recovery_hashes.length) return false;
  await q.query('UPDATE users SET recovery_hashes = $2 WHERE id = $1', [u.id, JSON.stringify(left)]);
  return true;
}

/** The license that covers a workspace: the one issued for it, or one held by the account that owns it. */
async function licenseFor(q: Q, workspaceId: string, now: Date): Promise<LicenseRow | undefined> {
  return (await q.query(
    `${LICENSE_SELECT} WHERE l.status = 'active' AND l.expires_at > $2
       AND (l.workspace_id = $1 OR l.owner_user_id = (SELECT owner_user_id FROM workspaces WHERE id = $1))
     ORDER BY (l.workspace_id = $1) DESC, l.expires_at DESC LIMIT 1 FOR UPDATE OF l`, [workspaceId, now])).rows[0];
}

export type SignInOutcome = ActivateResult | ({ ok: false } & SignInFailure);

/**
 * Signs in with email and password (and the second step when the account uses one), giving this
 * device a seat on the license that covers the person's workspace. The same answer is given for
 * an unknown email and a wrong password.
 */
export async function signIn(ctx: Ctx, input: { email?: unknown; password?: unknown; code?: unknown; workspaceId?: unknown }, c: Client): Promise<SignInOutcome> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!(await ctx.limiter.allow(`signin:ip:${c.ip}`, 30, 600)) || !(await ctx.limiter.allow(`signin:acct:${hmac(ctx.config.hashSecret, `acct:${email}`)}`, 10, 600))) throw tooMany();
  const now = ctx.now();
  const user: UserRow | undefined = (await ctx.db.query(`SELECT ${USER} FROM users WHERE lower(email) = $1`, [email])).rows[0];
  // Hashing happens outside the transaction: it is deliberately slow.
  if (!(await verifyPassword(password, user?.password_hash ?? null)) || !user) return { ok: false, code: 'bad_credentials' };

  return tx(ctx.db, async (q) => {
    if (user.totp_enabled) {
      const code = typeof input.code === 'string' ? input.code.trim() : '';
      if (!code) return { ok: false, code: 'mfa_required' } as const;
      const fresh: UserRow = (await q.query(`SELECT ${USER} FROM users WHERE id = $1 FOR UPDATE`, [user.id])).rows[0];
      if (!(await secondStep(ctx, q, fresh, code))) return { ok: false, code: 'bad_code' } as const;
    }
    const memberships = (await q.query(
      'SELECT m.workspace_id FROM workspace_members m WHERE m.user_id = $1 ORDER BY (m.workspace_id = $2) DESC, (m.workspace_id = $3) DESC, m.created_at',
      [user.id, typeof input.workspaceId === 'string' && /^[0-9a-f-]{36}$/i.test(input.workspaceId) ? input.workspaceId : user.workspace_id, user.workspace_id])).rows;
    for (const m of memberships) {
      const lic = await licenseFor(q, m.workspace_id, now);
      if (!lic) continue;
      const device = await resolveDevice(ctx, q, c);
      const unusable = await checkUsable(q, lic, device.id, now);
      if (unusable) return unusable;
      const seat = await seatFor(q, lic, device, now);
      if ('ok' in seat) return seat;
      return grant(ctx, q, lic, device, seat.activationId, c, { userId: user.id, workspaceId: m.workspace_id });
    }
    return { ok: false, code: 'no_workspace' } as const;
  });
}

/** Ends the sign-in on this device. The seat stays with the device; the next person signs in again. */
export async function signOut(ctx: Ctx, auth: Auth): Promise<void> {
  await ctx.db.query('UPDATE sessions SET signed_in = false WHERE id = $1', [auth.sessionId]);
}

/**
 * Sets or changes the caller's password. Setting the owner's first password switches sign-in on
 * for the account: from then on a license key alone no longer opens the workspace.
 */
export async function setPassword(ctx: Ctx, auth: Auth, input: { current?: unknown; password?: unknown }): Promise<void> {
  const problem = passwordProblem(input.password);
  if (problem) throw badRequest(problem);
  const u: UserRow = (await ctx.db.query(`SELECT ${USER} FROM users WHERE id = $1`, [auth.userId])).rows[0];
  if (u.password_hash) {
    if (!(await ctx.limiter.allow(`pw:${auth.userId}`, 10, 600))) throw tooMany();
    if (!(await verifyPassword(typeof input.current === 'string' ? input.current : '', u.password_hash))) throw badRequest('Your current password is not correct.', 'bad_credentials');
  }
  const hash = await hashPassword(input.password as string);
  await tx(ctx.db, async (q) => {
    await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [auth.userId, hash]);
    // Every other device signed in as this person has to sign in again.
    await q.query('UPDATE sessions SET signed_in = false WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [auth.userId, auth.sessionId]);
  });
}

/** Emails a reset code when the address has an account. Always answers the same way. */
export async function forgotPassword(ctx: Ctx, rawEmail: unknown, ip: string): Promise<void> {
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!(await ctx.limiter.allow(`forgot:ip:${ip}`, 10, 900)) || !(await ctx.limiter.allow(`forgot:acct:${hmac(ctx.config.hashSecret, `acct:${email}`)}`, 3, 900))) throw tooMany();
  const u = (await ctx.db.query('SELECT id, email FROM users WHERE lower(email) = $1 AND password_hash IS NOT NULL', [email])).rows[0];
  if (!u) return;
  const code = newTransferCode();
  const now = ctx.now();
  await ctx.db.query('UPDATE auth_codes SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL', [u.id, now]);
  await ctx.db.query('INSERT INTO auth_codes (user_id, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)',
    [u.id, hmac(ctx.config.hashSecret, `reset:${u.id}:${code}`), new Date(now.getTime() + RESET_TTL_MS), now]);
  await ctx.mail({
    to: u.email, subject: 'Your Nexora AI password reset code',
    text: `Someone asked to reset the password of your Nexora AI account.\n\nReset code: ${code}\n\nIt expires in 15 minutes. If this was not you, ignore this email — your password stays as it is.`,
  });
}

/** Sets a new password with the emailed code, and signs the account out everywhere. */
export async function resetPassword(ctx: Ctx, input: { email?: unknown; code?: unknown; password?: unknown }, ip: string): Promise<void> {
  if (!(await ctx.limiter.allow(`reset:ip:${ip}`, 30, 900))) throw tooMany();
  const problem = passwordProblem(input.password);
  if (problem) throw badRequest(problem);
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const now = ctx.now();
  const bad = badRequest('That code is not correct or has expired. Ask for a new one.', 'bad_code');
  const u = (await ctx.db.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0];
  if (!u) throw bad;
  const hash = await hashPassword(input.password as string);
  const ok = await tx(ctx.db, async (q) => {
    const t = (await q.query('SELECT id, code_hash, attempts FROM auth_codes WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [u.id, now])).rows[0];
    const good = t && t.attempts < RESET_MAX_ATTEMPTS && safeEqual(t.code_hash, hmac(ctx.config.hashSecret, `reset:${u.id}:${code}`));
    if (!good) {
      if (t) await q.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1', [t.id]);
      return false;
    }
    await q.query('UPDATE auth_codes SET consumed_at = $2 WHERE id = $1', [t.id, now]);
    await q.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, hash]);
    await q.query('UPDATE sessions SET signed_in = false WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
    return true;
  });
  if (!ok) throw bad;
}

// ── two-step sign-in ─────────────────────────────────────────────────────

/** Starts setup: a new secret for the authenticator app. Nothing changes until a code from it is confirmed. */
export async function mfaSetup(ctx: Ctx, auth: Auth): Promise<MfaSetup> {
  const u: UserRow = (await ctx.db.query(`SELECT ${USER} FROM users WHERE id = $1`, [auth.userId])).rows[0];
  if (!u.password_hash) throw badRequest('Set a password first. Two-step sign-in adds a second step to it.');
  if (u.totp_enabled) throw badRequest('Two-step sign-in is already on.');
  const secret = newTotpSecret();
  await ctx.db.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1', [u.id, encrypt(ctx.config.dataEncryptionKey, secret)]);
  return { secret, uri: totpUri(secret, u.email) };
}

/** Confirms setup with a code from the app. Returns the recovery codes, which are shown this once. */
export async function mfaEnable(ctx: Ctx, auth: Auth, code: unknown): Promise<{ recoveryCodes: string[] }> {
  if (!(await ctx.limiter.allow(`mfa:${auth.userId}`, 10, 600))) throw tooMany();
  return tx(ctx.db, async (q) => {
    const u: UserRow = (await q.query(`SELECT ${USER} FROM users WHERE id = $1 FOR UPDATE`, [auth.userId])).rows[0];
    if (u.totp_enabled) throw badRequest('Two-step sign-in is already on.');
    if (!u.totp_secret_enc) throw badRequest('Start the setup first.');
    const step = totpVerify(decrypt(ctx.config.dataEncryptionKey, u.totp_secret_enc), typeof code === 'string' ? code : '', ctx.now(), 0);
    if (step === null) throw badRequest('That code is not correct. Check the time on your phone and try the next code.', 'bad_code');
    const recoveryCodes = newRecoveryCodes();
    await q.query('UPDATE users SET totp_enabled = true, totp_last_step = $2, recovery_hashes = $3 WHERE id = $1',
      [u.id, step, JSON.stringify(recoveryCodes.map((r) => hmac(ctx.config.hashSecret, `recovery:${u.id}:${normalizeRecovery(r)}`)))]);
    return { recoveryCodes };
  });
}

/** Switches two-step sign-in off. Needs the password and a current code (or a recovery code). */
export async function mfaDisable(ctx: Ctx, auth: Auth, input: { password?: unknown; code?: unknown }): Promise<void> {
  if (!(await ctx.limiter.allow(`mfa:${auth.userId}`, 10, 600))) throw tooMany();
  const u: UserRow = (await ctx.db.query(`SELECT ${USER} FROM users WHERE id = $1`, [auth.userId])).rows[0];
  if (!u.totp_enabled) return;
  if (!(await verifyPassword(typeof input.password === 'string' ? input.password : '', u.password_hash))) throw badRequest('Your password is not correct.', 'bad_credentials');
  await tx(ctx.db, async (q) => {
    const fresh: UserRow = (await q.query(`SELECT ${USER} FROM users WHERE id = $1 FOR UPDATE`, [u.id])).rows[0];
    if (!(await secondStep(ctx, q, fresh, typeof input.code === 'string' ? input.code : ''))) throw badRequest('That code is not correct.', 'bad_code');
    await q.query("UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = 0, recovery_hashes = '[]' WHERE id = $1", [u.id]);
    // A workspace cannot keep requiring a second step from someone who is its only way in.
    await q.query(`UPDATE workspaces SET mfa = false WHERE mfa AND id IN (SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND role = 'owner')`, [u.id]);
  });
}

// ── team ─────────────────────────────────────────────────────────────────

export async function loadTeam(q: Q, workspaceId: string, now: Date): Promise<{ members: Member[]; invitations: Invitation[] }> {
  const members = (await q.query(
    `SELECT u.id, u.name, u.email, m.role, u.totp_enabled, (u.password_hash IS NOT NULL) AS has_password
     FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1
     ORDER BY array_position(ARRAY['owner', 'admin', 'member', 'viewer'], m.role), m.created_at`, [workspaceId])).rows
    .map((r): Member => ({ id: r.id, name: r.name, email: r.email, role: r.role, mfa: r.totp_enabled, hasPassword: r.has_password }));
  const invitations = (await q.query('SELECT id, email, role, expires_at FROM invitations WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > $2 ORDER BY created_at', [workspaceId, now])).rows
    .map((r): Invitation => ({ id: r.id, email: r.email, role: r.role, expiresAt: new Date(r.expires_at).toISOString() }));
  return { members, invitations };
}

const InviteInput = z.object({ email: z.string().trim().toLowerCase().max(320).regex(EMAIL, 'Enter a valid email address.'), role: z.enum(['admin', 'member', 'viewer']) });

/** Invites someone to the workspace by email. The link in the message lets them choose a password and join. */
export async function invite(ctx: Ctx, auth: Auth, raw: unknown): Promise<Invitation> {
  need(auth, 'admin', 'invite people');
  needFeature(auth, 'team', 'Inviting team members', 'Business');
  const input = InviteInput.safeParse(raw);
  if (!input.success) throw badRequest(input.error.issues[0]?.message ?? 'Invalid invitation.');
  const { email, role } = input.data;
  if (!(await ctx.limiter.allow(`invite:${auth.workspaceId}`, 30, 3600))) throw tooMany('Too many invitations. Try again later.');
  const now = ctx.now();
  const member = await ctx.db.query('SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND lower(u.email) = $2', [auth.workspaceId, email]);
  if (member.rowCount) throw conflict('That person is already in this workspace.');
  const owner = (await ctx.db.query('SELECT 1 FROM users WHERE id = $1 AND password_hash IS NOT NULL', [(await ctx.db.query('SELECT owner_user_id FROM workspaces WHERE id = $1', [auth.workspaceId])).rows[0]?.owner_user_id])).rowCount;
  if (!owner) throw badRequest('Set a password for the owner’s account first (Settings → Security). Team members sign in with their own accounts.');
  const token = newToken();
  const expires = new Date(now.getTime() + INVITE_TTL_MS);
  const row = (await ctx.db.query(
    `INSERT INTO invitations (workspace_id, email, role, token_hash, invited_by, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, lower(email)) WHERE accepted_at IS NULL
     DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash, invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at
     RETURNING id`, [auth.workspaceId, email, role, hmac(ctx.config.hashSecret, `invite:${token}`), auth.userId, expires, now])).rows[0];
  const info = (await ctx.db.query('SELECT w.name AS workspace, u.name AS inviter FROM workspaces w, users u WHERE w.id = $1 AND u.id = $2', [auth.workspaceId, auth.userId])).rows[0];
  await ctx.mail({
    to: email, subject: `${info.inviter} invited you to ${info.workspace} on Nexora AI`,
    text: `${info.inviter} invited you to join the workspace “${info.workspace}” on Nexora AI as ${role === 'admin' ? 'an admin' : `a ${role}`}.\n\n`
      + `Open this link to choose a password and join:\n${ctx.config.appOrigins[0] ?? ''}/?invite=${token}\n\n`
      + 'In the desktop app, choose “I have an invitation” on the first screen and paste this code instead:\n' + `${token}\n\n`
      + 'The invitation expires in 7 days. If you did not expect it, ignore this email.',
  });
  return { id: row.id, email, role, expiresAt: expires.toISOString() };
}

export async function cancelInvitation(ctx: Ctx, auth: Auth, id: string): Promise<void> {
  need(auth, 'admin', 'cancel an invitation');
  await ctx.db.query('DELETE FROM invitations WHERE id::text = $1 AND workspace_id = $2 AND accepted_at IS NULL', [id, auth.workspaceId]);
}

/** Who an invitation is for, so the join screen can show it. Reveals nothing for an unknown or expired token. */
export async function invitationInfo(ctx: Ctx, token: string): Promise<{ email: string; workspace: string; role: Role; hasAccount: boolean }> {
  const r = (await ctx.db.query(
    `SELECT i.email, i.role, w.name, EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email) AND u.password_hash IS NOT NULL) AS has_account
     FROM invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > $2`,
    [hmac(ctx.config.hashSecret, `invite:${String(token).slice(0, 200)}`), ctx.now()])).rows[0];
  if (!r) throw notFound('This invitation is no longer valid. Ask for a new one.');
  return { email: r.email, workspace: r.name, role: r.role, hasAccount: r.has_account };
}

/**
 * Accepts an invitation: creates the account (or, for someone who already has one, checks their
 * password), adds them to the workspace and signs this device in, taking a seat of the license.
 */
export async function acceptInvitation(ctx: Ctx, input: { token?: unknown; name?: unknown; password?: unknown }, c: Client): Promise<SignInOutcome> {
  if (!(await ctx.limiter.allow(`accept:ip:${c.ip}`, 20, 600))) throw tooMany();
  const now = ctx.now();
  const password = typeof input.password === 'string' ? input.password : '';
  const tokenHash = hmac(ctx.config.hashSecret, `invite:${String(input.token ?? '').trim().slice(0, 200)}`);
  const peek = (await ctx.db.query('SELECT email FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2', [tokenHash, now])).rows[0];
  if (!peek) throw notFound('This invitation is no longer valid. Ask for a new one.');
  const existing: UserRow | undefined = (await ctx.db.query(`SELECT ${USER} FROM users WHERE lower(email) = lower($1)`, [peek.email])).rows[0];
  let hash: string | null = null;
  if (existing?.password_hash) {
    if (!(await verifyPassword(password, existing.password_hash))) return { ok: false, code: 'bad_credentials' };
  } else {
    const problem = passwordProblem(password);
    if (problem) throw badRequest(problem);
    hash = await hashPassword(password);
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : existing?.name ?? peek.email.split('@')[0];

  return tx(ctx.db, async (q) => {
    const inv = (await q.query('SELECT id, workspace_id, email, role FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2 FOR UPDATE', [tokenHash, now])).rows[0];
    if (!inv) throw notFound('This invitation is no longer valid. Ask for a new one.');
    const lic = await licenseFor(q, inv.workspace_id, now);
    if (!lic) throw badRequest('This workspace has no active license. Ask its owner.');
    const device = await resolveDevice(ctx, q, c);
    const seat = await seatFor(q, lic, device, now);
    if ('ok' in seat) return seat; // no free seat: the invitation stays open
    let userId = existing?.id;
    if (!userId) userId = (await q.query('INSERT INTO users (workspace_id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id', [inv.workspace_id, inv.email, name, hash, now])).rows[0].id as string;
    else if (hash) await q.query('UPDATE users SET password_hash = $2, name = $3 WHERE id = $1', [userId, hash, name]);
    await q.query('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role', [inv.workspace_id, userId, inv.role, now]);
    await q.query('UPDATE invitations SET accepted_at = $2 WHERE id = $1', [inv.id, now]);
    await q.query('INSERT INTO activity (id, workspace_id, text, at) VALUES (gen_random_uuid(), $1, $2, $3)', [inv.workspace_id, `${name} joined the workspace`, now]);
    return grant(ctx, q, lic, device, seat.activationId, c, { userId, workspaceId: inv.workspace_id });
  });
}

/** Changes a member's role. The owner's role cannot be changed, and only the owner can make or unmake an admin. */
export async function setRole(ctx: Ctx, auth: Auth, userId: string, role: unknown): Promise<void> {
  need(auth, 'admin', 'change roles');
  if (role !== 'admin' && role !== 'member' && role !== 'viewer') throw badRequest('Choose admin, member or viewer.');
  await tx(ctx.db, async (q) => {
    const m = (await q.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id::text = $2 FOR UPDATE', [auth.workspaceId, userId])).rows[0];
    if (!m) throw notFound('That person is not in this workspace.');
    if (m.role === 'owner') throw forbidden('The owner’s role cannot be changed.');
    if ((m.role === 'admin' || role === 'admin') && auth.role !== 'owner') throw forbidden('Only the owner can make someone an admin or change an admin.');
    await q.query('UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id::text = $2', [auth.workspaceId, userId, role]);
  });
}

/** Removes a member. Their devices are signed out of this workspace at once and give their seats back. */
export async function removeMember(ctx: Ctx, auth: Auth, userId: string): Promise<void> {
  need(auth, 'admin', 'remove people');
  const now = ctx.now();
  await tx(ctx.db, async (q) => {
    const m = (await q.query('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id::text = $2 FOR UPDATE', [auth.workspaceId, userId])).rows[0];
    if (!m) return;
    if (m.role === 'owner') throw forbidden('The owner cannot be removed.');
    if (m.role === 'admin' && auth.role !== 'owner') throw forbidden('Only the owner can remove an admin.');
    await q.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id::text = $2', [auth.workspaceId, userId]);
    const gone = await q.query('UPDATE sessions SET revoked_at = $3 WHERE workspace_id = $1 AND user_id::text = $2 AND revoked_at IS NULL RETURNING activation_id', [auth.workspaceId, userId, now]);
    await q.query("UPDATE license_activations SET deactivated_at = $2, deactivation_reason = 'admin' WHERE id = ANY($1) AND deactivated_at IS NULL", [gone.rows.map((r) => r.activation_id), now]);
  });
}

// ── workspaces ───────────────────────────────────────────────────────────

/** The workspaces of this license's account that the caller belongs to. */
export async function listWorkspaces(q: Q, auth: Auth): Promise<WorkspaceRef[]> {
  return (await q.query(
    `SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
     WHERE w.owner_user_id = (SELECT owner_user_id FROM licenses WHERE id = $2) ORDER BY w.created_at`, [auth.userId, auth.licenseId])).rows
    .map((r): WorkspaceRef => ({ id: r.id, name: r.name, role: r.role, current: r.id === auth.workspaceId }));
}

export async function createWorkspace(ctx: Ctx, auth: Auth, rawName: unknown): Promise<WorkspaceRef> {
  need(auth, 'owner', 'add a workspace');
  needFeature(auth, 'workspaces', 'Having several workspaces', 'Business');
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 200) : '';
  if (!name) throw badRequest('Give the workspace a name.');
  const now = ctx.now();
  return tx(ctx.db, async (q) => {
    const owner = (await q.query('SELECT owner_user_id FROM licenses WHERE id = $1', [auth.licenseId])).rows[0].owner_user_id;
    if (owner !== auth.userId) throw forbidden('Only the license owner can add a workspace.');
    const count = (await q.query('SELECT count(*)::int AS n FROM workspaces WHERE owner_user_id = $1', [owner])).rows[0].n;
    if (count >= 25) throw badRequest('An account can have at most 25 workspaces.');
    const w = (await q.query('INSERT INTO workspaces (name, owner_user_id, created_at) VALUES ($1, $2, $3) RETURNING id', [name, owner, now])).rows[0];
    await q.query("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)", [w.id, owner, now]);
    return { id: w.id, name, role: 'owner', current: false };
  });
}

/** Points this session at another workspace of the same account that the caller belongs to. */
export async function switchWorkspace(ctx: Ctx, auth: Auth, workspaceId: unknown): Promise<void> {
  const all = await listWorkspaces(ctx.db, auth);
  const target = all.find((w) => w.id === workspaceId);
  if (!target) throw notFound('That workspace is not available to you.');
  await ctx.db.query('UPDATE sessions SET workspace_id = $2 WHERE id = $1', [auth.sessionId, target.id]);
}
