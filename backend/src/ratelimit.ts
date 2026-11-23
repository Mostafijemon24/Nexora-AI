import type { Redis } from 'ioredis';

export interface RateLimiter {
  /** Counts one hit against `key`; false once more than `limit` hits land inside `windowSec`. */
  allow(key: string, limit: number, windowSec: number): Promise<boolean>;
}

/** Single-process limiter, used when Redis is not configured. */
export function memoryLimiter(now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    async allow(key, limit, windowSec) {
      const t = now();
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= t) {
        if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
        hits.set(key, { count: 1, resetAt: t + windowSec * 1000 });
        return true;
      }
      cur.count += 1;
      return cur.count <= limit;
    },
  };
}

/** Fixed-window limiter shared by every API instance. */
export function redisLimiter(redis: Redis): RateLimiter {
  return {
    async allow(key, limit, windowSec) {
      const k = `rl:${key}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, windowSec);
      return n <= limit;
    },
  };
}
