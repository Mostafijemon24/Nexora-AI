import { loadConfig } from './config.ts';
import type { Ctx } from './context.ts';
import { createDb } from './db.ts';
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
  const ctx: Ctx = { db, config, limiter: redis ? redisLimiter(redis) : memoryLimiter(), mail: mail.send, now: () => new Date(), fetch: globalThis.fetch };
  const close = async () => { await mail.close(); await redis?.quit().catch(() => {}); await db.end(); };
  return { ctx, config, db, redis, mailer, close };
}
