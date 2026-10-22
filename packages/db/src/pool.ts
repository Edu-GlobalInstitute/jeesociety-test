import pg from 'pg';

/**
 * One pool per process. The size ceiling is the thing to get right:
 *
 *   replicas x PG_POOL_MAX  <  Postgres max_connections (default 100)
 *
 * On test day that is 4 api replicas x 15 = 60, plus the worker's 5, plus
 * headroom for psql and backups. Exceeding it does not degrade gracefully — it
 * produces connection refusals mid-event — so the number is read from the
 * environment and logged at boot rather than hard-coded here.
 */

const { Pool, types } = pg;

// numeric arrives as a string by default because it can exceed IEEE754. Scores
// here are small (0..240) and are compared and summed in JS, so parse them.
types.setTypeParser(1700, (value) => (value === null ? null : Number(value)));
// int8/bigserial: counts from aggregate queries, safely inside Number range.
types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

let pool: pg.Pool | null = null;

export interface PoolOptions {
  connectionString?: string;
  max?: number;
  applicationName?: string;
}

export function createPool(options: PoolOptions = {}): pg.Pool {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const max = options.max ?? Number(process.env.PG_POOL_MAX ?? 10);

  return new Pool({
    connectionString,
    max,
    application_name: options.applicationName ?? process.env.SERVICE_NAME ?? 'jee',
    // A connection that cannot be had in 5s is a connection the student should
    // not be waiting on: fail fast so the client retries on its own schedule.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Railway's managed Postgres terminates TLS at the proxy with a
    // self-signed chain; private networking means the hop is internal.
    ssl: connectionString.includes('sslmode=require')
      ? { rejectUnauthorized: false }
      : undefined,
  });
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = createPool();
    pool.on('error', (error) => {
      // An idle client erroring is survivable; the pool replaces it. Log and
      // carry on rather than taking the process down mid-event.
      // eslint-disable-next-line no-console
      console.error({ err: error.message }, 'idle postgres client error');
    });
  }
  return pool;
}

export function setPool(replacement: pg.Pool | null): void {
  pool = replacement;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

/** Runs `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  from: pg.Pool = getPool(),
): Promise<T> {
  const client = await from.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already gone; the transaction is rolled back anyway.
    }
    throw error;
  } finally {
    client.release();
  }
}
