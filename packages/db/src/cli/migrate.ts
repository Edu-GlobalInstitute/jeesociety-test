import { createDirectPool, directConnectionString } from '../pool.js';
import { migrate } from '../migrate.js';

/**
 * Migrations run on Neon's direct endpoint, not the pooler: DDL is session
 * work, and the direct connection is also the one whose `pg_advisory_xact_lock`
 * is guaranteed to mean what it says. directConnectionString() falls back to
 * DATABASE_URL untouched when it is not a Neon pooled host, so a local docker
 * run needs no extra variable.
 */

const host = new URL(directConnectionString()).host;
console.log(`migrating via ${host}`);

const pool = createDirectPool();
try {
  const result = await migrate(pool, undefined, (message) => console.log(message));
  if (result.applied.length === 0) {
    console.log(`up to date (${result.alreadyApplied.length} migrations)`);
  } else {
    console.log(`applied ${result.applied.length}: ${result.applied.join(', ')}`);
  }
} finally {
  await pool.end();
}
