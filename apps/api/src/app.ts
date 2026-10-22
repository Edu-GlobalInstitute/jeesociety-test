import express, { type Express } from 'express';
import { toNodeHandler } from 'better-auth/node';
import { pinoHttp } from 'pino-http';
import { LIMITS } from '@jee/shared';
import type { Pool } from '@jee/db';
import { createAuth, type Auth } from './auth.js';
import type { Env } from './env.js';
import { createLogger, type Logger } from './logger.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { attemptRoutes } from './routes/attempt.js';
import { statusRoutes } from './routes/status.js';
import { paymentRoutes } from './routes/payments.js';
import { adminRoutes } from './routes/admin.js';

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
  const authInstance = auth ?? createAuth(env, pool);
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
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
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
      key: (req) => req.ip ?? 'unknown',
      message: 'Too many attempts. Try again in a minute.',
    }),
  );

  app.use('/test', statusRoutes({ pool, auth: authInstance }));
  app.use('/attempt', attemptRoutes({ pool, auth: authInstance, log: logger }));
  app.use('/admin', adminRoutes({ pool, auth: authInstance, log: logger }));

  /**
   * Development only. The encrypted paper is a CDN object in production (D-009)
   * and this route stands in for it locally. The guard is in env.ts: setting
   * SERVE_LOCAL_PAPERS in production refuses to boot.
   */
  if (env.SERVE_LOCAL_PAPERS && env.NODE_ENV !== 'production') {
    const papers = new URL('../../../tools/build-paper/out/', import.meta.url);
    app.use(
      '/papers',
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
