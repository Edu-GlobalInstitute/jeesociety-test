import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateReceipt, parseReceipt } from '@jee/shared';
import { getAttempt, submitAttempt, syncAttempt } from '../queries/attempts.js';
import { createTestDatabase, seedFixture, type Fixture, type TestDb } from '../testing.js';

/**
 * Submit. One row written, no score computed, no model called — and above all
 * idempotent, because the client retries with backoff and the student may well
 * double-click.
 */

let db: TestDb;
let fixture: Fixture;

beforeAll(async () => {
  db = await createTestDatabase('submit');
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  fixture = await seedFixture(db.pool);
});

const submit = (over: Partial<Parameters<typeof submitAttempt>[0]> = {}) =>
  submitAttempt(
    {
      attemptId: fixture.attemptId,
      userId: fixture.userId,
      revision: 10,
      answers: { q1: 'A', q61: 'final answer' },
      telemetry: {},
      receipt: generateReceipt(fixture.testId),
      ...over,
    },
    db.pool,
  );

const sync = (revision: number, answers: Record<string, string>) =>
  syncAttempt(
    {
      attemptId: fixture.attemptId,
      userId: fixture.userId,
      revision,
      answers,
      telemetry: {},
      ip: null,
    },
    db.pool,
  );

describe('submitAttempt', () => {
  it('finalises the attempt and returns a receipt', async () => {
    const result = await submit();
    expect(result!.alreadySubmitted).toBe(false);
    expect(parseReceipt(result!.receipt)).toMatchObject({
      testId: String(fixture.testId),
      auto: false,
    });

    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.status).toBe('submitted');
    expect(attempt!.answers).toEqual({ q1: 'A', q61: 'final answer' });
  });

  it('returns the same receipt on a double-click rather than an error', async () => {
    const first = await submit();
    const second = await submit({ receipt: generateReceipt(fixture.testId) });

    expect(second!.alreadySubmitted).toBe(true);
    expect(second!.receipt).toBe(first!.receipt);
    expect(second!.submittedAt).toEqual(first!.submittedAt);
  });

  it('is idempotent under concurrent retries', async () => {
    // The client retries with backoff; an earlier request may still be in
    // flight. Five of these must produce one submission and one receipt.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => submit({ receipt: generateReceipt(fixture.testId) })),
    );

    const receipts = new Set(results.map((r) => r!.receipt));
    expect(receipts.size).toBe(1);
    expect(results.filter((r) => !r!.alreadySubmitted)).toHaveLength(1);

    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect([...receipts][0]).toBe(attempt!.receipt);
  });

  it('accepts a submit carrying the state the server already holds', async () => {
    await sync(10, { q1: 'A' });
    const result = await submit({ revision: 10, answers: { q1: 'A' } });
    expect(result!.alreadySubmitted).toBe(false);
    expect((await getAttempt(fixture.attemptId, db.pool))!.status).toBe('submitted');
  });

  it('finalises rather than regressing when the client is behind the server', async () => {
    // A second tab synced revision 20; this tab submits its stale revision 5.
    // Overwriting with the stale copy would lose work, so the server keeps what
    // it has and still closes the attempt.
    await sync(20, { q1: 'newest from the other tab' });
    const result = await submit({ revision: 5, answers: { q1: 'stale' } });

    expect(result!.alreadySubmitted).toBe(false);
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.answers).toEqual({ q1: 'newest from the other tab' });
    expect(attempt!.revision).toBe(20);
    expect(attempt!.status).toBe('submitted');
  });

  it('never lowers the stored revision', async () => {
    await sync(30, { q1: 'A' });
    await submit({ revision: 31, answers: { q1: 'B' } });
    expect((await getAttempt(fixture.attemptId, db.pool))!.revision).toBe(31);
  });

  it('refuses a submit for another user\'s attempt', async () => {
    expect(await submit({ userId: 'not-the-owner' })).toBeNull();
    expect((await getAttempt(fixture.attemptId, db.pool))!.submitted_at).toBeNull();
  });

  it('returns null for an attempt that does not exist', async () => {
    expect(
      await submit({ attemptId: '00000000-0000-0000-0000-000000000000' }),
    ).toBeNull();
  });

  it('computes no score', async () => {
    await submit();
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.mcq_score).toBeNull();
    expect(attempt!.subjective_score).toBeNull();
    expect(attempt!.total_score).toBeNull();
  });

  it('writes no grading jobs — grading is enqueued separately', async () => {
    await submit();
    const jobs = await db.pool.query(`SELECT count(*) AS n FROM grading_jobs`);
    expect(Number(jobs.rows[0]!.n)).toBe(0);
  });

  it('keeps receipts unique across the cohort', async () => {
    const other = await seedFixture(db.pool);
    await submit();
    await submitAttempt(
      {
        attemptId: other.attemptId,
        userId: other.userId,
        revision: 1,
        answers: {},
        telemetry: {},
        receipt: generateReceipt(other.testId),
      },
      db.pool,
    );
    const distinct = await db.pool.query(
      `SELECT count(*) AS total, count(DISTINCT receipt) AS distinct FROM attempts
        WHERE receipt IS NOT NULL`,
    );
    expect(distinct.rows[0]!.total).toBe(distinct.rows[0]!.distinct);
  });
});
