// Password hashing (scrypt) and time-based one-time codes (TOTP, RFC 6238) for two-step sign-in.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const N = 32768, R = 8, P = 1, KEYLEN = 32;

export const MIN_PASSWORD = 10;
/** Why a password is not acceptable, or null. */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return 'Use a password of at most 200 characters.';
  if (/^(.)\1+$/.test(p) || /^(?:0123456789|1234567890|password\d*|qwertyuiop)$/i.test(p)) return 'Choose a password that is harder to guess.';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Spend the same time whether or not the account has a password, so the answer does not reveal it.
    await scrypt(password, Buffer.alloc(16), KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 });
  return got.length === want.length && timingSafeEqual(got, want);
}

// ── TOTP ─────────────────────────────────────────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[\s=-]/g, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Not base32.');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32(randomBytes(20));
export const STEP_SECONDS = 30;

/** The 6-digit code for a 30-second step (HMAC-SHA1, as authenticator apps expect). */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const code = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the
 * step it matched, which the caller stores so the same code cannot be used twice, or null.
 */
export function totpVerify(secret: string, code: string, now: Date, lastStep: number): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = Math.floor(now.getTime() / 1000 / STEP_SECONDS);
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastStep) continue;
    const want = totpAt(secret, step);
    if (timingSafeEqual(Buffer.from(given), Buffer.from(want))) return step;
  }
  return null;
}

export const totpUri = (secret: string, account: string, issuer = 'Nexora AI'): string =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;

/** Ten single-use codes for when the authenticator is not available, e.g. "K7QF-2M9X". */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => { const s = base32(randomBytes(5)); return `${s.slice(0, 4)}-${s.slice(4, 8)}`; });
}
export const normalizeRecovery = (code: string): string => code.toUpperCase().replace(/[^A-Z2-7]/g, '');
