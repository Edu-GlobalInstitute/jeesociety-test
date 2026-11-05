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

/**
 * The address to count against, which is not always `req.ip`.
 *
 * Express derives req.ip by walking X-Forwarded-For back by the configured
 * number of trusted hops. Get that count wrong and it returns a *proxy's*
 * address — and because every request then shares one address, every user in
 * the country shares one bucket. Ten sign-ins a minute across the whole site,
 * and people who had tried once were told "Too Many Requests".
 *
 * That is exactly what happened when the same-origin proxy was added: the chain
 * became browser → Cloudflare → Render → here, while TRUST_PROXY_HOPS still
 * said one.
 *
 * `cf-connecting-ip` avoids the arithmetic. Cloudflare sets it to the real
 * client and overwrites whatever a client sent, so it cannot be forged through
 * the proxy — and this API is only reachable through it. It is preferred when
 * present, with req.ip as the fallback for any path that does not come that
 * way. A limit keyed on the wrong address is not a safety feature; it is an
 * outage that looks like one.
 */
export function clientKey(req: Request): string {
  const viaCloudflare = req.headers['cf-connecting-ip'];
  if (typeof viaCloudflare === 'string' && viaCloudflare.length > 0) return viaCloudflare;
  return req.ip ?? 'unknown';
}

/**
 * Rate limiting is OFF.
 *
 * Turned off at the owner's instruction on 5 November 2026, during the
 * registration launch. The limiter kept refusing real people: one address is
 * routinely a whole coaching centre or a hostel behind a single NAT, and with
 * marketing driving traffic, legitimate sign-ins from one school were being
 * read as an attack. An admin trying to sign in was shown "Too many requests"
 * repeatedly. A limit that turns away paying students costs more than the
 * abuse it prevents.
 *
 * The limiter itself is kept whole below, and every call site still passes its
 * windows and messages, so this is one line to reverse -- set this to false and
 * the configured limits take effect again exactly as before. That matters for
 * 29 November: /attempt/sync has a 2/min limit whose job is to stop a looping
 * exam client from hammering the API during the paper, which is a different
 * problem from sign-in throttling and worth reconsidering before the event.
 *
 * What still protects these routes with this off:
 *   - the 256 KB JSON body ceiling (app.ts)
 *   - scrypt password hashing, which makes guessing expensive per attempt
 *   - Cloudflare in front of the origin
 */
const RATE_LIMITING_DISABLED = true;

export function createRateLimiter(options: RateLimiterOptions): RequestHandler & {
  reset: () => void;
} {
  if (RATE_LIMITING_DISABLED) {
    const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();
    return Object.assign(passThrough, { reset: () => {} });
  }

  const buckets = new Map<string, Bucket>();
  const keyOf = options.key ?? ((req: Request) => req.user?.id ?? clientKey(req));

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
