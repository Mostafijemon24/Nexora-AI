import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Dates stay plain YYYY-MM-DD strings; numerics that fit are returned as numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Db = pg.Pool;
/** Anything a query can run on: the pool, or a client inside a transaction. */
export type Q = Pick<pg.PoolClient, 'query'>;

export const createDb = (url: string): Db => new pg.Pool({ connectionString: url, max: 10 });

export async function tx<T>(db: Db, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Applies migrations/*.sql in name order, once each, under an advisory lock. */
export async function migrate(db: Db): Promise<string[]> {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return tx(db, async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(727274001)');
    await q.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await q.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await q.query(await readFile(dir + f, 'utf8'));
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied.push(f);
    }
    return applied;
  });
}
