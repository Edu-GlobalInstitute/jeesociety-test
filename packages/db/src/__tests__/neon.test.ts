import pg from 'pg';
import { describe, expect, it, afterEach } from 'vitest';
import { createPool, directConnectionString, isPooledConnectionString } from '../pool.js';

/**
 * The pooled/direct split is the one Neon detail that is silent when wrong:
 * a session advisory lock or a pg_dump sent to the pooler does not error in an
 * obvious way, it just stops meaning what the caller thinks it means.
 */

const POOLED = 'postgres://u:p@ep-cool-sun-12345-pooler.ap-southeast-1.aws.neon.tech/jee?sslmode=require';
const DIRECT = 'postgres://u:p@ep-cool-sun-12345.ap-southeast-1.aws.neon.tech/jee?sslmode=require';
const LOCAL = 'postgres://jee:jee@localhost:5433/jee';

const saved = { ...process.env };
afterEach(() => {
  // Assigning undefined to process.env stores the string 'undefined', which
  // is truthy and would leak into the next test.
  for (const key of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'PGSSL_NO_VERIFY'] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('isPooledConnectionString', () => {
  it('recognises the pooled host', () => {
    expect(isPooledConnectionString(POOLED)).toBe(true);
  });

  it('does not treat the direct host or local docker as pooled', () => {
    expect(isPooledConnectionString(DIRECT)).toBe(false);
    expect(isPooledConnectionString(LOCAL)).toBe(false);
  });
});

describe('directConnectionString', () => {
  it('prefers DATABASE_URL_UNPOOLED when the environment sets it', () => {
    process.env.DATABASE_URL = POOLED;
    process.env.DATABASE_URL_UNPOOLED = DIRECT;
    expect(directConnectionString()).toBe(DIRECT);
  });

  it('derives the direct host by dropping -pooler', () => {
    expect(new URL(directConnectionString(POOLED, '')).hostname).toBe(
      'ep-cool-sun-12345.ap-southeast-1.aws.neon.tech',
    );
  });

  it('keeps credentials, database and sslmode intact when deriving', () => {
    const derived = new URL(directConnectionString(POOLED, ''));
    expect(derived.username).toBe('u');
    expect(derived.password).toBe('p');
    expect(derived.pathname).toBe('/jee');
    expect(derived.searchParams.get('sslmode')).toBe('require');
  });

  it('leaves a non-Neon url alone, so local development needs one variable', () => {
    expect(directConnectionString(LOCAL, '')).toBe(LOCAL);
  });

  it('throws rather than guessing when nothing is configured', () => {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    expect(() => directConnectionString()).toThrow(/DATABASE_URL/);
  });
});

/**
 * pg merges a parsed connection string over the options object, so an `ssl`
 * passed next to a `connectionString` carrying `sslmode` is discarded without
 * a word. These assert on what a real client would end up using — the pool's
 * options run back through pg's own ConnectionParameters — rather than on what
 * pool.ts passed in.
 */
function effectiveSsl(connectionString: string): unknown {
  const pool = createPool({ connectionString });
  const params = new (pg as unknown as {
    Client: new (config: unknown) => { connectionParameters: { ssl: unknown } };
  }).Client(pool.options).connectionParameters;
  void pool.end();
  return params.ssl;
}

describe('TLS', () => {
  it('verifies the certificate on a Neon connection', () => {
    expect(effectiveSsl(POOLED)).toEqual({ rejectUnauthorized: true });
  });

  it('leaves local docker on plaintext', () => {
    expect(effectiveSsl(LOCAL)).toBeFalsy();
  });

  it('only skips verification when PGSSL_NO_VERIFY says so', () => {
    process.env.PGSSL_NO_VERIFY = 'true';
    expect(effectiveSsl(POOLED)).toEqual({ rejectUnauthorized: false });
  });
});
