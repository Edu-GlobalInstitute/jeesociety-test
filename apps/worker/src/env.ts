import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  PG_POOL_MAX: z.coerce.number().int().positive().default(5),

  /** Which loops this process runs. One process can run all of them. */
  WORKER_JOBS: z
    .string()
    .default('autosubmit,flags,payments,grading')
    .transform((value) => new Set(value.split(',').map((s) => s.trim()).filter(Boolean))),

  GRADING_PROVIDER: z.enum(['anthropic', 'gemini', 'stub']).default('anthropic'),
  GRADING_MODEL: z.string().default('claude-haiku-5-5'),
  ANTHROPIC_API_KEY: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  /** Start at 10 and raise once you have watched for 429s for a while. */
  GRADING_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),

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
  if (env.NODE_ENV === 'production' && env.WORKER_JOBS.has('grading')) {
    const key = env.GRADING_PROVIDER === 'anthropic' ? env.ANTHROPIC_API_KEY : env.GEMINI_API_KEY;
    if (env.GRADING_PROVIDER !== 'stub' && !key) {
      throw new Error(`grading enabled but no API key for provider ${env.GRADING_PROVIDER}`);
    }
  }
  return env;
}
