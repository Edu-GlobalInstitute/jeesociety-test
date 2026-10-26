import pg from 'pg';
import { migrate } from './migrate.js';
import { isPooledConnectionString } from './pool.js';
import { samplePaper } from './samplePaper.js';
import { generatePaperKey } from '@jee/shared';

/**
 * Test harness. Each test file gets its own freshly migrated database, so the
 * suites can run in parallel and no test can see another's rows.
 *
 * These tests run against a real Postgres rather than a mock on purpose: the
 * behaviour under test is `revision <` guarding, `FOR UPDATE SKIP LOCKED` and
 * ON CONFLICT semantics, none of which a mock would reproduce and all of which
 * the event depends on.
 *
 *   docker compose up -d postgres
 */

export const ADMIN_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://jee:jee@localhost:5433/jee';

/**
 * The suite creates and drops whole databases, so it must never run against
 * the Neon branch that holds the event. A DATABASE_URL left in the shell is
 * the obvious way for that to happen, so pointing at neon.tech is refused
 * unless TEST_DATABASE_URL says so deliberately — and the pooled endpoint is
 * refused outright, since CREATE DATABASE and pg_terminate_backend are
 * session work PgBouncer cannot carry.
 */
function assertSafeAdminUrl(url: string): void {
  if (isPooledConnectionString(url)) {
    throw new Error(
      'test databases cannot be created through Neon\'s pooled endpoint — ' +
        'point TEST_DATABASE_URL at the local docker Postgres (pnpm db:up)',
    );
  }
  if (/\.neon\.tech/i.test(url) && !process.env.TEST_DATABASE_URL) {
    throw new Error(
      'refusing to create test databases on Neon from DATABASE_URL — ' +
        'run `pnpm db:up` and set TEST_DATABASE_URL=postgres://jee:jee@localhost:5433/jee',
    );
  }
}

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

export interface TestDb {
  pool: pg.Pool;
  name: string;
  drop: () => Promise<void>;
}

export async function createTestDatabase(label: string): Promise<TestDb> {
  const name = `jee_test_${label}_${Date.now().toString(36)}${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`.toLowerCase();

  assertSafeAdminUrl(ADMIN_URL);

  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: urlFor(name), max: 8 });
  await migrate(pool);

  return {
    pool,
    name,
    drop: async () => {
      await pool.end();
      const cleanup = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
      try {
        await cleanup.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [name],
        );
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export interface Fixture {
  testId: number;
  userId: string;
  attemptId: string;
  /** The ids of the integer-answer questions, for tests that need a typed value. */
  integerIds: string[];
  answerKey: Record<string, string>;
}

export interface FixtureOptions {
  /** Minutes from now. Negative means the window has already opened/closed. */
  startsInMinutes?: number;
  durationMinutes?: number;
  email?: string;
  /** Whether to create the attempt row, and in which state. */
  attemptStatus?: 'registered' | 'in_progress' | null;
}

/** Creates a test, a user, a paid payment and (by default) a started attempt. */
export async function seedFixture(
  db: pg.Pool,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const startsInMinutes = options.startsInMinutes ?? -10;
  const durationMinutes = options.durationMinutes ?? 180;
  const startsAt = new Date(Date.now() + startsInMinutes * 60_000);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const lobbyOpensAt = new Date(startsAt.getTime() - 30 * 60_000);

  const test = await db.query<{ id: number }>(
    `INSERT INTO tests (name, starts_at, ends_at, lobby_opens_at, status)
          VALUES ('fixture', $1, $2, $3, 'live') RETURNING id`,
    [startsAt, endsAt, lobbyOpensAt],
  );
  const testId = test.rows[0]!.id;

  const { paper, answerKey } = samplePaper(testId);
  await db.query(
    `UPDATE tests SET paper_url = $2, paper_key = $3, answer_key = $4
      WHERE id = $1`,
    [
      testId,
      `https://cdn.example.org/paper-${testId}.json`,
      generatePaperKey(),
      JSON.stringify(answerKey),
    ],
  );

  const email = options.email ?? `student-${Math.random().toString(36).slice(2)}@example.org`;
  const userId = `u_${Math.random().toString(36).slice(2, 12)}`;
  await db.query(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified")
          VALUES ($1, 'Fixture Student', $2, true)`,
    [userId, email],
  );
  await db.query(
    `INSERT INTO payments (user_id, test_id, razorpay_order_id, razorpay_payment_id, amount, status)
          VALUES ($1, $2, $3, $4, 50000, 'paid')`,
    [userId, testId, `order_${userId}`, `pay_${userId}`],
  );

  let attemptId = '';
  const attemptStatus = options.attemptStatus === undefined ? 'in_progress' : options.attemptStatus;
  if (attemptStatus) {
    const attempt = await db.query<{ id: string }>(
      `INSERT INTO attempts (user_id, test_id, status, key_issued_at)
            VALUES ($1, $2, $3, CASE WHEN $3 = 'in_progress' THEN now() ELSE NULL END)
         RETURNING id`,
      [userId, testId, attemptStatus],
    );
    attemptId = attempt.rows[0]!.id;
  }

  return {
    testId,
    userId,
    attemptId,
    integerIds: paper.questions.filter((q) => q.kind === 'integer').map((q) => q.id),
    answerKey,
  };
}

/** Adds another student to an existing test. */
export async function seedStudent(
  db: pg.Pool,
  testId: number,
  status: 'registered' | 'in_progress' = 'in_progress',
): Promise<{ userId: string; attemptId: string }> {
  const userId = `u_${Math.random().toString(36).slice(2, 12)}`;
  await db.query(
    `INSERT INTO "user" ("id", "name", "email") VALUES ($1, 'Student', $2)`,
    [userId, `${userId}@example.org`],
  );
  const attempt = await db.query<{ id: string }>(
    `INSERT INTO attempts (user_id, test_id, status, key_issued_at)
          VALUES ($1, $2, $3, CASE WHEN $3 = 'in_progress' THEN now() ELSE NULL END)
       RETURNING id`,
    [userId, testId, status],
  );
  return { userId, attemptId: attempt.rows[0]!.id };
}
