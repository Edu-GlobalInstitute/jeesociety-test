import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseReceipt } from '@jee/shared';
import { autoSubmitAll, reconciliationReport } from '../queries/jobs.js';
import { getAttempt, submitAttempt, syncAttempt } from '../queries/attempts.js';
import {
  createTestDatabase,
  seedFixture,
  seedStudent,
  type TestDb,
} from '../testing.js';

/**
 * Auto-submit is the real safety net, and it is tested before submit because the
 * submit button is only a convenience on top of it. The property that matters:
 * after this runs, no attempt that was ever started is left unfinalised, and
 * every one of them is graded on its last synced answers.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDatabase('autosubmit');
});
afterAll(async () => {
  await db.drop();
});

describe('autoSubmitAll', () => {
  it('finalises a student whose machine died at minute 178', async () => {
    const fixture = await seedFixture(db.pool);
    await syncAttempt(
      {
        attemptId: fixture.attemptId,
        userId: fixture.userId,
        revision: 118,
        answers: { q1: 'A', q61: 'most of an answer' },
        telemetry: {},
        ip: null,
      },
      db.pool,
    );

    // The laptop dies here. No submit ever arrives.
    const result = await autoSubmitAll(fixture.testId, db.pool);
    expect(result.autoSubmitted).toBe(1);

    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.status).toBe('auto_submitted');
    expect(attempt!.submitted_at).toBeInstanceOf(Date);
    // The work survives: the answers finalised are the ones last synced.
    expect(attempt!.answers).toEqual({ q1: 'A', q61: 'most of an answer' });
  });

  it('issues a parseable AUTO receipt', async () => {
    const fixture = await seedFixture(db.pool);
    await autoSubmitAll(fixture.testId, db.pool);
    const attempt = await getAttempt(fixture.attemptId, db.pool);

    const parsed = parseReceipt(attempt!.receipt!);
    expect(parsed).toMatchObject({ testId: String(fixture.testId), auto: true });
  });

  it('leaves a manually submitted attempt exactly as it was', async () => {
    const fixture = await seedFixture(db.pool);
    await submitAttempt(
      {
        attemptId: fixture.attemptId,
        userId: fixture.userId,
        revision: 10,
        answers: { q1: 'A' },
        telemetry: {},
        receipt: `JEE-${fixture.testId}-20261025-123456`,
      },
      db.pool,
    );
    const before = await getAttempt(fixture.attemptId, db.pool);

    await autoSubmitAll(fixture.testId, db.pool);

    const after = await getAttempt(fixture.attemptId, db.pool);
    expect(after!.status).toBe('submitted');
    expect(after!.receipt).toBe(before!.receipt);
    expect(after!.submitted_at).toEqual(before!.submitted_at);
  });

  it('does not finalise someone who registered in the lobby but never started', async () => {
    const fixture = await seedFixture(db.pool, { attemptStatus: 'registered' });
    const result = await autoSubmitAll(fixture.testId, db.pool);

    expect(result.autoSubmitted).toBe(0);
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.status).toBe('registered');
    expect(attempt!.receipt).toBeNull();
  });

  it('is a no-op on a second run, so a restarted worker duplicates nothing', async () => {
    const fixture = await seedFixture(db.pool);
    const first = await autoSubmitAll(fixture.testId, db.pool);
    const receipt = (await getAttempt(fixture.attemptId, db.pool))!.receipt;

    const second = await autoSubmitAll(fixture.testId, db.pool);
    expect(first.autoSubmitted).toBe(1);
    expect(second.autoSubmitted).toBe(0);
    expect((await getAttempt(fixture.attemptId, db.pool))!.receipt).toBe(receipt);
  });

  it('finalises a whole cohort in one statement', async () => {
    const fixture = await seedFixture(db.pool);
    for (let i = 0; i < 50; i += 1) await seedStudent(db.pool, fixture.testId);

    const result = await autoSubmitAll(fixture.testId, db.pool);
    expect(result.autoSubmitted).toBe(51);

    const open = await db.pool.query(
      `SELECT count(*) AS n FROM attempts
        WHERE test_id = $1 AND submitted_at IS NULL AND status = 'in_progress'`,
      [fixture.testId],
    );
    expect(Number(open.rows[0]!.n)).toBe(0);
  });

  it('does not touch another test running in the same database', async () => {
    const mine = await seedFixture(db.pool);
    const other = await seedFixture(db.pool);

    await autoSubmitAll(mine.testId, db.pool);

    expect((await getAttempt(other.attemptId, db.pool))!.status).toBe('in_progress');
  });

  it('gives every auto-submitted attempt a distinct receipt', async () => {
    const fixture = await seedFixture(db.pool);
    for (let i = 0; i < 30; i += 1) await seedStudent(db.pool, fixture.testId);
    await autoSubmitAll(fixture.testId, db.pool);

    const receipts = await db.pool.query<{ n: string }>(
      `SELECT count(DISTINCT receipt) AS n FROM attempts WHERE test_id = $1`,
      [fixture.testId],
    );
    expect(Number(receipts.rows[0]!.n)).toBe(31);
  });

  it('races against a submit landing at the same instant without double-finalising', async () => {
    const fixture = await seedFixture(db.pool);
    const [, submitted] = await Promise.all([
      autoSubmitAll(fixture.testId, db.pool),
      submitAttempt(
        {
          attemptId: fixture.attemptId,
          userId: fixture.userId,
          revision: 5,
          answers: { q1: 'A' },
          telemetry: {},
          receipt: `JEE-${fixture.testId}-20261025-999999`,
        },
        db.pool,
      ),
    ]);

    const attempt = await getAttempt(fixture.attemptId, db.pool);
    // Exactly one of the two wins; the student gets one receipt and the one
    // they are shown is the one on the row.
    expect(['submitted', 'auto_submitted']).toContain(attempt!.status);
    expect(attempt!.receipt).toBeTruthy();
    expect(submitted!.receipt).toBe(attempt!.receipt);
  });
});

describe('reconciliationReport', () => {
  it('counts every outcome an operator needs to see', async () => {
    const fixture = await seedFixture(db.pool);
    const manual = await seedStudent(db.pool, fixture.testId);
    const died = await seedStudent(db.pool, fixture.testId);
    const neverStarted = await seedStudent(db.pool, fixture.testId, 'registered');

    await syncAttempt(
      {
        attemptId: died.attemptId,
        userId: died.userId,
        revision: 3,
        answers: { q1: 'A' },
        telemetry: {},
        ip: null,
      },
      db.pool,
    );
    await submitAttempt(
      {
        attemptId: manual.attemptId,
        userId: manual.userId,
        revision: 2,
        answers: { q1: 'B' },
        telemetry: {},
        receipt: `JEE-${fixture.testId}-20261025-111111`,
      },
      db.pool,
    );

    await autoSubmitAll(fixture.testId, db.pool);
    const report = await reconciliationReport(fixture.testId, db.pool);

    expect(report).toMatchObject({
      testId: fixture.testId,
      registered: 4,
      started: 3,
      manuallySubmitted: 1,
      autoSubmitted: 2,
      neverStarted: 1,
    });
    expect(neverStarted.attemptId).toBeTruthy();
  });

  it('counts attempts that started and never answered anything', async () => {
    const fixture = await seedFixture(db.pool);
    await autoSubmitAll(fixture.testId, db.pool);
    const report = await reconciliationReport(fixture.testId, db.pool);
    // An unusually high number here means the paper never rendered for them.
    expect(report.zeroAnswer).toBe(1);
  });

  it('counts attempts whose sync went quiet before the window closed', async () => {
    const fixture = await seedFixture(db.pool);
    // last_sync_at stays null: this student never synced at all.
    const report = await reconciliationReport(fixture.testId, db.pool);
    expect(report.staleAtClose).toBe(1);
  });
});
