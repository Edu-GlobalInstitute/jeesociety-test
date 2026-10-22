import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { MCQ_MARKS } from '@jee/shared';
import { attempts, jobs } from '@jee/db';
import { createTestDatabase, seedFixture, seedStudent, type TestDb } from '@jee/db/testing';
import { runMcqScoring } from '../jobs/mcqScore.js';
import { runAutoSubmit } from '../jobs/autoSubmit.js';
import { runComputeFlags } from '../jobs/computeFlags.js';
import { ensureScheduled, runScheduler } from '../scheduler.js';

const log = pino({ level: 'silent' });
let db: TestDb;

beforeAll(async () => {
  db = await createTestDatabase('workerjobs');
});
afterAll(async () => {
  await db.drop();
});

describe('runMcqScoring', () => {
  it('scores submitted attempts against the server-held key', async () => {
    const fixture = await seedFixture(db.pool);
    // 10 right, 5 wrong, the rest unattempted.
    const answers: Record<string, string> = {};
    const keys = Object.keys(fixture.answerKey).slice(0, 15);
    keys.forEach((questionId, index) => {
      answers[questionId] =
        index < 10 ? fixture.answerKey[questionId]! : 'Z';
    });
    await db.pool.query(
      `UPDATE attempts SET answers = $2, submitted_at = now(), status = 'submitted'
        WHERE id = $1`,
      [fixture.attemptId, JSON.stringify(answers)],
    );

    const result = await runMcqScoring(fixture.testId, db.pool, log);
    expect(result).toMatchObject({ scored: 1, totalCorrect: 10, totalWrong: 5 });

    const attempt = await attempts.getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.mcq_score).toBe(10 * MCQ_MARKS.correct + 5 * MCQ_MARKS.wrong);
  });

  it('skips attempts that were never submitted', async () => {
    const fixture = await seedFixture(db.pool);
    const result = await runMcqScoring(fixture.testId, db.pool, log);
    expect(result.scored).toBe(0);
    expect((await attempts.getAttempt(fixture.attemptId, db.pool))!.mcq_score).toBeNull();
  });

  it('is deterministic, so a crashed pass can simply be re-run', async () => {
    const fixture = await seedFixture(db.pool);
    await db.pool.query(
      `UPDATE attempts SET answers = $2, submitted_at = now(), status = 'submitted'
        WHERE id = $1`,
      [fixture.attemptId, JSON.stringify({ q1: fixture.answerKey.q1 })],
    );

    const first = await runMcqScoring(fixture.testId, db.pool, log);
    const scoreAfterFirst = (await attempts.getAttempt(fixture.attemptId, db.pool))!.mcq_score;
    const second = await runMcqScoring(fixture.testId, db.pool, log);
    expect(second.scored).toBe(first.scored);
    expect((await attempts.getAttempt(fixture.attemptId, db.pool))!.mcq_score).toBe(
      scoreAfterFirst,
    );
  });

  it('refuses to score a test with no answer key rather than zeroing everyone', async () => {
    const fixture = await seedFixture(db.pool);
    await db.pool.query(`UPDATE tests SET answer_key = NULL WHERE id = $1`, [fixture.testId]);
    await expect(runMcqScoring(fixture.testId, db.pool, log)).rejects.toThrow(/answer key/);
  });

  it('handles a cohort larger than one batch', async () => {
    const fixture = await seedFixture(db.pool);
    for (let i = 0; i < 20; i += 1) await seedStudent(db.pool, fixture.testId);
    await db.pool.query(
      `UPDATE attempts SET answers = $2, submitted_at = now(), status = 'submitted'
        WHERE test_id = $1`,
      [fixture.testId, JSON.stringify({ q1: fixture.answerKey.q1 })],
    );

    const result = await runMcqScoring(fixture.testId, db.pool, log, 5);
    expect(result.scored).toBe(21);
  });
});

describe('runAutoSubmit', () => {
  it('finalises the cohort and closes the test', async () => {
    const fixture = await seedFixture(db.pool);
    for (let i = 0; i < 4; i += 1) await seedStudent(db.pool, fixture.testId);

    const result = await runAutoSubmit(fixture.testId, db.pool, log);
    expect(result.autoSubmitted).toBe(5);

    const { rows } = await db.pool.query<{ status: string }>(
      `SELECT status FROM tests WHERE id = $1`,
      [fixture.testId],
    );
    expect(rows[0]!.status).toBe('closed');
  });
});

describe('runComputeFlags', () => {
  it('flags a burst from the growth curve, with readable evidence', async () => {
    const fixture = await seedFixture(db.pool);
    await attempts.recordSnapshot(fixture.attemptId, 1, { q61: 0 }, '203.0.113.1', db.pool);
    await attempts.recordSnapshot(fixture.attemptId, 2, { q61: 800 }, '203.0.113.1', db.pool);

    const result = await runComputeFlags(fixture.testId, db.pool, log);
    expect(result.flagged).toBe(1);

    const attempt = await attempts.getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.needs_review).toBe(true);
    const burst = attempt!.flags.find((f) => f.code === 'burst_appearance');
    expect(burst!.evidence).toMatchObject({ from: 0, to: 800 });
    expect(burst!.evidence).toHaveProperty('fromAt');
  });

  it('leaves a steadily written answer alone', async () => {
    const fixture = await seedFixture(db.pool);
    for (const [revision, length] of [[1, 0], [2, 120], [3, 310], [4, 480]] as const) {
      await attempts.recordSnapshot(fixture.attemptId, revision, { q61: length }, null, db.pool);
    }
    await db.pool.query(
      `UPDATE attempts SET answers = $2, telemetry = $3 WHERE id = $1`,
      [
        fixture.attemptId,
        JSON.stringify({ q61: 'x'.repeat(480) }),
        JSON.stringify({ q61: { keystrokes: 520, pastes: 0, pastedChars: 0 } }),
      ],
    );

    const result = await runComputeFlags(fixture.testId, db.pool, log);
    expect(result.flagged).toBe(0);
    expect((await attempts.getAttempt(fixture.attemptId, db.pool))!.needs_review).toBe(false);
  });

  it('never changes a score', async () => {
    const fixture = await seedFixture(db.pool);
    await db.pool.query(
      `UPDATE attempts SET mcq_score = 120, total_score = 120 WHERE id = $1`,
      [fixture.attemptId],
    );
    await attempts.recordSnapshot(fixture.attemptId, 1, { q61: 0 }, null, db.pool);
    await attempts.recordSnapshot(fixture.attemptId, 2, { q61: 900 }, null, db.pool);

    await runComputeFlags(fixture.testId, db.pool, log);

    const attempt = await attempts.getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.needs_review).toBe(true);
    // The whole point: evidence gathered, score untouched.
    expect(attempt!.mcq_score).toBe(120);
    expect(attempt!.total_score).toBe(120);
  });

  it('is idempotent across re-runs', async () => {
    const fixture = await seedFixture(db.pool);
    await attempts.recordSnapshot(fixture.attemptId, 1, { q61: 0 }, null, db.pool);
    await attempts.recordSnapshot(fixture.attemptId, 2, { q61: 900 }, null, db.pool);

    await runComputeFlags(fixture.testId, db.pool, log);
    const after1 = (await attempts.getAttempt(fixture.attemptId, db.pool))!.flags.length;
    await runComputeFlags(fixture.testId, db.pool, log);
    const after2 = (await attempts.getAttempt(fixture.attemptId, db.pool))!.flags.length;
    expect(after2).toBe(after1);
  });
});

describe('scheduler', () => {
  it('schedules auto-submit once, 10 minutes after the window closes', async () => {
    const fixture = await seedFixture(db.pool, { startsInMinutes: -170 });
    await ensureScheduled(db.pool, log);
    await ensureScheduled(db.pool, log);

    const runs = await jobs.listJobRuns(fixture.testId, db.pool);
    const autoSubmit = runs.filter((r) => r.job === 'auto_submit');
    expect(autoSubmit).toHaveLength(1);

    const { rows } = await db.pool.query<{ ends_at: Date }>(
      `SELECT ends_at FROM tests WHERE id = $1`,
      [fixture.testId],
    );
    expect(autoSubmit[0]!.run_after.getTime()).toBe(
      rows[0]!.ends_at.getTime() + 10 * 60_000,
    );
  });

  it('runs a due job and records its result', async () => {
    const fixture = await seedFixture(db.pool, { startsInMinutes: -200, durationMinutes: 180 });
    await jobs.requeueJob('auto_submit', fixture.testId, db.pool);

    let running = true;
    const loop = runScheduler({ pool: db.pool, log, isRunning: () => running, pollIntervalMs: 20 });
    const started = Date.now();
    while (Date.now() - started < 4_000) {
      const runs = await jobs.listJobRuns(fixture.testId, db.pool);
      if (runs.some((r) => r.job === 'auto_submit' && r.status === 'done')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    running = false;
    await loop;

    const runs = await jobs.listJobRuns(fixture.testId, db.pool);
    const run = runs.find((r) => r.job === 'auto_submit')!;
    expect(run.status).toBe('done');
    expect(run.result).toMatchObject({ autoSubmitted: 1 });
  });

  it('records the error and retries a job that throws', async () => {
    const fixture = await seedFixture(db.pool);
    // No answer key, so MCQ scoring refuses rather than zeroing the cohort.
    await db.pool.query(`UPDATE tests SET answer_key = NULL WHERE id = $1`, [fixture.testId]);
    await jobs.requeueJob('mcq_score', fixture.testId, db.pool);

    let running = true;
    const loop = runScheduler({ pool: db.pool, log, isRunning: () => running, pollIntervalMs: 20 });
    const started = Date.now();
    while (Date.now() - started < 4_000) {
      const runs = await jobs.listJobRuns(fixture.testId, db.pool);
      if (runs.some((r) => r.job === 'mcq_score' && r.error)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    running = false;
    await loop;

    const run = (await jobs.listJobRuns(fixture.testId, db.pool)).find(
      (r) => r.job === 'mcq_score',
    )!;
    expect(run.error).toMatch(/answer key/);
    // Back to pending for another go, not silently lost.
    expect(['pending', 'failed']).toContain(run.status);
  });
});
