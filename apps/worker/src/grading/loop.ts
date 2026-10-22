import { AWARD_CAP, SERVER_TIMING, scoreRubric, type RubricMap } from '@jee/shared';
import { attempts, grading, tests, type Pool } from '@jee/db';
import type { Logger } from 'pino';
import { buildPrompt, feedbackFrom } from './prompt.js';
import { RetryableGradingError, type GradingProvider } from './provider.js';

/**
 * Concurrent lanes over a Postgres queue.
 *
 * Each lane claims one job at a time with FOR UPDATE SKIP LOCKED, so lanes
 * never collide and never block on each other. `locked_until` is a lease rather
 * than a lock: if this process is killed mid-call, the job returns to the pool
 * five minutes later and another lane takes it. That is the whole recovery
 * story — there is no in-memory state to lose.
 */

export interface LaneOptions {
  pool: Pool;
  provider: GradingProvider;
  log: Logger;
  concurrency: number;
  /** Set false to stop claiming new work; in-flight jobs finish. */
  isRunning: () => boolean;
  idleSleepMs?: number;
}

export interface GradingTotals {
  graded: number;
  failed: number;
  retried: number;
  cacheReadTokens: number;
  inputTokens: number;
  outputTokens: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, so lanes do not retry in lockstep. */
function backoffMs(attemptsMade: number): number {
  const base = Math.min(1_000 * 2 ** Math.max(0, attemptsMade - 1), 30_000);
  return base + Math.random() * base * 0.5;
}

export async function runGradingLanes(options: LaneOptions): Promise<GradingTotals> {
  const totals: GradingTotals = {
    graded: 0,
    failed: 0,
    retried: 0,
    cacheReadTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const rubricCache = new Map<number, RubricMap>();
  const idleSleepMs = options.idleSleepMs ?? 5_000;

  async function rubricsFor(testId: number): Promise<RubricMap> {
    const cached = rubricCache.get(testId);
    if (cached) return cached;
    const rubrics = (await tests.readRubricsForGrading(testId, options.pool)) ?? {};
    rubricCache.set(testId, rubrics);
    return rubrics;
  }

  async function lane(laneId: number): Promise<void> {
    while (options.isRunning()) {
      const job = await grading.claimNextGradingJob(
        SERVER_TIMING.gradingLockMs,
        options.pool,
      );
      if (!job) {
        await sleep(idleSleepMs);
        continue;
      }

      try {
        const context = await grading.getAnswerForJob(
          job.attempt_id,
          job.question_id,
          options.pool,
        );
        if (!context) throw new Error('attempt disappeared');

        const rubrics = await rubricsFor(context.test_id);
        const rubric = rubrics[job.question_id];
        if (!rubric) throw new Error(`no rubric for ${job.question_id}`);

        const { observation, usage } = await options.provider.grade(
          buildPrompt(rubric, context.answer ?? ''),
        );

        // The number is computed here, from the observations, with the cap
        // applied in code. The model was never asked for a score.
        const scored = scoreRubric(observation);

        await grading.completeGradingJob(
          {
            id: job.id,
            rawScore: scored.raw,
            score: scored.score,
            observation,
            feedback: feedbackFrom(observation),
            confidence: observation.confidence,
          },
          options.pool,
        );

        // Low confidence and off-topic go to a human rather than standing as a
        // score. This raises needs_review; it never changes the mark.
        if (scored.needsReview) {
          await attempts.addFlags(
            job.attempt_id,
            [
              {
                code: observation.off_topic_or_blank
                  ? 'off_topic_or_blank'
                  : 'grader_low_confidence',
                questionId: job.question_id,
                evidence: {
                  confidence: observation.confidence,
                  reasons: scored.reviewReasons,
                  rawScore: scored.raw,
                },
                at: new Date().toISOString(),
              },
            ],
            options.pool,
          );
        }

        totals.graded += 1;
        totals.cacheReadTokens += usage.cacheReadTokens;
        totals.inputTokens += usage.inputTokens;
        totals.outputTokens += usage.outputTokens;

        options.log.debug(
          { lane: laneId, jobId: job.id, score: scored.score, raw: scored.raw },
          'graded',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = error instanceof RetryableGradingError;

        await grading.failGradingJob(
          job.id,
          message,
          SERVER_TIMING.gradingMaxAttempts,
          options.pool,
        );

        if (job.attempts_made >= SERVER_TIMING.gradingMaxAttempts) {
          totals.failed += 1;
          // Surfaced in /admin/grading-status, never silently dropped: a lost
          // job is a student with a missing mark and no record of why.
          options.log.error(
            { lane: laneId, jobId: job.id, attemptsMade: job.attempts_made, err: message },
            'grading job failed permanently',
          );
        } else {
          totals.retried += 1;
          options.log.warn({ lane: laneId, jobId: job.id, err: message }, 'grading job retrying');
        }

        if (retryable) {
          // Back off this lane specifically. A 429 means the provider wants
          // less traffic, and every lane hitting it will back off in turn.
          const wait = (error as RetryableGradingError).retryAfterMs ?? backoffMs(job.attempts_made);
          await sleep(wait);
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: options.concurrency }, (_, index) => lane(index + 1)),
  );

  options.log.info({ ...totals, awardCap: AWARD_CAP }, 'grading lanes stopped');
  return totals;
}
