import { SERVER_TIMING, CLIENT_TIMING } from '@jee/shared';
import { jobs, tests, type Pool } from '@jee/db';
import type { Logger } from 'pino';
import { runAutoSubmit } from './jobs/autoSubmit.js';
import { runMcqScoring } from './jobs/mcqScore.js';
import { runEnqueueGrading } from './jobs/enqueueGrading.js';
import { runComputeFlags } from './jobs/computeFlags.js';
import { grading } from '@jee/db';

/**
 * Claims and runs one-shot jobs from `job_runs`.
 *
 * No timers, no in-memory schedule. The worker can be killed at any instant —
 * including during a deploy ten minutes after the test ends, which is exactly
 * when auto-submit runs — and a restarted process simply finds the job still
 * due and runs it. A lease means a crash mid-job releases the row rather than
 * stranding it.
 */

export interface SchedulerDeps {
  pool: Pool;
  log: Logger;
  isRunning: () => boolean;
  pollIntervalMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Makes sure the jobs that must happen are on the queue. Idempotent: ON
 * CONFLICT DO NOTHING means calling it on every poll never duplicates a run.
 *
 * Auto-submit is scheduled the moment a test is known, not at the end of the
 * test, so that it exists on the queue well before it is needed. The other
 * post-test jobs are admin-triggered: scoring 10,000 attempts and spending real
 * money on grading are decisions a person should make after reading the
 * reconciliation report.
 */
export async function ensureScheduled(pool: Pool, log: Logger): Promise<void> {
  const test = await tests.getCurrentTest(pool);
  if (!test) return;

  const autoSubmitAt = new Date(test.ends_at.getTime() + SERVER_TIMING.autoSubmitDelayMs);
  const created = await jobs.scheduleJob('auto_submit', test.id, autoSubmitAt, pool);
  if (created) {
    log.info(
      { testId: test.id, runAfter: autoSubmitAt.toISOString() },
      'auto-submit scheduled',
    );
  }
}

export async function runScheduler(deps: SchedulerDeps): Promise<void> {
  const { pool, log } = deps;

  while (deps.isRunning()) {
    try {
      await ensureScheduled(pool, log);
      const run = await jobs.claimNextJobRun(SERVER_TIMING.gradingLockMs, pool);

      if (!run) {
        await sleep(deps.pollIntervalMs);
        continue;
      }

      log.info({ job: run.job, testId: run.test_id, attempt: run.attempts_made }, 'job claimed');
      const started = Date.now();

      try {
        const result = await dispatch(run.job, run.test_id, pool, log);
        await jobs.completeJobRun(run.id, result, pool);
        log.info(
          { job: run.job, testId: run.test_id, durationMs: Date.now() - started },
          'job complete',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await jobs.failJobRun(run.id, message, SERVER_TIMING.gradingMaxAttempts, pool);
        log.error({ job: run.job, testId: run.test_id, err: message }, 'job failed');
      }
    } catch (error) {
      // A failure to even reach the queue must not kill the loop: the database
      // may be mid-failover and the next poll will succeed.
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'scheduler poll failed',
      );
      await sleep(deps.pollIntervalMs);
    }
  }
}

async function dispatch(
  job: jobs.JobName,
  testId: number | null,
  pool: Pool,
  log: Logger,
): Promise<Record<string, unknown>> {
  if (testId === null) throw new Error(`job ${job} has no test_id`);

  switch (job) {
    case 'auto_submit':
      return runAutoSubmit(testId, pool, log);
    case 'mcq_score':
      return runMcqScoring(testId, pool, log);
    case 'enqueue_grading':
      return runEnqueueGrading(testId, pool, log);
    case 'compute_flags':
      return runComputeFlags(testId, pool, log);
    case 'finalise_scores': {
      const updated = await grading.rollUpScores(testId, pool);
      const counts = await grading.gradingStatus(testId, pool);
      log.info({ testId, updated, counts }, 'scores rolled up');
      return { updated, counts };
    }
    default: {
      const exhaustive: never = job;
      throw new Error(`unknown job ${String(exhaustive)}`);
    }
  }
}

export const timings = { ...SERVER_TIMING, ...CLIENT_TIMING };
