import { lookup } from 'node:dns/promises';
import nodemailer from 'nodemailer';
import { loadConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { createDb } from './db.ts';
import { imapMailbox } from './mailbox.ts';
import { logMailer, smtpMailer } from './mail.ts';
import { mailSender, redisConnection } from './queue.ts';
import { memoryLimiter, redisLimiter } from './ratelimit.ts';

/** Builds the production context from the environment. */
export function createRuntime() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const redis = config.redisUrl ? redisConnection(config.redisUrl) : undefined;
  const mailer = config.smtpUrl ? smtpMailer(config.smtpUrl, config.mailFrom) : logMailer;
  const mail = mailSender(mailer, redis);
  const ctx: Ctx = { db, config, limiter: redis ? redisLimiter(redis) : memoryLimiter(), mail: mail.send, now: () => new Date(), fetch: globalThis.fetch,
    smtp: (a) => nodemailer.createTransport({
      host: a.host, port: Number(a.port) || 587, secure: Number(a.port) === 465, auth: { user: a.user, pass: a.password },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    }),
    mailbox: imapMailbox,
    resolve: async (host) => (await lookup(host, { all: true })).map((x) => x.address),
  };
  const close = async () => { await mail.close(); await redis?.quit().catch(() => {}); await db.end(); };
  return { ctx, config, db, redis, mailer, close };
}
