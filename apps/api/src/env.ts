import { z } from 'zod';
import { TEST_FEE_PAISE } from '@jee/shared';

/**
 * Configuration is validated once at boot and never read from process.env
 * again. A missing secret should stop the process on the deploy before the
 * event, not produce a 500 during it.
 */

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),

  /**
   * Neon's pooled endpoint (`-pooler` host). Every query this service runs is
   * a plain parameterised one, so all of it belongs on the pooler.
   */
  DATABASE_URL: z.string().min(1),
  /** Neon's direct endpoint. Not used at request time; migrations use it. */
  DATABASE_URL_UNPOOLED: z.string().default(''),
  /**
   * Per-process pool size. With PgBouncer in front this is a throughput knob,
   * not the fuse it was when replicas x PG_POOL_MAX had to clear
   * max_connections. It is still logged at boot.
   */
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),

  /** Origins allowed to send credentialed requests. Never '*' with credentials. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((s) => s.trim()).filter(Boolean)),

  /**
   * Number of proxy hops to trust for the client IP. Express's `true` trusts
   * every hop, which lets any client forge X-Forwarded-For and defeat both the
   * rate limiter and the IP-change signal. The edge proxy is one hop.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  /** Entry fee in paise. Defaults to the price the landing page quotes. */
  TEST_FEE_PAISE: z.coerce.number().int().positive().default(TEST_FEE_PAISE),

  /** Serves tools/build-paper/out at /papers. Development only; see app.ts. */
  SERVE_LOCAL_PAPERS: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${issues}`);
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    // These are the failures that are survivable in development and fatal on
    // the day, so they are checked explicitly rather than left to a default.
    //
    // Postgres is now reached over the public internet, so an unverified
    // certificate is not a cosmetic warning: it is encryption against nobody.
    if (source.PGSSL_NO_VERIFY === 'true') {
      throw new Error('PGSSL_NO_VERIFY must not be set in production');
    }
    if (env.CORS_ORIGINS.length === 0) {
      throw new Error('CORS_ORIGINS must be set in production');
    }
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET must be set in production');
    }
    // The site takes payments from the day it is deployed, weeks before the
    // paper opens. Missing keys here are a 500 on the one page that has to
    // work, so they stop the boot instead.
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in production');
    }
    if (env.SERVE_LOCAL_PAPERS) {
      throw new Error('SERVE_LOCAL_PAPERS must be false in production — the CDN serves papers');
    }
  }

  return env;
}
