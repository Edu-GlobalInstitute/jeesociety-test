import { MCQ_MARKS, scoreBySubject, scoreMcq, type AnswerMap } from '@jee/shared';
import { questions, tests, withTransaction, type Pool } from '@jee/db';
import type { Logger } from 'pino';

/**
 * One pass over the cohort, after auto-submit. Pure comparison in code — no
 * model, no network. 750,000 comparisons take about a second; the time is spent
 * reading and writing rows, which is why it streams in batches rather than
 * loading 10,000 attempts into memory at once.
 *
 * This job is now the whole of scoring. Every one of the 75 questions is marked
 * here, so when it finishes the cohort has final totals and a rank list can be
 * published the same morning — there is no second pass arriving over days.
 *
 * The answer key is read here and nowhere else in this process, through the
 * deliberately conspicuous reader in queries/tests.ts.
 */
export async function runMcqScoring(
  testId: number,
  pool: Pool,
  log: Logger,
  batchSize = 500,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const answerKey = await tests.readAnswerKeyForScoring(testId, pool);
  if (!answerKey || Object.keys(answerKey).length === 0) {
    throw new Error(`test ${testId} has no answer key; refusing to score`);
  }

  /*
   * Which subject each question belongs to, read once for the whole pass.
   *
   * The scorecard breaks a total down by subject, and recomputing that when a
   * student opens their result would mean decrypting the paper on every read.
   * Computed here instead, while the answer key is already in hand.
   *
   * An empty map is not fatal: scoreBySubject files everything under 'unknown'
   * rather than dropping it, so the subject rows still add up to the total.
   * That is the right failure for a paper built by the older CLI, which wrote
   * no `questions` rows.
   */
  const subjects = await questions.subjectByQuestionRef(testId, pool);
  if (Object.keys(subjects).length === 0) {
    log.warn({ testId }, 'no question rows for this test; subject breakdown will be unknown');
  }

  let scored = 0;
  let lastId = '00000000-0000-0000-0000-000000000000';
  let totalCorrect = 0;
  let totalWrong = 0;
  let totalUnattempted = 0;

  for (;;) {
    const batch = await pool.query<{ id: string; answers: AnswerMap }>(
      `SELECT id, answers
         FROM attempts
        WHERE test_id = $1 AND submitted_at IS NOT NULL AND id > $2
        ORDER BY id
        LIMIT $3`,
      [testId, lastId, batchSize],
    );
    if (batch.rows.length === 0) break;

    // Each batch commits as a unit, so a crash mid-pass leaves consistent rows
    // and the re-run simply recomputes — scoring is deterministic, so running
    // it twice produces the same numbers.
    await withTransaction(async (client) => {
      for (const row of batch.rows) {
        const result = scoreMcq(answerKey, row.answers ?? {});
        totalCorrect += result.correct;
        totalWrong += result.wrong;
        totalUnattempted += result.unattempted;
        await client.query(
          `UPDATE attempts
              SET mcq_score = $2, total_score = $2, subject_scores = $3::jsonb
            WHERE id = $1`,
          [row.id, result.score, JSON.stringify(scoreBySubject(result.breakdown, subjects))],
        );
        scored += 1;
      }
    }, pool);

    lastId = batch.rows[batch.rows.length - 1]!.id;
  }

  const summary = {
    testId,
    scored,
    totalCorrect,
    totalWrong,
    totalUnattempted,
    marking: MCQ_MARKS,
    durationMs: Date.now() - started,
  };
  log.info(summary, 'scoring complete');
  return summary;
}
