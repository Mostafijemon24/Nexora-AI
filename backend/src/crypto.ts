import {
  createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, randomBytes, randomInt,
  sign as edSign, timingSafeEqual,
} from 'node:crypto';

const b64url = (b: Buffer) => b.toString('base64url');

/** Keyed hash for secrets we only ever compare (license keys, session tokens, transfer codes). */
export const hmac = (secret: string, value: string): string => createHmac('sha256', secret).update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const newToken = (): string => b64url(randomBytes(32));

export const newTransferCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
/** NXR-XXXXX-XXXXX-XXXXX-XXXXX: 100 bits of entropy. */
export function newLicenseKey(): string {
  const group = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `NXR-${group()}-${group()}-${group()}-${group()}`;
}

export const normalizeKey = (raw: string): string => raw.trim().toUpperCase();

// ── encryption at rest (AES-256-GCM) ─────────────────────────────────────
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${b64url(iv)}.${b64url(c.getAuthTag())}.${b64url(ct)}`;
}

export function decrypt(key: Buffer, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised ciphertext.');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ── entitlement tokens (Ed25519) ─────────────────────────────────────────
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });

/** The 32-byte public key the native client embeds as NEXORA_LICENSE_PUBLIC_KEY (base64). */
export function publicKeyBase64(seed: Buffer): string {
  const der = createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

export interface EntitlementPayload {
  license_id: string;
  device_id: string;
  plan: string;
  /** Unix seconds. The client's 7-day offline grace period counts from here. */
  issued_at: number;
  license_expires_at: number;
}

/**
 * `base64url(payload JSON).base64url(signature)` — the format `nexora-core::entitlement::verify`
 * checks on the device. Ed25519 signatures are deterministic, which the contract test relies on.
 */
export function signEntitlement(seed: Buffer, payload: EntitlementPayload): string {
  const body = Buffer.from(JSON.stringify(payload));
  return `${b64url(body)}.${b64url(edSign(null, body, privateKey(seed)))}`;
}
