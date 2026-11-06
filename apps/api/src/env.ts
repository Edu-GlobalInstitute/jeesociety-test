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
  /** One-time setup code for the single bootstrap admin. Keep empty after setup. */
  ADMIN_BOOTSTRAP_SECRET: z
    .string()
    .default('')
    .refine((value) => value.length === 0 || value.length >= 32, 'ADMIN_BOOTSTRAP_SECRET must be at least 32 characters'),

  /**
   * The site's own origin. Must be one of CORS_ORIGINS; checked at boot,
   * because anything that redirects a signed-in student reads this, and a wrong
   * value sends them to someone else's site carrying a fresh session.
   */
  WEB_ORIGIN: z.string().url().default('http://localhost:3001'),

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

  /**
   * Resend, for the one email the site sends: a password reset link.
   *
   * Both default to empty and the API boots without them, deliberately. A
   * missing key must not take the site down three weeks before the paper --
   * sign-in, registration and payment all work without email. What it costs
   * is self-service password reset, which degrades to "write to us" on the
   * login page rather than to an error.
   *
   * MAIL_FROM must be an address at a domain verified in the Resend
   * dashboard. Resend rejects anything else, so a wrong value here fails at
   * send time with a clear message rather than silently dropping mail.
   */
  RESEND_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().default('JEE Society <noreply@jeesociety.in>'),

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
    // An open redirect that hands over a live session. The allowlist is the
    // same one CORS uses, so there is one list to get right rather than two.
    if (!env.CORS_ORIGINS.includes(env.WEB_ORIGIN)) {
      throw new Error('WEB_ORIGIN must be one of CORS_ORIGINS');
    }
    /*
     * The price the server charges must be the price the site quotes.
     *
     * Every page derives its figure from TEST_FEE_PAISE in @jee/shared at build
     * time, while the API reads it from the environment at boot. An override
     * left in the dashboard from an earlier price therefore charges one amount
     * while every page advertises another, and nothing on the site reveals it —
     * the student sees the discrepancy only on Razorpay's own screen, after
     * deciding to pay.
     *
     * This ignores the override rather than refusing to boot.
     *
     * It used to throw, which was the wrong severity: a stale variable in a
     * dashboard took the entire site down -- no sign-in, no admin, no exam --
     * over a mismatch whose correct resolution is obviously "charge what the
     * pages say". Refusing to start also hid itself, because the process died
     * before binding a port and the host reported a port problem.
     *
     * Falling back to the built-in price keeps the one invariant that matters:
     * nobody is ever charged an amount no page shows. The warning is loud
     * enough to find, and a genuine price change is a one-line edit to
     * packages/shared/src/config.ts that the pages and the API then share.
     */
    if (env.TEST_FEE_PAISE !== TEST_FEE_PAISE) {
      process.stderr.write(
        [
          '',
          `  WARNING: TEST_FEE_PAISE is ${env.TEST_FEE_PAISE / 100} rupees in this environment,`,
          `  but every page is built to quote ${TEST_FEE_PAISE / 100} rupees.`,
          `  Ignoring the variable and charging ${TEST_FEE_PAISE / 100} rupees, so no student`,
          '  is charged a price the site does not show.',
          '  Delete the variable, or change TEST_FEE_PAISE in',
          '  packages/shared/src/config.ts and redeploy.',
          '',
        ].join('\n') + '\n',
      );
      env.TEST_FEE_PAISE = TEST_FEE_PAISE;
    }
  }

  return env;
}
