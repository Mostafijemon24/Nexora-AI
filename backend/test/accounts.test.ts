import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newLead } from '../../src/lib/types.ts';
import { makeStep } from '../../src/lib/workflow.ts';
import { base32, fromBase32, hashPassword, passwordProblem, totpAt, totpVerify, verifyPassword } from '../src/auth/secrets.ts';
import { change, Device, harness, type Harness } from './helpers.ts';

let h: Harness;
const PW = 'correct horse battery';
const push = (d: Device, c: unknown) => d.post('/v1/workspace/changes', c);
const snap = async (d: Device) => (await d.get('/v1/workspace')).body;
const signIn = async (d: Device, email: string, password: string, extra: object = {}) => {
  const r = await d.post('/v1/auth/sign-in', { email, password, device: d.info, ...extra });
  if (r.body?.sessionToken) d.token = r.body.sessionToken;
  return r;
};
const codeNow = (secret: string, offset = 0) => totpAt(secret, Math.floor(h.ctx.now().getTime() / 30_000) + offset);
const inviteToken = () => /\?invite=([\w-]+)/.exec(h.mails.at(-1)!.text)![1];
const accept = async (d: Device, token: string, name: string, password: string) => {
  const r = await d.post('/v1/auth/invite/accept', { token, name, password, device: d.info });
  if (r.body?.sessionToken) d.token = r.body.sessionToken;
  return r;
};

beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h.close(); });
beforeEach(() => { h.mails.length = 0; h.advance(60_000); });

describe('passwords and one-time codes', () => {
  it('hashes with a fresh salt, verifies, and rejects weak passwords', async () => {
    const a = await hashPassword(PW);
    expect(a).not.toBe(await hashPassword(PW));
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword(PW, a)).toBe(true);
    expect(await verifyPassword('correct horse batterx', a)).toBe(false);
    expect(await verifyPassword(PW, null)).toBe(false);
    expect(passwordProblem('short')).toMatch(/at least 10/);
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch(/harder to guess/);
    expect(passwordProblem(PW)).toBeNull();
  });

  it('produces the RFC 6238 test vectors and refuses a code twice', () => {
    // RFC 6238 appendix B, SHA-1, secret "12345678901234567890" (the 8-digit values there end in these 6 digits).
    const secret = base32(Buffer.from('12345678901234567890'));
    expect(fromBase32(secret).toString()).toBe('12345678901234567890');
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpAt(secret, Math.floor(1234567890 / 30))).toBe('005924');
    const at = new Date(1111111109 * 1000);
    const step = totpVerify(secret, '081804', at, 0);
    expect(step).toBe(Math.floor(1111111109 / 30));
    expect(totpVerify(secret, '081804', at, step!)).toBeNull(); // the same code again
    expect(totpVerify(secret, '081 804', new Date(at.getTime() + 30_000), 0)).toBe(step); // one step of clock drift
    expect(totpVerify(secret, '081804', new Date(at.getTime() + 120_000), 0)).toBeNull();
    expect(totpVerify(secret, 'abcdef', at, 0)).toBeNull();
  });
});

describe('sign-in', () => {
  it('a license key alone opens the workspace until the owner sets a password; then members sign in', async () => {
    const lic = await h.license({ email: 'owner@acme.example', maxDevices: 3 });
    const pc = new Device(h, 'native', 'OWNER-PC');
    expect((await pc.activate(lic.key)).body.signInRequired).toBeUndefined();
    expect((await snap(pc)).me).toMatchObject({ role: 'owner', hasPassword: false });

    expect((await pc.post('/v1/auth/password', { password: 'short' })).body.message).toMatch(/at least 10/);
    expect((await pc.post('/v1/auth/password', { password: PW })).status).toBe(204);
    expect((await snap(pc)).me.hasPassword).toBe(true); // the device that set it stays signed in

    // A second device with only the key gets a seat, but not the workspace.
    const laptop = new Device(h, 'native', 'LAPTOP');
    const act = await laptop.activate(lic.key);
    expect(act.body).toMatchObject({ ok: true, signInRequired: true });
    const blocked = await laptop.get('/v1/workspace');
    expect([blocked.status, blocked.body.code]).toEqual([401, 'sign_in_required']);
    expect((await push(laptop, change('task', randomUUID(), {}))).status).toBe(401);

    expect((await signIn(laptop, 'owner@acme.example', 'wrong password!')).body).toEqual({ ok: false, code: 'bad_credentials' });
    expect((await signIn(laptop, 'nobody@acme.example', PW)).body).toEqual({ ok: false, code: 'bad_credentials' });
    expect((await signIn(laptop, 'OWNER@acme.example', PW)).body.ok).toBe(true);
    expect((await snap(laptop)).me).toMatchObject({ email: 'owner@acme.example', role: 'owner' });
    expect((await h.ctx.db.query('SELECT count(*)::int AS n FROM license_activations WHERE license_id = $1 AND deactivated_at IS NULL', [lic.licenseId])).rows[0].n).toBe(2);

    // Signing in on a new device needs no key: it takes a free seat. With none left, it says so.
    const phone = new Device(h, 'web', 'Phone');
    expect((await signIn(phone, 'owner@acme.example', PW)).body.ok).toBe(true);
    expect((await snap(phone)).sessions).toHaveLength(3);
    const fourth = new Device(h, 'native', 'FOURTH');
    expect((await signIn(fourth, 'owner@acme.example', PW)).body).toMatchObject({ ok: false, code: 'in_use', devices: expect.any(Array) });

    // Signing out keeps the seat and closes the workspace on that device.
    expect((await phone.post('/v1/auth/sign-out')).status).toBe(204);
    expect((await phone.get('/v1/workspace')).body.code).toBe('sign_in_required');
    expect((await signIn(phone, 'owner@acme.example', PW)).body.ok).toBe(true);

    // Changing the password needs the current one, and signs the other devices out.
    expect((await pc.post('/v1/auth/password', { current: 'nope', password: 'another long password' })).body.code).toBe('bad_credentials');
    expect((await pc.post('/v1/auth/password', { current: PW, password: 'another long password' })).status).toBe(204);
    expect((await laptop.get('/v1/workspace')).body.code).toBe('sign_in_required');
    expect((await pc.get('/v1/workspace')).status).toBe(200);
  });

  it('limits guesses per account', async () => {
    const lic = await h.license({ email: 'target@acme.example' });
    const d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    await d.post('/v1/auth/password', { password: PW });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const guesser = new Device(h, 'native', `G${i}`); // a new address each time: the limit is on the account
      codes.push((await signIn(guesser, 'target@acme.example', `guess number ${i}!`)).status);
    }
    expect(codes.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    h.advance(11 * 60_000);
  });

  it('resets a password with an emailed code, without saying whether an address has an account', async () => {
    const lic = await h.license({ email: 'forgetful@acme.example' });
    const d = new Device(h, 'native', 'PC');
    await d.activate(lic.key);
    await d.post('/v1/auth/password', { password: PW });

    expect((await d.post('/v1/auth/password/forgot', { email: 'nobody@nowhere.example' })).status).toBe(204);
    expect(h.mails).toHaveLength(0);
    expect((await d.post('/v1/auth/password/forgot', { email: 'Forgetful@acme.example' })).status).toBe(204);
    expect(h.mails).toHaveLength(1);
    const code = /Reset code: (\d{6})/.exec(h.mails[0].text)![1];
    const wrong = code === '000000' ? '000001' : '000000';
    expect((await d.post('/v1/auth/password/reset', { email: 'forgetful@acme.example', code: wrong, password: 'a brand new password' })).body.code).toBe('bad_code');
    expect((await d.post('/v1/auth/password/reset', { email: 'forgetful@acme.example', code, password: 'tiny' })).body.message).toMatch(/at least 10/);
    expect((await d.post('/v1/auth/password/reset', { email: 'forgetful@acme.example', code, password: 'a brand new password' })).status).toBe(204);
    expect((await d.post('/v1/auth/password/reset', { email: 'forgetful@acme.example', code, password: 'yet another password' })).body.code).toBe('bad_code'); // single use
    expect((await d.get('/v1/workspace')).body.code).toBe('sign_in_required'); // signed out everywhere
    expect((await signIn(d, 'forgetful@acme.example', PW)).body.code).toBe('bad_credentials');
    expect((await signIn(d, 'forgetful@acme.example', 'a brand new password')).body.ok).toBe(true);

    // Five wrong guesses kill a code.
    await d.post('/v1/auth/password/forgot', { email: 'forgetful@acme.example' });
    const real = /Reset code: (\d{6})/.exec(h.mails.at(-1)!.text)![1];
    for (let i = 0; i < 5; i++) await d.post('/v1/auth/password/reset', { email: 'forgetful@acme.example', code: real === '111111' ? '222222' : '111111', password: 'does not matter 123' });
    expect((await d.post('/v1/auth/password/reset', { email: 'forgetful@acme.example', code: real, password: 'does not matter 123' })).body.code).toBe('bad_code');
  });
});

describe('two-step sign-in', () => {
  it('adds a second step with an authenticator app, offers single-use recovery codes, and can be required for a workspace', async () => {
    const lic = await h.license({ email: 'careful@acme.example', maxDevices: 3, plan: 'business' });
    const pc = new Device(h, 'native', 'PC');
    await pc.activate(lic.key);
    expect((await pc.post('/v1/auth/mfa/setup')).body.message).toMatch(/Set a password first/);
    await pc.post('/v1/auth/password', { password: PW });
    // The workspace cannot require a second step before the person asking has one.
    expect((await push(pc, change('security', 'security', { mfa: true }))).body.code).toBe('mfa_setup_required');

    const setup = (await pc.post('/v1/auth/mfa/setup')).body;
    expect(setup.uri).toBe(`otpauth://totp/Nexora%20AI%3Acareful%40acme.example?secret=${setup.secret}&issuer=Nexora%20AI&algorithm=SHA1&digits=6&period=30`);
    expect((await snap(pc)).me.mfa).toBe(false); // not on until a code is confirmed
    expect((await pc.post('/v1/auth/mfa/enable', { code: '000000' })).body.code).toBe('bad_code');
    const enabled = await pc.post('/v1/auth/mfa/enable', { code: codeNow(setup.secret) });
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    expect(enabled.body.recoveryCodes[0]).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect((await snap(pc)).me.mfa).toBe(true);
    const stored = (await h.ctx.db.query("SELECT totp_secret_enc, recovery_hashes FROM users WHERE lower(email) = 'careful@acme.example'")).rows[0];
    expect(JSON.stringify(stored)).not.toContain(setup.secret);
    expect(JSON.stringify(stored)).not.toContain(enabled.body.recoveryCodes[0].replace('-', ''));

    const laptop = new Device(h, 'native', 'LAPTOP');
    expect((await signIn(laptop, 'careful@acme.example', PW)).body).toEqual({ ok: false, code: 'mfa_required' });
    expect((await signIn(laptop, 'careful@acme.example', PW, { code: '123456' })).body).toEqual({ ok: false, code: 'bad_code' });
    h.advance(30_000);
    const good = codeNow(setup.secret);
    expect((await signIn(laptop, 'careful@acme.example', PW, { code: good })).body.ok).toBe(true);
    // The same code cannot be replayed from another device.
    const tablet = new Device(h, 'web', 'Tablet');
    expect((await signIn(tablet, 'careful@acme.example', PW, { code: good })).body.code).toBe('bad_code');
    // A recovery code works once.
    const rec = enabled.body.recoveryCodes[3];
    expect((await signIn(tablet, 'careful@acme.example', PW, { code: rec.toLowerCase() })).body.ok).toBe(true);
    await tablet.post('/v1/auth/sign-out');
    expect((await signIn(tablet, 'careful@acme.example', PW, { code: rec })).body.code).toBe('bad_code');

    // Required for the workspace: a member without it must set it up before anything else.
    expect((await push(pc, change('security', 'security', { mfa: true }))).status).toBe(204);
    await pc.post('/v1/team/invitations', { email: 'new@acme.example', role: 'member' });
    await pc.post('/v1/auth/mfa/disable', { password: 'x', code: '1' }); // wrong: stays on
    expect((await snap(pc)).me.mfa).toBe(true);
    await laptop.post('/v1/license/deactivate');
    const theirs = new Device(h, 'native', 'NEW-PC');
    expect((await accept(theirs, inviteToken(), 'New Person', 'their own password')).body.ok).toBe(true);
    const gate = await theirs.get('/v1/workspace');
    expect([gate.status, gate.body.code]).toEqual([403, 'mfa_setup_required']);
    const s2 = (await theirs.post('/v1/auth/mfa/setup')).body;
    await theirs.post('/v1/auth/mfa/enable', { code: codeNow(s2.secret) });
    expect((await theirs.get('/v1/workspace')).status).toBe(200);

    // Switching it off needs the password and a current code; an owner who does also lifts the workspace rule.
    h.advance(60_000);
    expect((await pc.post('/v1/auth/mfa/disable', { password: PW, code: codeNow(setup.secret) })).status).toBe(204);
    const after = await snap(pc);
    expect([after.me.mfa, after.mfa]).toEqual([false, false]);
  });
});

describe('team', () => {
  let key: string;
  let owner: Device;
  let ws: string;

  beforeAll(async () => {
    const lic = await h.license({ email: 'boss@team.example', name: 'The Boss', workspace: 'Team Co', plan: 'business', maxDevices: 10 });
    key = lic.key; ws = lic.workspaceId;
    owner = new Device(h, 'native', 'BOSS-PC');
    await owner.activate(key);
  });

  it('invites by email, lets the invitee choose a password and join without the license key', async () => {
    expect((await owner.post('/v1/team/invitations', { email: 'ana@team.example', role: 'member' })).body.message).toMatch(/Set a password for the owner/);
    await owner.post('/v1/auth/password', { password: PW });
    expect((await owner.post('/v1/team/invitations', { email: 'not-an-email', role: 'member' })).body.message).toBe('Enter a valid email address.');
    expect((await owner.post('/v1/team/invitations', { email: 'ana@team.example', role: 'owner' })).status).toBe(400);
    const inv = await owner.post('/v1/team/invitations', { email: 'Ana@Team.example', role: 'member' });
    expect(inv.body).toMatchObject({ email: 'ana@team.example', role: 'member' });
    expect(h.mails.at(-1)).toMatchObject({ to: 'ana@team.example', subject: 'The Boss invited you to Team Co on Nexora AI' });
    const token = inviteToken();
    expect(JSON.stringify((await h.ctx.db.query('SELECT * FROM invitations')).rows)).not.toContain(token); // only its hash is stored
    expect((await snap(owner)).team.invitations).toEqual([{ id: inv.body.id, email: 'ana@team.example', role: 'member', expiresAt: expect.any(String) }]);

    const ana = new Device(h, 'native', 'ANA-PC');
    expect((await ana.post('/v1/auth/invite/info', { token })).body).toEqual({ email: 'ana@team.example', workspace: 'Team Co', role: 'member', hasAccount: false });
    expect((await ana.post('/v1/auth/invite/info', { token: 'guess' })).status).toBe(404);
    expect((await accept(ana, token, 'Ana Lima', 'tiny')).body.message).toMatch(/at least 10/);
    expect((await accept(ana, token, 'Ana Lima', 'ana has a password')).body.ok).toBe(true);
    const s = await snap(ana);
    expect(s.me).toMatchObject({ name: 'Ana Lima', email: 'ana@team.example', role: 'member', hasPassword: true });
    expect(s.profile).toEqual({ name: 'Ana Lima', email: 'ana@team.example', workspace: 'Team Co' });
    expect(s.team).toBeUndefined(); // the member list is for owners and admins
    expect((await accept(new Device(h, 'native', 'X'), token, 'Twice', 'another password 1')).status).toBe(404); // single use

    const team = (await snap(owner)).team;
    expect(team.members.map((m: any) => [m.name, m.role])).toEqual([['The Boss', 'owner'], ['Ana Lima', 'member']]);
    expect(team.invitations).toEqual([]);
    expect((await snap(owner)).activity[0].text).toBe('Ana Lima joined the workspace');
    // Ana signs in on another device later, again without the key.
    const anaPhone = new Device(h, 'web', 'Ana phone');
    expect((await signIn(anaPhone, 'ana@team.example', 'ana has a password')).body.ok).toBe(true);
    expect((await snap(anaPhone)).me.role).toBe('member');
  });

  it('enforces what each role may do', async () => {
    await owner.post('/v1/team/invitations', { email: 'vic@team.example', role: 'viewer' });
    const vic = new Device(h, 'native', 'VIC-PC');
    await accept(vic, inviteToken(), 'Vic Viewer', 'vic only looks ok');
    await owner.post('/v1/team/invitations', { email: 'adi@team.example', role: 'admin' });
    const adi = new Device(h, 'native', 'ADI-PC');
    await accept(adi, inviteToken(), 'Adi Admin', 'adi runs the place');
    const ana = new Device(h, 'web', 'Ana tablet');
    await signIn(ana, 'ana@team.example', 'ana has a password');

    // Viewer: reads, never writes.
    expect((await vic.get('/v1/workspace')).status).toBe(200);
    const l = newLead(randomUUID(), 'Lead', 'Co', h.ctx.now().toISOString());
    const refused = await push(vic, change('lead', l.id, l));
    expect([refused.status, refused.body.message]).toEqual([403, 'Your role is viewer: you can look, but not change anything.']);
    expect((await vic.post('/v1/ai/chat', { history: [{ me: true, text: 'hi' }] })).status).toBe(403);
    expect((await vic.post('/v1/auth/password', { current: 'vic only looks ok', password: 'vic changed their own' })).status).toBe(204); // their own account is theirs

    // Member: works with data, not with settings, integrations, keys, team or other people's sessions.
    expect((await push(ana, change('lead', l.id, l))).status).toBe(204);
    expect((await push(ana, change('routing', 'routing', { 'Content generation': 'OpenAI', 'Lead research': 'OpenAI', 'Reply suggestions': 'OpenAI' }))).status).toBe(403);
    expect((await ana.post('/v1/integrations/n8/connect', { fields: { url: 'https://n8n.example/x' } })).status).toBe(403);
    expect((await ana.post('/v1/ai/providers/verify', { name: 'OpenAI', key: 'sk' })).status).toBe(403);
    expect((await ana.post('/v1/team/invitations', { email: 'friend@team.example', role: 'member' })).status).toBe(403);
    expect((await ana.del(`/v1/team/members/${(await snap(owner)).team.members[0].id}`)).status).toBe(403);
    expect((await ana.del(`/v1/sessions/${(await snap(owner)).sessions[0].id}`)).status).toBe(403);
    // A member's profile change is their own; it does not rename the workspace.
    expect((await push(ana, change('profile', 'profile', { name: 'Ana L.', email: 'ana@team.example', workspace: 'Hijacked Co' }))).status).toBe(204);
    expect((await snap(owner)).profile).toEqual({ name: 'The Boss', email: 'boss@team.example', workspace: 'Team Co' });
    expect((await snap(ana)).profile.name).toBe('Ana L.');

    // Admin: settings and team, but not other admins or the owner.
    expect((await push(adi, change('routing', 'routing', { 'Content generation': 'OpenAI', 'Lead research': 'OpenAI', 'Reply suggestions': 'OpenAI' }))).status).toBe(204);
    const members = (await snap(adi)).team.members;
    const id = (name: string) => members.find((m: any) => m.name.startsWith(name)).id;
    expect((await adi.post(`/v1/team/members/${id('Ana')}/role`, { role: 'viewer' })).status).toBe(204);
    expect((await adi.post(`/v1/team/members/${id('Ana')}/role`, { role: 'admin' })).body.message).toMatch(/Only the owner can make someone an admin/);
    expect((await adi.post(`/v1/team/members/${id('The Boss')}/role`, { role: 'member' })).body.message).toBe('The owner’s role cannot be changed.');
    expect((await adi.del(`/v1/team/members/${id('The Boss')}`)).body.message).toBe('The owner cannot be removed.');
    expect((await push(ana, change('lead', l.id, l))).status).toBe(403); // now a viewer, on her very next request
    expect((await owner.post(`/v1/team/members/${id('Ana')}/role`, { role: 'member' })).status).toBe(204);

    // Removing someone signs their devices out at once and frees their seats.
    const before = (await h.ctx.db.query('SELECT count(*)::int AS n FROM license_activations a JOIN licenses l ON l.id = a.license_id WHERE l.workspace_id = $1 AND a.deactivated_at IS NULL', [ws])).rows[0].n;
    expect((await adi.del(`/v1/team/members/${id('Vic')}`)).status).toBe(204);
    expect((await vic.get('/v1/workspace')).status).toBe(401);
    const after = (await h.ctx.db.query('SELECT count(*)::int AS n FROM license_activations a JOIN licenses l ON l.id = a.license_id WHERE l.workspace_id = $1 AND a.deactivated_at IS NULL', [ws])).rows[0].n;
    expect(after).toBe(before - 1);
    expect((await signIn(vic, 'vic@team.example', 'vic changed their own')).body).toEqual({ ok: false, code: 'no_workspace' });
  });

  it('keeps workspaces of one account separate, and lets only their members switch between them', async () => {
    const made = await owner.post('/v1/workspaces', { name: 'Client B' });
    expect(made.body).toMatchObject({ name: 'Client B', role: 'owner', current: false });
    const l = newLead(randomUUID(), 'Only in Team Co', 'Co', h.ctx.now().toISOString());
    await push(owner, change('lead', l.id, l));

    expect((await snap(owner)).workspaces.map((w: any) => [w.name, w.current])).toEqual([['Team Co', true], ['Client B', false]]);
    expect((await owner.post('/v1/workspaces/switch', { id: made.body.id })).status).toBe(204);
    const b = await snap(owner);
    expect(b.profile.workspace).toBe('Client B');
    expect(b.leads).toEqual([]);
    expect(b.team.members.map((m: any) => m.name)).toEqual(['The Boss']);
    const only = newLead(randomUUID(), 'Only in Client B', 'Co', h.ctx.now().toISOString());
    await push(owner, change('lead', only.id, only));

    // A member of Team Co is not in Client B and cannot switch to it or create one.
    const ana = new Device(h, 'web', 'Ana laptop');
    await signIn(ana, 'ana@team.example', 'ana has a password');
    expect((await snap(ana)).workspaces.map((w: any) => w.name)).toEqual(['Team Co']);
    expect((await ana.post('/v1/workspaces/switch', { id: made.body.id })).status).toBe(404);
    expect((await ana.post('/v1/workspaces', { name: 'Mine' })).status).toBe(403);
    expect((await snap(ana)).leads.some((x: any) => x.name === 'Only in Client B')).toBe(false);

    await owner.post('/v1/workspaces/switch', { id: ws });
    expect((await snap(owner)).leads.some((x: any) => x.name === 'Only in Client B')).toBe(false);
    // Another account's workspace is out of reach even with its id.
    const stranger = await h.license({ plan: 'business' });
    expect((await owner.post('/v1/workspaces/switch', { id: stranger.workspaceId })).status).toBe(404);
  });
});

describe('plans', () => {
  it('includes only what the plan says: workflows, integrations, the desktop app, team and workspaces', async () => {
    const starter = await h.license({ plan: 'starter' });
    const desktop = new Device(h, 'native', 'PC');
    expect((await desktop.activate(starter.key)).body).toEqual({ ok: false, code: 'not_included', plan: 'Starter' });
    const web = new Device(h, 'web', 'Chrome');
    expect((await web.activate(starter.key)).body.ok).toBe(true);
    const s = await snap(web);
    expect(s.plan).toMatchObject({ name: 'Starter', features: [] });

    // The base product works.
    const l = newLead(randomUUID(), 'Lead', 'Co', h.ctx.now().toISOString());
    expect((await push(web, change('lead', l.id, l))).status).toBe(204);
    // What Professional adds is refused, with the reason.
    const wf = randomUUID();
    const r = await push(web, change('workflow', wf, { id: wf, name: 'W', on: true, steps: [makeStep('lead.created'), makeStep('notify')] }));
    expect([r.status, r.body.code, r.body.message]).toEqual([402, 'not_included', 'Workflows is part of the Professional plan. Your current plan does not include it.']);
    expect((await web.post('/v1/integrations/n8/connect', { fields: { url: 'https://n8n.example/x' } })).body.code).toBe('not_included');
    // An AI provider key is not an "integration" in that sense: every plan needs one.
    h.respond = () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect((await web.post('/v1/integrations/oa/connect', { apiKey: 'sk-good' })).status).toBe(200);
    // What Business adds.
    await web.post('/v1/auth/password', { password: PW });
    expect((await web.post('/v1/team/invitations', { email: 'x@y.example', role: 'member' })).body.message).toMatch(/part of the Business plan/);
    expect((await web.post('/v1/workspaces', { name: 'Second' })).body.code).toBe('not_included');

    const pro = await h.license({ plan: 'professional' });
    const d = new Device(h, 'native', 'PRO-PC');
    expect((await d.activate(pro.key)).body.ok).toBe(true);
    expect((await d.post('/v1/workspaces', { name: 'Second' })).body.code).toBe('not_included');
  });

  it('offers annual, lifetime and enterprise plans', async () => {
    const d = new Device(h, 'native', 'PC');
    const annual = await h.license({ plan: 'professional-annual', months: 12 });
    expect((await d.activate(annual.key)).body.license).toMatchObject({ plan: 'Professional (annual)', priceLabel: '$290 / year' });
    const life = await h.license({ plan: 'lifetime' });
    const d2 = new Device(h, 'native', 'PC2');
    const lic = (await d2.activate(life.key)).body.license;
    expect(lic).toMatchObject({ plan: 'Lifetime desktop', priceLabel: '$349, one payment', renewsOn: 'Never — lifetime license' });
    h.advance(20 * 365 * 86_400_000);
    expect((await d2.get('/v1/workspace')).status).toBe(200); // still valid twenty years on
    h.advance(-20 * 365 * 86_400_000);
    const ent = await h.license({ plan: 'enterprise', months: 12 });
    const d3 = new Device(h, 'native', 'PC3');
    expect((await d3.activate(ent.key)).body.license).toMatchObject({ plan: 'Enterprise', priceLabel: 'Custom pricing', maxDevices: 25 });
    await expect(h.license({ plan: 'platinum' })).rejects.toThrow(/Unknown plan "platinum". Plans: .*lifetime/);
  });
});
