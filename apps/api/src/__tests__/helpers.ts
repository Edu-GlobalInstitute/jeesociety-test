import request from 'supertest';
import type { Express } from 'express';
import { pino } from 'pino';
import { createTestDatabase, type TestDb } from '@jee/db/testing';
import { createApp } from '../app.js';
import { loadEnv, type Env } from '../env.js';

/**
 * Boots the real app — real Better Auth, real routes, real Postgres — against a
 * throwaway database. Sessions are obtained by signing up through the actual
 * auth endpoint, so these tests exercise the same path a student does.
 */

export interface TestApi {
  app: Express;
  db: TestDb;
  env: Env;
  close: () => Promise<void>;
}

export async function createTestApi(label: string): Promise<TestApi> {
  const db = await createTestDatabase(label);
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    BETTER_AUTH_SECRET: 'test-secret-that-is-definitely-long-enough',
    BETTER_AUTH_URL: 'http://localhost:3000',
    CORS_ORIGINS: 'http://localhost:5173',
    RAZORPAY_WEBHOOK_SECRET: 'whsec_test',
    LOG_LEVEL: 'silent',
    TRUST_PROXY_HOPS: '1',
  });

  const { app } = createApp({ env, pool: db.pool, log: pino({ level: 'silent' }) });
  return { app, db, env, close: () => db.drop() };
}

export interface Student {
  cookie: string;
  userId: string;
  email: string;
}

/** Signs a student up through /auth and returns their session cookie. */
export async function signUp(api: TestApi, email?: string): Promise<Student> {
  const address = email ?? `s${Math.random().toString(36).slice(2, 10)}@example.org`;
  const response = await request(api.app)
    .post('/auth/sign-up/email')
    .send({ email: address, password: 'correct horse battery', name: 'Test Student' });

  if (response.status >= 400) {
    throw new Error(`sign-up failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = cookies.map((value: string) => value.split(';')[0]).join('; ');

  const user = await api.db.pool.query<{ id: string }>(
    `SELECT "id" FROM "user" WHERE "email" = $1`,
    [address],
  );
  return { cookie, userId: user.rows[0]!.id, email: address };
}

export async function makeAdmin(api: TestApi, student: Student): Promise<void> {
  await api.db.pool.query(`INSERT INTO admins (user_id) VALUES ($1)`, [student.userId]);
}

export interface TestWindow {
  startsInMinutes?: number;
  durationMinutes?: number;
}

/** Creates the test row, with the secrets a real event would carry. */
export async function createTest(
  api: TestApi,
  window: TestWindow = {},
): Promise<{ testId: number; answerKey: Record<string, string>; paperKey: string }> {
  const { samplePaper } = await import('@jee/db/sample');
  const { generatePaperKey } = await import('@jee/shared');

  const startsInMinutes = window.startsInMinutes ?? -10;
  const startsAt = new Date(Date.now() + startsInMinutes * 60_000);
  const endsAt = new Date(startsAt.getTime() + (window.durationMinutes ?? 180) * 60_000);
  const lobbyOpensAt = new Date(startsAt.getTime() - 30 * 60_000);

  const created = await api.db.pool.query<{ id: number }>(
    `INSERT INTO tests (name, starts_at, ends_at, lobby_opens_at, status)
          VALUES ('API Test', $1, $2, $3, 'live') RETURNING id`,
    [startsAt, endsAt, lobbyOpensAt],
  );
  const testId = created.rows[0]!.id;

  const { answerKey } = samplePaper(testId);
  const paperKey = generatePaperKey();
  await api.db.pool.query(
    `UPDATE tests SET paper_url = $2, paper_key = $3, answer_key = $4
      WHERE id = $1`,
    [
      testId,
      `https://cdn.example.org/paper-${testId}.json`,
      paperKey,
      JSON.stringify(answerKey),
    ],
  );
  return { testId, answerKey, paperKey };
}

export async function markPaid(api: TestApi, student: Student, testId: number): Promise<void> {
  await api.db.pool.query(
    `INSERT INTO payments (user_id, test_id, razorpay_order_id, razorpay_payment_id, amount, status)
          VALUES ($1, $2, $3, $4, 50000, 'paid')`,
    [student.userId, testId, `order_${student.userId}`, `pay_${student.userId}`],
  );
}

/** Registers and starts an attempt the way the lobby and start instant do. */
export async function startAttempt(
  api: TestApi,
  student: Student,
  testId: number,
): Promise<string> {
  const attempt = await api.db.pool.query<{ id: string }>(
    `INSERT INTO attempts (user_id, test_id, status, key_issued_at)
          VALUES ($1, $2, 'in_progress', now()) RETURNING id`,
    [student.userId, testId],
  );
  return attempt.rows[0]!.id;
}

export { request };
