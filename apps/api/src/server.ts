import { closePool, createPool, setPool } from '@jee/db';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';

/**
 * Process entry. Everything interesting is in app.ts; this file exists to wire
 * the pool, start listening, and shut down cleanly.
 */

/**
 * Configuration is read before anything else, and a bad value stops the boot.
 *
 * That is deliberate — half-configured is worse than not running — but the
 * failure was unreadable. loadEnv throws, nothing catches it, and the process
 * dies before `app.listen`. The host then reports what it sees: "no open ports
 * detected. Bind your service to at least one port." Which sends you looking at
 * PORT, networking and the start command, none of which are wrong.
 *
 * So the refusal says what it is, in a shape that survives a log viewer, and
 * exits 1 rather than dying on an uncaught exception.
 */
let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    '\n'
    + '  ────────────────────────────────────────────────────────────────\n'
    + '  The API did not start: its configuration was refused.\n'
    + '\n'
    + `  ${detail.split('\n').join('\n  ')}\n`
    + '\n'
    + '  Nothing is wrong with the port or the start command. Fix the\n'
    + '  environment variable named above and redeploy.\n'
    + '  ────────────────────────────────────────────────────────────────\n\n',
  );
  process.exit(1);
}

const log = createLogger(env.LOG_LEVEL, 'api');

const pool = createPool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  applicationName: 'jee-api',
});
setPool(pool);

const { app } = createApp({ env, pool, log });

const server = app.listen(env.PORT, () => {
  log.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      poolMax: env.PG_POOL_MAX,
      trustProxyHops: env.TRUST_PROXY_HOPS,
    },
    // The pool size is logged at boot because replicas x poolMax must stay
    // under the Postgres connection limit, and the only way to notice a bad
    // deploy is to see the number.
    'api listening',
  );
});

// Keep-alive longer than the proxy's, so Railway's edge never hands a request
// to a socket this process is in the middle of closing.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

/**
 * Railway sends SIGTERM on every deploy. Without this, in-flight requests are
 * dropped — during the event that means a student's sync failing for no reason.
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');

  server.close(async () => {
    await closePool();
    log.info('shutdown complete');
    process.exit(0);
  });

  // If connections refuse to drain, leave anyway rather than hanging the deploy.
  setTimeout(() => {
    log.warn('forced exit after 15s');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
});
