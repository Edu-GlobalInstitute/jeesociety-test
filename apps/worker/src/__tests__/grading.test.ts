import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { AWARD_CAP } from '@jee/shared';
import { grading } from '@jee/db';
import { createTestDatabase, seedFixture, seedStudent, type TestDb } from '@jee/db/testing';
import { runGradingLanes } from '../grading/loop.js';
import { StubGradingProvider, type GradingProvider } from '../grading/provider.js';
import { runEnqueueGrading } from '../jobs/enqueueGrading.js';
import { buildPrompt, feedbackFrom, parseObservation } from '../grading/prompt.js';

const log = pino({ level: 'silent' });
let db: TestDb;

beforeAll(async () => {
  db = await createTestDatabase('grading');
});
afterAll(async () => {
  await db.drop();
});

/** Submits every attempt on a test so the enqueue has something to pick up. */
async function submitAll(testId: number): Promise<void> {
  await db.pool.query(
    `UPDATE attempts
        SET submitted_at = now(), status = 'submitted',
            receipt = 'JEE-' || test_id || '-AUTO-' || substr(id::text, 1, 6),
            answers = $2
      WHERE test_id = $1 AND submitted_at IS NULL`,
    [
      testId,
      JSON.stringify({
        q61: 'Along the incline the net force is mg sin θ, so a = g sin θ = 9.8 sin θ m/s². '.repeat(8),
        q62: '',
      }),
    ],
  );
}

describe('enqueue grading', () => {
  it('creates one job per subjective question per submitted attempt', async () => {
    const fixture = await seedFixture(db.pool);
    for (let i = 0; i < 3; i += 1) await seedStudent(db.pool, fixture.testId);
    await submitAll(fixture.testId);

    const result = await runEnqueueGrading(fixture.testId, db.pool, log);
    expect(result.inserted).toBe(4 * 15);
  });

  it('is safe to re-run after a partial failure', async () => {
    const fixture = await seedFixture(db.pool);
    await submitAll(fixture.testId);

    const first = await runEnqueueGrading(fixture.testId, db.pool, log);
    const second = await runEnqueueGrading(fixture.testId, db.pool, log);
    expect(first.inserted).toBe(15);
    expect(second.inserted).toBe(0);
  });

  it('ignores attempts that were never submitted', async () => {
    const fixture = await seedFixture(db.pool);
    const result = await runEnqueueGrading(fixture.testId, db.pool, log);
    expect(result.inserted).toBe(0);
  });

  it('orders ids by question so the cached rubric prefix hits', async () => {
    const fixture = await seedFixture(db.pool);
    for (let i = 0; i < 3; i += 1) await seedStudent(db.pool, fixture.testId);
    await submitAll(fixture.testId);
    await runEnqueueGrading(fixture.testId, db.pool, log);

    const { rows } = await db.pool.query<{ question_id: string }>(
      `SELECT g.question_id FROM grading_jobs g
         JOIN attempts a ON a.id = g.attempt_id
        WHERE a.test_id = $1 ORDER BY g.id`,
      [fixture.testId],
    );
    // Consecutive ids share a question: 4 attempts, so runs of 4.
    expect(rows.slice(0, 4).map((r) => r.question_id)).toEqual(
      Array(4).fill(rows[0]!.question_id),
    );
  });
});

describe('grading lanes', () => {
  // Lanes claim from the whole queue, as they do in production, so each test
  // starts from an empty one rather than inheriting the previous test's jobs.
  beforeEach(async () => {
    await db.pool.query('TRUNCATE grading_jobs');
  });

  async function drain(provider: GradingProvider, concurrency = 4) {
    // isRunning flips false as soon as the queue is empty, so the lanes exit
    // instead of idling — the same path SIGTERM takes.
    let running = true;
    const totals = runGradingLanes({
      pool: db.pool,
      provider,
      log,
      concurrency,
      isRunning: () => running,
      idleSleepMs: 10,
    });
    const poll = setInterval(async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM grading_jobs WHERE status IN ('pending','processing')`,
      );
      if (Number(rows[0]!.n) === 0) running = false;
    }, 25);
    const result = await totals;
    clearInterval(poll);
    return result;
  }

  it('grades every job and writes both raw and capped scores', async () => {
    const fixture = await seedFixture(db.pool);
    await submitAll(fixture.testId);
    await runEnqueueGrading(fixture.testId, db.pool, log);

    const totals = await drain(new StubGradingProvider());
    expect(totals.graded).toBe(15);
    expect(totals.failed).toBe(0);

    const counts = await grading.gradingStatus(fixture.testId, db.pool);
    expect(counts).toMatchObject({ done: 15, pending: 0, failed: 0 });

    const { rows } = await db.pool.query<{ raw_score: number; score: number }>(
      `SELECT raw_score, score FROM grading_jobs g
         JOIN attempts a ON a.id = g.attempt_id
        WHERE a.test_id = $1 AND g.question_id = 'q61'`,
      [fixture.testId],
    );
    expect(rows[0]!.raw_score).toBe(4);
    // The cap is applied in code, so it holds on every call without exception.
    expect(rows[0]!.score).toBe(AWARD_CAP);
  });

  it('never collides: twenty lanes over one queue grade each job exactly once', async () => {
    const fixture = await seedFixture(db.pool);
    for (let i = 0; i < 9; i += 1) await seedStudent(db.pool, fixture.testId);
    await submitAll(fixture.testId);
    await runEnqueueGrading(fixture.testId, db.pool, log);

    const totals = await drain(new StubGradingProvider(), 20);
    expect(totals.graded).toBe(150);

    const { rows } = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM grading_jobs g
         JOIN attempts a ON a.id = g.attempt_id
        WHERE a.test_id = $1 AND g.attempts_made > 1`,
      [fixture.testId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('routes a blank answer to review instead of trusting the zero', async () => {
    const fixture = await seedFixture(db.pool);
    await submitAll(fixture.testId);
    await runEnqueueGrading(fixture.testId, db.pool, log);
    await drain(new StubGradingProvider());

    const { rows } = await db.pool.query<{ needs_review: boolean; flags: unknown[] }>(
      `SELECT needs_review, flags FROM attempts WHERE id = $1`,
      [fixture.attemptId],
    );
    expect(rows[0]!.needs_review).toBe(true);
    expect(JSON.stringify(rows[0]!.flags)).toContain('off_topic_or_blank');

    // The flag does not change the mark.
    const scores = await db.pool.query<{ score: number }>(
      `SELECT score FROM grading_jobs g JOIN attempts a ON a.id = g.attempt_id
        WHERE a.test_id = $1 AND g.question_id = 'q61'`,
      [fixture.testId],
    );
    expect(scores.rows[0]!.score).toBe(AWARD_CAP);
  });

  it('marks a job failed after three attempts rather than dropping it', async () => {
    const fixture = await seedFixture(db.pool);
    await submitAll(fixture.testId);
    await runEnqueueGrading(fixture.testId, db.pool, log);

    const alwaysFails: GradingProvider = {
      name: 'broken',
      grade: async () => {
        throw new Error('provider exploded');
      },
    };

    let running = true;
    const lanes = runGradingLanes({
      pool: db.pool,
      provider: alwaysFails,
      log,
      concurrency: 2,
      isRunning: () => running,
      idleSleepMs: 10,
    });
    const poll = setInterval(async () => {
      const { rows } = await db.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM grading_jobs WHERE status IN ('pending','processing')`,
      );
      if (Number(rows[0]!.n) === 0) running = false;
    }, 25);
    await lanes;
    clearInterval(poll);

    const counts = await grading.gradingStatus(fixture.testId, db.pool);
    expect(counts.failed).toBe(15);
    expect(counts.pending).toBe(0);

    // Surfaced with its error, so an operator can see what broke.
    const failed = await grading.listFailedGradingJobs(fixture.testId, 50, db.pool);
    expect(failed[0]!.error).toContain('provider exploded');
    expect(failed[0]!.attempts_made).toBe(3);
  });

  it('rolls completed grading up onto the attempt', async () => {
    const fixture = await seedFixture(db.pool);
    await submitAll(fixture.testId);
    await db.pool.query(`UPDATE attempts SET mcq_score = 100 WHERE id = $1`, [
      fixture.attemptId,
    ]);
    await runEnqueueGrading(fixture.testId, db.pool, log);
    await drain(new StubGradingProvider());
    await grading.rollUpScores(fixture.testId, db.pool);

    const { rows } = await db.pool.query<{
      subjective_score: number;
      total_score: number;
    }>(`SELECT subjective_score, total_score FROM attempts WHERE id = $1`, [
      fixture.attemptId,
    ]);
    // Only q61 was answered; the other 14 are blank and score 0. The roll-up
    // must tolerate that rather than assuming every question earned something.
    expect(rows[0]!.subjective_score).toBe(AWARD_CAP);
    expect(rows[0]!.total_score).toBe(100 + AWARD_CAP);
  });
});

describe('prompt', () => {
  const rubric = {
    questionId: 'q61',
    statement: 'Derive a = g sin θ.',
    marks: { approach: 'a', setup: 'b', calculation: 'c', final_answer: 'd' },
    examples: [
      {
        answer: 'a = g sin θ m/s²',
        observation: {
          approach_correct: true,
          approach_reason: 'correct',
          setup_correct: true,
          calculation_correct: true,
          calculation_error: null,
          final_answer_correct: true,
          units_present: true,
          confidence: 'high' as const,
          off_topic_or_blank: false,
        },
        note: 'full marks',
      },
    ],
  };

  it('puts the rubric in the cacheable prefix and only the answer in the variable part', () => {
    const a = buildPrompt(rubric, 'answer one');
    const b = buildPrompt(rubric, 'answer two');
    expect(a.cachedPrefix).toBe(b.cachedPrefix);
    expect(a.systemPrompt).toBe(b.systemPrompt);
    expect(a.userContent).not.toBe(b.userContent);
    expect(a.cachedPrefix).not.toContain('answer one');
  });

  it('never asks the model for a score', () => {
    const prompt = buildPrompt(rubric, 'x');
    const whole = `${prompt.systemPrompt}\n${prompt.cachedPrefix}`.toLowerCase();
    expect(whole).toContain('you do not assign scores');
    expect(whole).not.toMatch(/\baward\s+\d/);
    expect(whole).not.toMatch(/give (it )?a (score|mark) (of|out of)/);
  });

  it('labels a blank answer rather than sending an empty prompt', () => {
    expect(buildPrompt(rubric, '   ').userContent).toContain('(blank)');
  });

  it('parses a clean JSON reply', () => {
    const observation = parseObservation(JSON.stringify(rubric.examples[0]!.observation));
    expect(observation.approach_correct).toBe(true);
  });

  it('parses a reply wrapped in a fenced block', () => {
    const raw = '```json\n' + JSON.stringify(rubric.examples[0]!.observation) + '\n```';
    expect(parseObservation(raw).units_present).toBe(true);
  });

  it('throws on a malformed reply so the job retries instead of scoring zero', () => {
    expect(() => parseObservation('I think this answer is pretty good')).toThrow();
    expect(() => parseObservation('{"approach_correct": "yes"}')).toThrow();
  });

  it('writes feedback a student can act on', () => {
    const feedback = feedbackFrom({
      ...rubric.examples[0]!.observation,
      units_present: false,
    });
    expect(feedback).toContain('units are missing');
  });
});
