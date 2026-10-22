import { SERVER_TIMING, type GradingJobStatus, type RubricObservation } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

export interface GradingJobRow {
  id: number;
  attempt_id: string;
  question_id: string;
  status: GradingJobStatus;
  attempts_made: number;
  locked_until: Date | null;
  raw_score: number | null;
  score: number | null;
  rubric_output: RubricObservation | null;
  feedback: string | null;
  confidence: string | null;
  error: string | null;
}

const JOB_COLUMNS = `
  id, attempt_id, question_id, status, attempts_made, locked_until,
  raw_score, score, rubric_output, feedback, confidence, error
`;

/** The same list, qualified — required wherever the query joins `attempts`. */
const JOB_COLUMNS_Q = `
  g.id, g.attempt_id, g.question_id, g.status, g.attempts_made, g.locked_until,
  g.raw_score, g.score, g.rubric_output, g.feedback, g.confidence, g.error
`;

/**
 * Enqueue is admin-triggered and inserts one row per subjective answer. It never
 * grades inside the request: it writes rows and returns.
 *
 * ON CONFLICT DO NOTHING on (attempt_id, question_id) makes re-running it after
 * a partial failure safe — already-enqueued work is left exactly as it is,
 * including work already graded.
 *
 * Rows are inserted question-major so that id order groups by question, which
 * is what makes the cached rubric prefix actually hit.
 */
export async function enqueueGradingJobs(
  testId: number,
  subjectiveQuestionIds: string[],
  db?: Queryable,
): Promise<number> {
  const inserted = await rows<{ id: number }>(
    `INSERT INTO grading_jobs (attempt_id, question_id)
     SELECT a.id, q.question_id
       FROM attempts a
       CROSS JOIN unnest($2::text[]) AS q(question_id)
      WHERE a.test_id = $1
        AND a.submitted_at IS NOT NULL
      -- Ordered by question first so that consecutive ids share a question.
      -- Lanes claim in id order, so this keeps every lane working on the same
      -- cached rubric prefix at the same time instead of cycling through all
      -- 15 rubrics per attempt and missing the cache on every call.
      ORDER BY q.question_id, a.id
     ON CONFLICT (attempt_id, question_id) DO NOTHING
       RETURNING id`,
    [testId, subjectiveQuestionIds],
    db,
  );
  return inserted.length;
}

/**
 * Claims one job for this lane.
 *
 * SKIP LOCKED means lanes never block on each other — a lane that would have
 * waited simply takes the next row. `locked_until` is a lease, not a lock: if
 * this process is killed mid-call, the job returns to the pool five minutes
 * later and another lane picks it up, which is why a crashed worker loses no
 * work and duplicates none either.
 */
export function claimNextGradingJob(
  leaseMs: number = SERVER_TIMING.gradingLockMs,
  db?: Queryable,
): Promise<GradingJobRow | null> {
  return one<GradingJobRow>(
    `UPDATE grading_jobs
        SET status = 'processing',
            locked_until = now() + make_interval(secs => $1::float8),
            attempts_made = attempts_made + 1
      WHERE id = (
        SELECT id FROM grading_jobs
         WHERE status = 'pending'
            OR (status = 'processing' AND locked_until < now())
         ORDER BY id
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING ${JOB_COLUMNS}`,
    [leaseMs / 1000],
    db,
  );
}

/** The answer text to grade, fetched only when a job has been claimed. */
export function getAnswerForJob(
  attemptId: string,
  questionId: string,
  db?: Queryable,
): Promise<{ answer: string | null; test_id: number } | null> {
  return one<{ answer: string | null; test_id: number }>(
    `SELECT answers ->> $2 AS answer, test_id FROM attempts WHERE id = $1`,
    [attemptId, questionId],
    db,
  );
}

export async function completeGradingJob(
  params: {
    id: number;
    rawScore: number;
    score: number;
    observation: RubricObservation;
    feedback: string;
    confidence: string;
  },
  db?: Queryable,
): Promise<void> {
  await rows(
    `UPDATE grading_jobs
        SET status = 'done', raw_score = $2, score = $3, rubric_output = $4,
            feedback = $5, confidence = $6, error = NULL, completed_at = now()
      WHERE id = $1`,
    [
      params.id,
      params.rawScore,
      params.score,
      JSON.stringify(params.observation),
      params.feedback,
      params.confidence,
    ],
    db,
  );
}

/**
 * Releases a job after a failure. Below the attempt ceiling it goes back to
 * pending for another lane; at the ceiling it is marked failed and surfaced in
 * the admin view. A job is never silently dropped — a dropped job is a student
 * with a missing mark and no record of why.
 */
export async function failGradingJob(
  id: number,
  error: string,
  maxAttempts: number = SERVER_TIMING.gradingMaxAttempts,
  db?: Queryable,
): Promise<void> {
  await rows(
    `UPDATE grading_jobs
        SET status = CASE WHEN attempts_made >= $3 THEN 'failed' ELSE 'pending' END,
            error = $2,
            locked_until = NULL,
            completed_at = CASE WHEN attempts_made >= $3 THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, error.slice(0, 2000), maxAttempts],
    db,
  );
}

export interface GradingStatusCounts {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  total: number;
}

export async function gradingStatus(
  testId: number,
  db?: Queryable,
): Promise<GradingStatusCounts> {
  const row = await one<Record<string, number>>(
    `SELECT
       count(*) FILTER (WHERE g.status = 'pending')    AS pending,
       count(*) FILTER (WHERE g.status = 'processing') AS processing,
       count(*) FILTER (WHERE g.status = 'done')       AS done,
       count(*) FILTER (WHERE g.status = 'failed')     AS failed,
       count(*)                                        AS total
     FROM grading_jobs g
     JOIN attempts a ON a.id = g.attempt_id
    WHERE a.test_id = $1`,
    [testId],
    db,
  );
  return {
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    done: Number(row?.done ?? 0),
    failed: Number(row?.failed ?? 0),
    total: Number(row?.total ?? 0),
  };
}

export function listFailedGradingJobs(
  testId: number,
  limit = 100,
  db?: Queryable,
): Promise<GradingJobRow[]> {
  return rows<GradingJobRow>(
    `SELECT ${JOB_COLUMNS_Q}
       FROM grading_jobs g
       JOIN attempts a ON a.id = g.attempt_id
      WHERE a.test_id = $1 AND g.status = 'failed'
      ORDER BY g.id
      LIMIT $2`,
    [testId, limit],
    db,
  );
}

export function listJobsForAttempt(
  attemptId: string,
  db?: Queryable,
): Promise<GradingJobRow[]> {
  return rows<GradingJobRow>(
    `SELECT ${JOB_COLUMNS} FROM grading_jobs WHERE attempt_id = $1 ORDER BY question_id`,
    [attemptId],
    db,
  );
}

/**
 * Rolls completed grading up onto the attempt. Called repeatedly as grading
 * advances, so it must tolerate a partially graded attempt — it sums what is
 * done and leaves total_score consistent with it.
 */
export async function rollUpScores(testId: number, db?: Queryable): Promise<number> {
  const updated = await rows<{ id: string }>(
    `UPDATE attempts a
        SET subjective_score = s.subjective,
            total_score = COALESCE(a.mcq_score, 0) + s.subjective
       FROM (
         SELECT g.attempt_id, COALESCE(sum(g.score), 0) AS subjective
           FROM grading_jobs g
          WHERE g.status = 'done'
          GROUP BY g.attempt_id
       ) s
      WHERE a.id = s.attempt_id
        AND a.test_id = $1
        AND (a.subjective_score IS DISTINCT FROM s.subjective
             OR a.total_score IS DISTINCT FROM COALESCE(a.mcq_score, 0) + s.subjective)
      RETURNING a.id`,
    [testId],
    db,
  );
  return updated.length;
}
