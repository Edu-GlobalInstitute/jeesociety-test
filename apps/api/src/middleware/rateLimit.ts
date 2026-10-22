import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { tooMany } from './errors.js';

/**
 * In-memory fixed-window limiter.
 *
 * Deliberately not Postgres-backed: a counter write on /attempt/sync would add
 * 1.2M writes to the hottest path of the event to defend against a problem that
 * does not exist at this scale. Deliberately not Redis either — a second
 * datastore for a counter is not worth its failure modes (D-008).
 *
 * The consequence of keeping it in memory is that the limit is per replica, so
 * at 4 replicas a user can reach roughly 4x the configured rate. That is fine:
 * the job here is to stop a runaway client from looping, not to meter anyone
 * precisely. A legitimate client syncs once per 90 s; a limit of 2/min leaves
 * room for its retries and still catches a loop.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** What to count by. Defaults to the session user, falling back to the IP. */
  key?: (req: Request) => string;
  message?: string;
}

export function createRateLimiter(options: RateLimiterOptions): RequestHandler & {
  reset: () => void;
} {
  const buckets = new Map<string, Bucket>();
  const keyOf = options.key ?? ((req: Request) => req.user?.id ?? req.ip ?? 'unknown');

  // Fixed windows expire on read; this sweep only stops the map growing without
  // bound across a 3-hour event.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 60_000);
  sweep.unref();

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = keyOf(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      next(
        tooMany(
          options.message ??
            'Too many requests. Your answers are saved; this will clear shortly.',
        ),
      );
      return;
    }
    next();
  };

  return Object.assign(middleware, { reset: () => buckets.clear() });
}
