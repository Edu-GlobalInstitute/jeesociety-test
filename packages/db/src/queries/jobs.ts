import { SERVER_TIMING } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

/**
 * One-shot job bookkeeping. Every scheduled or admin-triggered job is a row in
 * job_runs rather than a timer in process memory, which is what lets the worker
 * be killed and restarted at any point: on boot it reads the table and carries
 * on. `locked_until` leases a claim so a crashed worker's job comes back;
 * UNIQUE (job, test_id) means a double trigger cannot produce two runs.
 */

export type JobName =
  | 'auto_submit'
  | 'mcq_score'
  | 'enqueue_grading'
  | 'compute_flags'
  | 'finalise_scores';

export interface JobRunRow {
  id: number;
  job: JobName;
  test_id: number | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  run_after: Date;
  attempts_made: number;
  result: Record<string, unknown> | null;
  error: string | null;
}

const JOB_COLUMNS = `id, job, test_id, status, run_after, attempts_made, result, error`;

/** Schedules a job, or leaves an existing one alone. Safe to call repeatedly. */
export function scheduleJob(
  job: JobName,
  testId: number,
  runAfter: Date,
  db?: Queryable,
): Promise<JobRunRow | null> {
  return one<JobRunRow>(
    `INSERT INTO job_runs (job, test_id, run_after)
          VALUES ($1, $2, $3)
     ON CONFLICT (job, test_id) DO NOTHING
       RETURNING ${JOB_COLUMNS}`,
    [job, testId, runAfter],
    db,
  );
}

/** Admin re-trigger: puts a done or failed job back on the queue. */
export function requeueJob(
  job: JobName,
  testId: number,
  db?: Queryable,
): Promise<JobRunRow | null> {
  return one<JobRunRow>(
    `INSERT INTO job_runs (job, test_id, run_after, status)
          VALUES ($1, $2, now(), 'pending')
     ON CONFLICT (job, test_id) DO UPDATE
        SET status = 'pending', run_after = now(), locked_until = NULL,
            error = NULL, completed_at = NULL
       RETURNING ${JOB_COLUMNS}`,
    [job, testId],
    db,
  );
}

/**
 * Claims the next due job. Same shape as the grading claim: SKIP LOCKED so
 * concurrent workers never collide, a lease so a crashed worker's job returns.
 */
export function claimNextJobRun(
  leaseMs: number = SERVER_TIMING.gradingLockMs,
  db?: Queryable,
): Promise<JobRunRow | null> {
  return one<JobRunRow>(
    `UPDATE job_runs
        SET status = 'running',
            locked_until = now() + make_interval(secs => $1::float8),
            attempts_made = attempts_made + 1,
            started_at = COALESCE(started_at, now())
      WHERE id = (
        SELECT id FROM job_runs
         WHERE run_after <= now()
           AND (status = 'pending'
                OR (status = 'running' AND locked_until < now()))
         ORDER BY run_after ASC, id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING ${JOB_COLUMNS}`,
    [leaseMs / 1000],
    db,
  );
}

export async function completeJobRun(
  id: number,
  result: Record<string, unknown>,
  db?: Queryable,
): Promise<void> {
  await rows(
    `UPDATE job_runs
        SET status = 'done', result = $2, completed_at = now(), error = NULL
      WHERE id = $1`,
    [id, JSON.stringify(result)],
    db,
  );
}

export async function failJobRun(
  id: number,
  error: string,
  maxAttempts: number = SERVER_TIMING.gradingMaxAttempts,
  db?: Queryable,
): Promise<void> {
  await rows(
    `UPDATE job_runs
        SET status = CASE WHEN attempts_made >= $3 THEN 'failed' ELSE 'pending' END,
            error = $2,
            locked_until = NULL,
            run_after = now() + interval '30 seconds',
            completed_at = CASE WHEN attempts_made >= $3 THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, error.slice(0, 2000), maxAttempts],
    db,
  );
}

export function listJobRuns(testId: number, db?: Queryable): Promise<JobRunRow[]> {
  return rows<JobRunRow>(
    `SELECT ${JOB_COLUMNS} FROM job_runs WHERE test_id = $1 ORDER BY id`,
    [testId],
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* Auto-submit — the real safety net                                           */
/* -------------------------------------------------------------------------- */

export interface AutoSubmitResult {
  autoSubmitted: number;
}

/**
 * Finalises every attempt that is still open, from its last synced answers.
 *
 * This is what makes the submit button a convenience rather than a requirement:
 * a student whose machine died at minute 178 is graded on whatever the server
 * last received, which is at most 90 seconds behind what they typed.
 *
 * One statement, so there is no partial sweep to resume. Re-running it is a
 * no-op because `submitted_at IS NULL` no longer matches anything.
 *
 * `status = 'in_progress'` deliberately excludes attempts that registered in the
 * lobby and never started: those have no key, no answers and no business
 * carrying a receipt. They are counted separately in the reconciliation report.
 */
export async function autoSubmitAll(
  testId: number,
  db?: Queryable,
): Promise<AutoSubmitResult> {
  const finalised = await rows<{ id: string }>(
    `UPDATE attempts
        SET status = 'auto_submitted',
            submitted_at = now(),
            receipt = 'JEE-' || test_id || '-AUTO-' || substr(id::text, 1, 6)
      WHERE test_id = $1
        AND submitted_at IS NULL
        AND status = 'in_progress'
      RETURNING id`,
    [testId],
    db,
  );
  return { autoSubmitted: finalised.length };
}

export interface ReconciliationReport {
  testId: number;
  registered: number;
  started: number;
  manuallySubmitted: number;
  autoSubmitted: number;
  neverStarted: number;
  zeroAnswer: number;
  /** Attempts whose last sync was more than 5 minutes before the window closed. */
  staleAtClose: number;
}

/**
 * Emitted after every auto-submit run. An unusually high auto-submit count means
 * sync was failing for part of the cohort, and that is something to find out
 * from a report rather than from a parent's phone call six days later.
 */
export async function reconciliationReport(
  testId: number,
  db?: Queryable,
): Promise<ReconciliationReport> {
  const row = await one<Record<string, number>>(
    `SELECT
       count(*)                                                   AS registered,
       count(*) FILTER (WHERE key_issued_at IS NOT NULL)           AS started,
       count(*) FILTER (WHERE status = 'submitted')                AS manually_submitted,
       count(*) FILTER (WHERE status = 'auto_submitted')           AS auto_submitted,
       count(*) FILTER (WHERE key_issued_at IS NULL)               AS never_started,
       count(*) FILTER (WHERE key_issued_at IS NOT NULL
                          AND answers = '{}'::jsonb)               AS zero_answer,
       count(*) FILTER (WHERE key_issued_at IS NOT NULL
                          AND (last_sync_at IS NULL
                               OR last_sync_at < (SELECT ends_at FROM tests WHERE id = $1)
                                                 - interval '5 minutes')) AS stale_at_close
     FROM attempts WHERE test_id = $1`,
    [testId],
    db,
  );

  return {
    testId,
    registered: Number(row?.registered ?? 0),
    started: Number(row?.started ?? 0),
    manuallySubmitted: Number(row?.manually_submitted ?? 0),
    autoSubmitted: Number(row?.auto_submitted ?? 0),
    neverStarted: Number(row?.never_started ?? 0),
    zeroAnswer: Number(row?.zero_answer ?? 0),
    staleAtClose: Number(row?.stale_at_close ?? 0),
  };
}
