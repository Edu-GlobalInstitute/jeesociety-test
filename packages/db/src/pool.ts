import pg from 'pg';

/**
 * One pool per process, against Neon.
 *
 * Neon issues two connection strings for the same branch and the difference
 * decides whether a given piece of work is correct:
 *
 *   DATABASE_URL           ep-xxx-pooler.<region>.aws.neon.tech  PgBouncer, transaction mode
 *   DATABASE_URL_UNPOOLED  ep-xxx.<region>.aws.neon.tech         straight to the compute
 *
 * Everything the API and worker run at request time is a plain parameterised
 * query with no named prepared statements, so all of it goes through the
 * pooler. That is also what retires the old connection budget: PgBouncer
 * multiplexes thousands of client connections onto the compute's own
 * max_connections, so `replicas x PG_POOL_MAX` is no longer a cliff that ends
 * in refusals mid-event. PG_POOL_MAX is still read from the environment and
 * logged at boot, but it is now a throughput knob rather than a fuse.
 *
 * Anything that needs one session's state to survive across statements must
 * NOT go through the pooler, because transaction pooling hands out a different
 * backend per transaction: session advisory locks (migrate.ts), `pg_dump`, and
 * CREATE DATABASE. Those resolve their endpoint with directConnectionString().
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

/** How Neon names the pooled member of the pair: the host, plus `-pooler`. */
const POOLER_MARKER = '-pooler';

export interface PoolOptions {
  connectionString?: string;
  max?: number;
  applicationName?: string;
}

/** True for Neon's transaction-pooled endpoint — no session-scoped state. */
export function isPooledConnectionString(connectionString: string): boolean {
  try {
    return new URL(connectionString).hostname.includes(POOLER_MARKER);
  } catch {
    return false;
  }
}

/**
 * The endpoint for session-scoped work. DATABASE_URL_UNPOOLED when it is set —
 * Neon's own integrations export it under exactly that name — otherwise the
 * pooled host with `-pooler` removed, which is the direct host of the same
 * branch. A connection string that is not Neon's is returned unchanged, so
 * local development against docker keeps working with one variable.
 */
export function directConnectionString(
  connectionString: string | undefined = process.env.DATABASE_URL,
  /** Pass '' to derive from `connectionString` alone and ignore the env. */
  unpooled: string | undefined = process.env.DATABASE_URL_UNPOOLED,
): string {
  if (unpooled) return unpooled;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!isPooledConnectionString(connectionString)) return connectionString;
  const url = new URL(connectionString);
  url.hostname = url.hostname.replace(POOLER_MARKER, '');
  return url.toString();
}

/**
 * pg merges the parsed connection string *over* the options object, so an
 * `ssl` passed next to a `connectionString` that carries `sslmode` is silently
 * discarded. sslmode is therefore taken out of the string here and turned into
 * an explicit option, so what this file says is what the socket does.
 *
 * Verification stays on: Neon presents a publicly trusted certificate, and
 * `sslmode=require` without verification is encryption with no authentication
 * — no defence at all against whoever can answer for that hostname, which is
 * the threat that matters now the database is reached over the internet rather
 * than a private network. PGSSL_NO_VERIFY exists for a self-signed proxy in
 * development and is refused in production (see each service's env.ts).
 */
function resolveSsl(connectionString: string): {
  connectionString: string;
  ssl: pg.PoolConfig['ssl'];
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return { connectionString, ssl: undefined };
  }

  const sslmode = url.searchParams.get('sslmode');
  if (!sslmode) {
    // No sslmode at all is local docker over loopback: plaintext, as before.
    return { connectionString, ssl: undefined };
  }
  url.searchParams.delete('sslmode');

  return {
    connectionString: url.toString(),
    ssl:
      sslmode === 'disable'
        ? false
        : { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== 'true' },
  };
}

function poolConfig(options: PoolOptions): pg.PoolConfig {
  const raw = options.connectionString ?? process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set');
  }
  const { connectionString, ssl } = resolveSsl(raw);

  return {
    connectionString,
    ssl,
    max: options.max ?? Number(process.env.PG_POOL_MAX ?? 10),
    application_name: options.applicationName ?? process.env.SERVICE_NAME ?? 'jee',
    // A connection that cannot be had in 5s is a connection the student should
    // not be waiting on: fail fast so the client retries on its own schedule.
    // A TLS handshake to Neon in the same metro is tens of milliseconds, so
    // this stays where it was — the one thing that would blow through it is a
    // suspended compute waking up, which is why autosuspend is turned off for
    // the event (deploy/neon.md) rather than paid for here on every request.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // The hop is now public internet, where an idle NAT entry can be dropped
    // without either end being told. Keepalives surface a dead socket as a
    // reconnect instead of as one request hanging until its timeout.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

export function createPool(options: PoolOptions = {}): pg.Pool {
  return new Pool(poolConfig(options));
}

/**
 * A pool on the direct (unpooled) endpoint, for the work PgBouncer's
 * transaction pooling cannot carry. Small by construction: nothing that needs
 * it runs at request rate.
 */
export function createDirectPool(options: PoolOptions = {}): pg.Pool {
  // An explicit string is derived from on its own; only the default path lets
  // DATABASE_URL_UNPOOLED speak for the environment.
  const connectionString = options.connectionString
    ? directConnectionString(options.connectionString, '')
    : directConnectionString();
  return new Pool(poolConfig({ max: 2, ...options, connectionString }));
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
