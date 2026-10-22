import { grading, tests, type Pool } from '@jee/db';
import type { RubricMap } from '@jee/shared';
import type { Logger } from 'pino';

/**
 * Inserts one grading_jobs row per subjective answer and returns. The lanes
 * pick them up on their own schedule; nothing is graded inside this call and
 * nothing is graded inside an HTTP request.
 *
 * The question list comes from the rubrics, not from the paper: a question with
 * no rubric cannot be graded consistently, so enqueuing it would only produce
 * 15,000 jobs that fail at the model and land in the review queue.
 */
export async function runEnqueueGrading(
  testId: number,
  pool: Pool,
  log: Logger,
): Promise<Record<string, unknown>> {
  const rubrics: RubricMap | null = await tests.readRubricsForGrading(testId, pool);
  const questionIds = Object.keys(rubrics ?? {});
  if (questionIds.length === 0) {
    throw new Error(`test ${testId} has no rubrics; refusing to enqueue grading`);
  }

  // ON CONFLICT DO NOTHING on (attempt_id, question_id), so re-running after a
  // partial failure leaves already-graded work untouched.
  const inserted = await grading.enqueueGradingJobs(testId, questionIds, pool);
  const counts = await grading.gradingStatus(testId, pool);

  log.info({ testId, inserted, questions: questionIds.length, counts }, 'grading enqueued');
  return { inserted, questions: questionIds.length, counts };
}
