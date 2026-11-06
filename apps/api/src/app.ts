import express, { type Express } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { pinoHttp } from 'pino-http';
import { LIMITS } from '@jee/shared';
import { listMigrations, type Pool } from '@jee/db';
import { createAuth, type Auth } from './auth.js';
import type { Env } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { clientKey, createRateLimiter } from './middleware/rateLimit.js';
import { attemptRoutes } from './routes/attempt.js';
import { statusRoutes } from './routes/status.js';
import { profileRoutes } from './routes/profile.js';
import { paymentRoutes } from './routes/payments.js';
import { adminRoutes } from './routes/admin.js';
import { adminCrmRoutes } from './routes/admin-crm.js';
import { adminResultRoutes } from './routes/admin-results.js';
import { resultRoutes } from './routes/results.js';
import { adminCouponRoutes } from './routes/admin-coupons.js';
import { adminSecurityRoutes } from './routes/admin-security.js';
import { adminBootstrapRoutes } from './routes/admin-bootstrap.js';
import { adminTestRoutes } from './routes/admin-tests.js';
import { adminUploadRoutes } from './routes/admin-uploads.js';
import { paperRoutes } from './routes/papers.js';

export interface AppDeps {
  env: Env;
  pool: Pool;
  log?: Logger;
  auth?: Auth;
}

export interface BuiltApp {
  app: Express;
  auth: Auth;
  log: Logger;
}

/**
 * Builds the Express app. A factory rather than a module-level singleton so the
 * tests can hand it a throwaway database and a silent logger.
 *
 * Middleware order matters in two places and both are load-bearing:
 *  1. the Razorpay webhook needs the raw body, so its express.raw() is mounted
 *     inside its own router, ahead of any JSON parsing;
 *  2. Better Auth's handler is mounted before express.json(), because it reads
 *     the request stream itself.
 */
export function createApp({ env, pool, log, auth }: AppDeps): BuiltApp {
  const logger = log ?? createLogger(env.LOG_LEVEL);
  // The logger goes in so password-reset mail failures land in the same
  // stream as everything else rather than on bare stdout.
  const authInstance = auth ?? createAuth(env, pool, logger);
  const app = express();

  app.disable('x-powered-by');
  // A hop count, never `true`: trusting every hop lets any client forge
  // X-Forwarded-For and defeat both the rate limiter and the IP-change signal.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(
    pinoHttp({
      logger: logger as never,
      // The sync endpoint runs 1.2M times. Logging each at info would bury
      // everything that matters, so successful syncs log at debug.
      customLogLevel: (_req: { url?: string }, res: { statusCode: number }, err?: unknown) => {
        // The host polls /health and /ready every few seconds for the life of
        // the service. Logging those buries everything else -- a failing
        // readiness check wrote a stack trace every ten seconds and made the
        // log unreadable at exactly the moment someone needed to read it.
        // Whatever the check is reporting is logged by the check itself.
        if (_req.url === '/health' || _req.url === '/ready') return 'silent';
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        if (_req.url?.includes('/attempt/sync')) return 'debug';
        return 'info';
      },
      // Never serialise request bodies: they contain answers.
      serializers: {
        req: (req: { method?: string; url?: string; id?: unknown }) => ({
          method: req.method,
          url: req.url,
          id: req.id,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && env.CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Liveness and readiness. Railway polls these; the readiness probe touches
  // the database because an API that cannot reach Postgres is not ready.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, serverTime: Date.now() });
  });
  /**
   * Ready means "this build can serve requests against this database", which
   * is more than "Postgres answered".
   *
   * `SELECT 1` alone passed while the schema was missing the tables this code
   * queries -- deploying code whose migration had not been run left the service
   * green on the dashboard and 500ing on the admin portal, which is the worst
   * combination: nothing alerts, and the failure surfaces as a vague error in
   * front of whoever opened the page.
   *
   * So it compares the migration files shipped in this build against the rows
   * in schema_migrations, and reports 503 with the names of any that have not
   * been applied. That turns "the dashboard is broken" into "008 has not run
   * here", which is a thing someone can act on.
   */
  app.get('/ready', async (_req, res) => {
    try {
      const [shipped, applied] = await Promise.all([
        listMigrations(),
        pool
          .query<{ name: string }>('SELECT name FROM schema_migrations')
          .then((result) => result.rows.map((row) => row.name))
          // No table at all means nothing has ever been migrated, which is a
          // pending list rather than an error to swallow.
          .catch(() => [] as string[]),
      ]);

      /*
       * A pending migration is reported, not failed.
       *
       * This used to answer 503, which was too strong by a long way: Render
       * reads /ready as its health check, so an unapplied migration took the
       * whole service out of rotation — no sign-in, no admin, no exam — while
       * the process was running happily and able to serve every route that did
       * not touch the new columns. It also logged at error once every ten
       * seconds, which buries anything genuinely wrong.
       *
       * Ready means "this process can serve requests". It can. The pending
       * list is a fact worth carrying in the response, and the one place that
       * must act on it is a deploy check, not a load balancer.
       *
       * The thing this was written to catch — code deployed ahead of its
       * migration — is still caught: the names are right here in the body, and
       * the pages that need those columns say so themselves.
       */
      const pending = shipped.filter((name) => !applied.includes(name));
      if (pending.length > 0) {
        // warn, not error: it is a state to fix, not an incident. Logged once
        // per check is still noisy, so it says what to do rather than repeating
        // a bare complaint.
        logger.warn(
          { pending },
          'database is behind this build; run the migrations (packages/db: pnpm migrate)',
        );
      }

      res.json({
        ok: true,
        migrations: applied.length,
        ...(pending.length > 0 ? { pendingMigrations: pending } : {}),
      });
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'readiness check failed',
      );
      res.status(503).json({ ok: false, reason: 'database_unreachable' });
    }
  });

  // Better Auth owns /auth/*. Express 5 requires a named wildcard.
  app.all('/auth/*splat', toNodeHandler(authInstance));

  // Payments mount first: the webhook route needs the raw body, so it must not
  // sit behind the JSON parser below.
  app.use('/payments', paymentRoutes({ pool, auth: authInstance, env, log: logger }));

  // 256 KB ceiling. Full state for 75 answers is ~10 KB on the wire; without
  // this limit one client can hand the process an arbitrary amount of memory.
  app.use(express.json({ limit: LIMITS.jsonBodyLimit }));

  app.use(
    '/auth',
    createRateLimiter({
      windowMs: 60_000,
      max: LIMITS.authPerMinute,
      // Not req.ip: with a proxy in front, a wrong hop count makes that the
      // proxy's address and puts every user in one bucket. See clientKey.
      key: clientKey,
      message: 'Too many sign-in attempts from this network. Wait a minute and try again.',
    }),
  );

  // Public, unauthenticated, cacheable: the encrypted paper and the question
  // figures. Mounted before the authenticated routers because none of it needs
  // a session — see routes/papers.ts for why that is safe.
  app.use('/papers', paperRoutes({ pool }));

  app.use('/test', statusRoutes({ pool, auth: authInstance }));
  app.use('/profile', profileRoutes({ pool, auth: authInstance, log: logger }));
  app.use('/attempt', attemptRoutes({ pool, auth: authInstance, log: logger }));
  // The admin surface, in four routers rather than one.
  //
  // adminRoutes is the event console — live sync health, the review queue,
  // going live — and is the only one of the four that is read during the test.
  // The others are the business portal: they run arbitrary filtered scans over
  // every student, and keeping them on separate routers means a slow CRM query
  // is never mounted on the path the event dashboard polls.
  //
  // Order matters. adminTestRoutes owns /admin/tests/* and adminCrmRoutes owns
  // /admin/leads/*, so neither can shadow the other; the uploads router is
  // mounted deeper still.
  // A student's own result. Checks tests.results_released_at before it returns
  // a single mark, so scoring can run the moment the paper closes without
  // anything being visible until the announcement.
  app.use('/results', resultRoutes({ pool, auth: authInstance }));

  app.use('/admin', adminRoutes({ pool, auth: authInstance, log: logger }));
  app.use('/admin', adminResultRoutes({ pool, auth: authInstance, log: logger }));
  app.use('/admin', adminTestRoutes({ pool, auth: authInstance, log: logger }));
  app.use('/admin', adminCrmRoutes({ pool, auth: authInstance }));
  app.use('/admin/coupons', adminCouponRoutes({ pool, auth: authInstance }));
  app.use('/admin/uploads', adminUploadRoutes({ pool, auth: authInstance }));

  app.post(
    '/admin-bootstrap/setup',
    createRateLimiter({
      windowMs: 60_000,
      max: 5,
      key: (req) => req.ip ?? 'unknown',
      message: 'Too many setup attempts. Try again in a minute.',
    }),
  );
  app.use('/admin-bootstrap', adminBootstrapRoutes({ pool, auth: authInstance, env, log: logger }));

  // Mounted on its own prefix, NOT under /admin, because one of its routes has
  // to stay reachable by an admin that requireAdmin is currently refusing --
  // the one that tells them 2FA is why. See routes/admin-security.ts.
  app.use(
    '/admin-security',
    adminSecurityRoutes({ pool, auth: authInstance, log: logger }),
  );

  /**
   * Development only. The encrypted paper is a CDN object in production (D-009)
   * and this route stands in for it locally. The guard is in env.ts: setting
   * SERVE_LOCAL_PAPERS in production refuses to boot.
   */
  if (env.SERVE_LOCAL_PAPERS && env.NODE_ENV !== 'production') {
    const papers = new URL('../../../tools/build-paper/out/', import.meta.url);
    app.use(
      // Not '/papers': that path now serves compiled papers out of the database
      // for every environment, and a static mount on the same prefix would
      // shadow it. This stays for papers built by the CLI, which writes files.
      '/papers-local',
      express.static(papers.pathname, {
        setHeaders: (res) => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=300');
        },
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return { app, auth: authInstance, log: logger };
}
