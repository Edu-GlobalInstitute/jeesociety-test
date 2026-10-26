import { pino } from 'pino';
import { closePool, createPool, setPool, type Pool } from '@jee/db';
import { loadEnv } from './env.js';
import { ensureScheduled, runScheduler } from './scheduler.js';
import { reconcilePayments } from './jobs/paymentReconcile.js';
import { checkPgDumpAvailable, runBackup } from './jobs/backup.js';

/**
 * A plain Node process with no HTTP server. Nothing sends it requests; it polls
 * Postgres. Which loops it runs is set by WORKER_JOBS, so the same image can run
 * as the test-day replica and as the one that takes backups.
 */

const env = loadEnv();
const log = pino({
  name: 'worker',
  level: env.LOG_LEVEL,
  redact: {
    paths: ['*.answers', '*.answer', '*.paper_key', '*.answer_key', '*.key'],
    censor: '[redacted]',
  },
});

const pool: Pool = createPool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  applicationName: 'jee-worker',
});
setPool(pool);

let running = true;
const isRunning = () => running;
const loops: Promise<unknown>[] = [];

log.info({ jobs: [...env.WORKER_JOBS], poolMax: env.PG_POOL_MAX }, 'worker starting');

// Auto-submit is scheduled on boot regardless of which loops are enabled, so a
// worker that only grades still leaves the safety net on the queue for another.
await ensureScheduled(pool, log);

if (env.WORKER_JOBS.has('autosubmit') || env.WORKER_JOBS.has('flags')) {
  loops.push(
    runScheduler({ pool, log, isRunning, pollIntervalMs: env.POLL_INTERVAL_MS }),
  );
}

if (env.WORKER_JOBS.has('payments')) {
  loops.push(
    interval(5 * 60_000, async () => {
      const result = await reconcilePayments(pool, env, log);
      if (result.recovered > 0) log.warn(result, 'payments recovered by reconciliation');
    }),
  );
}

if (env.WORKER_JOBS.has('backup')) {
  // Checked once, loudly. A worker that cannot run pg_dump would otherwise
  // take backups that silently never happen, which is discovered on the one
  // day someone needs to restore.
  const pgDump = await checkPgDumpAvailable();
  if (pgDump.ok) {
    log.info({ pgDump: pgDump.detail }, 'backups enabled');
  } else {
    log.error({ detail: pgDump.detail }, 'BACKUPS DISABLED — pg_dump is unavailable');
  }

  loops.push(
    interval(env.BACKUP_INTERVAL_MINUTES * 60_000, async () => {
      await runBackup(env, log);
    }),
  );
}

/** A loop that runs `fn` on a cadence and never dies from one bad iteration. */
async function interval(everyMs: number, fn: () => Promise<void>): Promise<void> {
  while (running) {
    try {
      await fn();
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'interval job failed',
      );
    }
    const until = Date.now() + everyMs;
    while (running && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * Railway sends SIGTERM on every deploy. Setting running = false stops the
 * scheduler claiming new work and lets in-flight jobs finish; anything still
 * held is released by its lease a few minutes later regardless.
 */
function shutdown(signal: string): void {
  if (!running) return;
  log.info({ signal }, 'worker shutting down — finishing in-flight jobs');
  running = false;

  setTimeout(() => {
    log.warn('forced exit after 30s');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await Promise.all(loops);
await closePool();
log.info('worker stopped');
process.exit(0);
