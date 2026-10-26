import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  /** Neon's pooled endpoint (`-pooler` host). Everything routine goes here. */
  DATABASE_URL: z.string().min(1),
  /** Neon's direct endpoint. pg_dump and migrations need it; see pool.ts. */
  DATABASE_URL_UNPOOLED: z.string().default(''),
  PG_POOL_MAX: z.coerce.number().int().positive().default(5),

  /** Which loops this process runs. One process can run all of them. */
  WORKER_JOBS: z
    .string()
    .default('autosubmit,flags,payments')
    .transform((value) => new Set(value.split(',').map((s) => s.trim()).filter(Boolean))),

  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),

  BACKUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
  BACKUP_DIR: z.string().default('/tmp/jee-backups'),
  R2_BUCKET: z.string().default(''),
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),

  /** How often the scheduler looks for due one-shot jobs. */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `invalid environment:\n${parsed.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    // Verification off against Neon would make the TLS decorative.
    if (source.PGSSL_NO_VERIFY === 'true') {
      throw new Error('PGSSL_NO_VERIFY must not be set in production');
    }
    // pg_dump cannot run through PgBouncer. Without the direct endpoint the
    // worker would take no backups and only say so in a log line.
    if (
      env.WORKER_JOBS.has('backup') &&
      env.DATABASE_URL.includes('-pooler') &&
      !env.DATABASE_URL_UNPOOLED
    ) {
      throw new Error(
        'DATABASE_URL_UNPOOLED must be set when backups run against Neon — ' +
          'pg_dump cannot use the pooled endpoint',
      );
    }
  }

  return env;
}
