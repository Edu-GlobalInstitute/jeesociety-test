import type { Pool, PoolClient, QueryResultRow } from './pool.js';
import { getPool } from './pool.js';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function rows<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = getPool(),
): Promise<T[]> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows;
}

export async function one<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Queryable = getPool(),
): Promise<T | null> {
  const result = await db.query<T>(sql, params as never[]);
  return result.rows[0] ?? null;
}

export async function count(
  sql: string,
  params: unknown[] = [],
  db: Queryable = getPool(),
): Promise<number> {
  const result = await db.query(sql, params as never[]);
  return result.rowCount ?? 0;
}

/**
 * Response whitelisting. Express will happily serialise whatever you hand it,
 * including the answer key if it ever reaches a row object, so no handler in
 * this codebase calls res.json(row) — every one calls res.json(pick(row, [...])).
 */
export function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in source) out[key] = source[key];
  }
  return out;
}
