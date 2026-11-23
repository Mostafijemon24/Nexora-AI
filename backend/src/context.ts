import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Mail } from './mail.ts';
import type { RateLimiter } from './ratelimit.ts';

/** Everything a request handler needs. Tests swap the clock, mail delivery and outbound fetch. */
export interface Ctx {
  db: Db;
  config: Config;
  limiter: RateLimiter;
  /** Delivers or enqueues an email. */
  mail: (mail: Mail) => Promise<void>;
  now: () => Date;
  fetch: typeof fetch;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "23 December 2026" (UTC) */
export const fullDate = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
/** "23 Nov 2026" (UTC) */
export const shortDate = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
