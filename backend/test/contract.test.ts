import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../src/workspace/leads.ts';
import { decrypt, encrypt, newLicenseKey, publicKeyBase64, signEntitlement } from '../src/crypto.ts';
import { createDb, migrate } from '../src/db.ts';
import type { Mail } from '../src/mail.ts';
import { mailSender, maintenance, QUEUE, redisConnection, startWorker } from '../src/queue.ts';
import { memoryLimiter, redisLimiter } from '../src/ratelimit.ts';
import { TEST_DB, TEST_SEED } from './helpers.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/entitlement.json', import.meta.url));

describe('entitlement token contract with the Rust client', () => {
  // crates/nexora-core/tests/contract.rs verifies this same file with the client's verifier,
  // so a change to the token format on either side fails a test.
  it('produces exactly the token recorded in the shared fixture', () => {
    const payload = { license_id: '6f1c0b9e-2f0a-4c57-9a55-0d3c1d2b7a10', device_id: '0b0f6a54-7d0e-4a57-8f0b-2f8c1c6f9d11', plan: 'professional', issued_at: 1795424400, license_expires_at: 1798016400 };
    const fixture = { public_key: publicKeyBase64(TEST_SEED), payload, token: signEntitlement(TEST_SEED, payload) };
    if (process.env.UPDATE_FIXTURES || !existsSync(FIXTURE)) writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n');
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(fixture);
  });
});

describe('crypto', () => {
  it('encrypts with a fresh nonce each time and detects tampering', () => {
    const key = Buffer.alloc(32, 1);
    const a = encrypt(key, 'sk-secret');
    expect(a).not.toBe(encrypt(key, 'sk-secret'));
    expect(decrypt(key, a)).toBe('sk-secret');
    expect(() => decrypt(key, a.slice(0, -2) + 'AA')).toThrow();
    expect(() => decrypt(Buffer.alloc(32, 2), a)).toThrow();
  });
  it('generates license keys in the documented format', () => {
    const keys = new Set(Array.from({ length: 200 }, newLicenseKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^NXR(-[A-HJ-NP-Z2-9]{5}){4}$/);
  });
});

describe('rate limiters', () => {
  it('memory: allows the limit, then blocks until the window passes', async () => {
    let t = 0;
    const l = memoryLimiter(() => t);
    expect([await l.allow('k', 2, 10), await l.allow('k', 2, 10), await l.allow('k', 2, 10)]).toEqual([true, true, false]);
    expect(await l.allow('other', 2, 10)).toBe(true);
    t = 10_001;
    expect(await l.allow('k', 2, 10)).toBe(true);
  });
});

describe('CSV lead import parser', () => {
  it('handles quotes, embedded commas and newlines, and blank lines', () => {
    expect(parseCsv('name,company\r\n"Smith, John","Acme ""Labs"""\n\n"Multi\nline",B\n')).toEqual([
      ['name', 'company'], ['Smith, John', 'Acme "Labs"'], ['Multi\nline', 'B']]);
  });
});

const REDIS = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const redisUp = await (async () => {
  const r = redisConnection(REDIS);
  r.on('error', () => {});
  try { await Promise.race([r.ping(), new Promise((_, no) => setTimeout(no, 1500))]); return true; } catch { return false; } finally { r.disconnect(); }
})();

describe.skipIf(!redisUp)('background worker (needs Redis)', () => {
  const db = createDb(TEST_DB);
  afterAll(async () => { await db.end(); });

  it('delivers queued email through the worker and shares rate limits through Redis', async () => {
    await migrate(db);
    const redis = redisConnection(REDIS);
    await new Queue(QUEUE, { connection: redis }).obliterate({ force: true });
    const sent: Mail[] = [];
    const worker = await startWorker(db, { send: async (m) => { sent.push(m); } }, redisConnection(REDIS));
    const sender = mailSender({ send: async () => { throw new Error('must go through the queue'); } }, redis);
    await sender.send({ to: 'owner@example.com', subject: 'code', text: 'Transfer code: 123456' });
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(sent).toEqual([{ to: 'owner@example.com', subject: 'code', text: 'Transfer code: 123456' }]);

    const key = `t:${Date.now()}`;
    const l = redisLimiter(redis);
    expect([await l.allow(key, 2, 30), await l.allow(key, 2, 30), await l.allow(key, 2, 30)]).toEqual([true, true, false]);

    await worker.close(); await sender.close(); await redis.quit();
  });

  it('housekeeping removes expired records only', async () => {
    const now = new Date('2026-11-23T09:00:00Z');
    const ws = (await db.query("INSERT INTO workspaces (name) VALUES ('hk') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO oauth_states (state_hash, workspace_id, integration_id, expires_at) VALUES ('old', $1, 'hs', $2), ('live', $1, 'hs', $3)",
      [ws, new Date(now.getTime() - 1000), new Date(now.getTime() + 60_000)]);
    await maintenance(db, now);
    expect((await db.query('SELECT state_hash FROM oauth_states WHERE workspace_id = $1', [ws])).rows).toEqual([{ state_hash: 'live' }]);
  });
});
