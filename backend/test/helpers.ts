import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Ctx, MailboxMessage } from '../src/context.ts';
import { createDb, migrate } from '../src/db.ts';
import { createLicense, type NewLicense } from '../src/license/service.ts';
import type { Mail } from '../src/mail.ts';
import { memoryLimiter } from '../src/ratelimit.ts';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://nexora:nexora@localhost:5432/nexora_test';
export const ORIGIN = 'http://localhost:1420';
/** A fixed test-only signing seed; its public key is in the cross-language fixture. */
export const TEST_SEED = Buffer.alloc(32, 7);

export interface Harness {
  ctx: Ctx;
  app: ReturnType<typeof createApp>;
  mails: Mail[];
  /** Outbound HTTP the code under test made. */
  calls: { url: string; init?: RequestInit }[];
  /** Email the code under test sent through a workspace's own SMTP account. */
  sent: { account: { host: string; port: string; user: string; password: string }; mail: any }[];
  /** Messages waiting in workspace mailboxes, by IMAP user name. */
  inbox: Map<string, MailboxMessage[]>;
  /** Replace to script provider responses. */
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
  setNow(d: Date | string): void;
  advance(ms: number): void;
  license(o?: Partial<NewLicense>): Promise<{ key: string; licenseId: string; workspaceId: string }>;
  close(): Promise<void>;
}

export async function harness(): Promise<Harness> {
  const config = loadConfig({
    DATABASE_URL: TEST_DB, LICENSE_SIGNING_KEY: TEST_SEED.toString('base64'), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    HASH_SECRET: 'test-hash-secret-0123456789abcdef', APP_ORIGINS: ORIGIN, PUBLIC_API_URL: 'http://localhost:8787',
    TRUST_PROXY: '1', OAUTH_HUBSPOT_CLIENT_ID: 'hs-client', OAUTH_HUBSPOT_CLIENT_SECRET: 'hs-secret',
  });
  const db = createDb(TEST_DB);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  let now = new Date('2026-11-23T09:00:00Z');
  const h = {
    mails: [] as Mail[], calls: [] as { url: string; init?: RequestInit }[],
    sent: [] as Harness['sent'], inbox: new Map<string, MailboxMessage[]>(),
    respond: (() => new Response('{}', { status: 500 })) as Harness['respond'],
  };
  const ctx: Ctx = {
    db, config, limiter: memoryLimiter(() => now.getTime()),
    mail: async (m) => { h.mails.push(m); },
    now: () => new Date(now),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      h.calls.push({ url, init });
      return h.respond(url, init);
    }) as typeof fetch,
    smtp: (account) => ({
      verify: async () => { if (account.password === 'wrong') throw new Error('Invalid login'); },
      sendMail: async (mail) => { h.sent.push({ account, mail }); return { messageId: `<sent-${h.sent.length}@test>` }; },
    }),
    mailbox: (account) => ({
      fetchAfter: async (uid) => {
        if (account.password === 'wrong') throw new Error('Invalid login');
        const all = h.inbox.get(account.user) ?? [];
        return { validity: '1', lastUid: all.at(-1)?.uid ?? 0, messages: uid === null ? [] : all.filter((m) => m.uid > uid) };
      },
    }),
  };
  return Object.assign(h, {
    ctx, app: createApp(ctx),
    setNow: (d: Date | string) => { now = new Date(d); },
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    license: (o: Partial<NewLicense> = {}) => {
      const n = randomUUID().slice(0, 8);
      return createLicense(ctx, { email: `owner-${n}@example.com`, name: 'Rafiq Hasan', workspace: `Workspace ${n}`, plan: 'professional', months: 1, ...o });
    },
    close: () => db.end(),
  });
}

export interface Reply<T = any> { status: number; body: T; headers: Headers }

/** A simulated device: a browser (cookie jar, shared by all its "tabs") or a native install (bearer token). */
export class Device {
  cookies = new Map<string, string>();
  token: string | undefined;
  info: { id: string; name: string; os: string; platform: string; appVersion: string };
  userAgent: string;
  /** Each simulated device has its own address, so per-IP rate limits do not couple tests. */
  ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  private h: Harness;

  constructor(h: Harness, kind: 'web' | 'native', name: string, userAgent = `TestBrowser/${name}`) {
    this.h = h;
    this.userAgent = userAgent;
    this.info = kind === 'web'
      ? { id: '', name, os: 'this browser', platform: 'web', appVersion: '1.0.0' }
      : { id: randomUUID(), name, os: 'Windows 11', platform: 'windows', appVersion: '1.0.0' };
  }
  get native() { return this.info.platform !== 'web'; }

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply<T>> {
    const hd: Record<string, string> = { 'user-agent': this.userAgent, 'x-forwarded-for': this.ip, ...headers };
    if (body !== undefined) hd['content-type'] = 'application/json';
    if (this.native) { if (this.token) hd.authorization = `Bearer ${this.token}`; }
    else {
      if (!('origin' in hd)) hd.origin = ORIGIN;
      if (this.cookies.size) hd.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (hd.origin === '') delete hd.origin;
    const res = await this.h.app.request(path, { method, headers: hd, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (v === '' || /max-age=0/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    const txt = await res.text();
    return { status: res.status, body: (txt ? JSON.parse(txt) : null) as T, headers: res.headers };
  }
  get = <T = any>(path: string) => this.req<T>('GET', path);
  post = <T = any>(path: string, body: unknown = {}) => this.req<T>('POST', path, body);
  del = <T = any>(path: string) => this.req<T>('DELETE', path);

  async activate(key: string): Promise<Reply> {
    const r = await this.post('/v1/license/activate', { key, device: this.info });
    if (r.body?.sessionToken) this.token = r.body.sessionToken;
    return r;
  }
  status = () => this.post('/v1/license/status', { device: this.info });
  async confirmTransfer(key: string, code: string): Promise<Reply> {
    const r = await this.post('/v1/license/transfer/confirm', { key, code, device: this.info });
    if (r.body?.sessionToken) this.token = r.body.sessionToken;
    return r;
  }
  requestTransfer = (key: string) => this.post('/v1/license/transfer/request', { key, device: this.info });
}

export const codeFrom = (m: Mail): string => /Transfer code: (\d{6})/.exec(m.text)![1];
export const change = (entity: string, entityId: string, data?: unknown, op: 'upsert' | 'delete' = 'upsert') =>
  ({ id: randomUUID(), entity, op, entityId, data, at: new Date().toISOString() });
