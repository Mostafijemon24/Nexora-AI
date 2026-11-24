// Background work on BullMQ (Redis). Without REDIS_URL the same jobs run in-process, so a
// single-node or self-hosted install works with Postgres alone.

import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { runBackground } from './background.ts';
import type { Ctx } from './context.ts';
import type { Db } from './db.ts';
import type { Mail, Mailer } from './mail.ts';

export const QUEUE = 'nexora';
export const redisConnection = (url: string) => new Redis(url, { maxRetriesPerRequest: null });

/** Returns the function request handlers use to send mail: enqueue when Redis is present, else send now. */
export function mailSender(mailer: Mailer, redis?: Redis): { send: (m: Mail) => Promise<void>; close: () => Promise<void> } {
  if (!redis) return { send: (m) => mailer.send(m), close: async () => {} };
  const queue = new Queue(QUEUE, { connection: redis });
  return {
    send: async (m) => { await queue.add('email', m, { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: 1000 }); },
    close: () => queue.close(),
  };
}

/** Housekeeping: drops expired transfer codes and OAuth states, and old idempotency records. */
export async function maintenance(db: Db, now: Date): Promise<void> {
  await db.query('DELETE FROM license_transfers WHERE expires_at < $1', [new Date(now.getTime() - 86_400_000)]);
  await db.query('DELETE FROM oauth_states WHERE expires_at < $1', [now]);
  await db.query('DELETE FROM applied_changes WHERE applied_at < $1', [new Date(now.getTime() - 90 * 86_400_000)]);
}

/** `ctx` is needed for the once-a-minute background pass; without it the worker only delivers mail and does housekeeping. */
export async function startWorker(db: Db, mailer: Mailer, redis: Redis, ctx?: Ctx): Promise<Worker> {
  const queue = new Queue(QUEUE, { connection: redis });
  await queue.upsertJobScheduler('maintenance', { every: 3_600_000 }, { name: 'maintenance' });
  if (ctx) await queue.upsertJobScheduler('background', { every: 60_000 }, { name: 'background', opts: { removeOnComplete: true, removeOnFail: 50 } });
  await queue.close();
  return new Worker(QUEUE, async (job) => {
    if (job.name === 'email') await mailer.send(job.data as Mail);
    else if (job.name === 'maintenance') await maintenance(db, new Date());
    else if (job.name === 'background' && ctx) await runBackground(ctx);
  }, { connection: redis, concurrency: 5 });
}
