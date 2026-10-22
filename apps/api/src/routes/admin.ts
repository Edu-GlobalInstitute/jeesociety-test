import express, { Router } from 'express';
import { z } from 'zod';
import { AWARD_CAP } from '@jee/shared';
import { admin, attempts, grading, jobs, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireAdmin } from '../middleware/session.js';
import { badRequest, notFound } from '../middleware/errors.js';
import type { Logger } from '../logger.js';

/**
 * Admin surface. Nothing here runs during the test except the dashboard read,
 * and nothing here changes a score without writing a row to admin_audit first.
 */
export function adminRoutes({
  pool,
  auth,
  log,
}: {
  pool: Pool;
  auth: Auth;
  log: Logger;
}): Router {
  const router = Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(requireAdmin(auth, pool));

  async function currentTestId(query: unknown): Promise<number> {
    const explicit = Number((query as { testId?: string } | undefined)?.testId);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');
    return test.id;
  }

  /** Live cohort health. The number to watch during the test is staleOver4Minutes. */
  router.get('/dashboard', async (req, res) => {
    const testId = await currentTestId(req.query);
    const [stats, gradingCounts, runs] = await Promise.all([
      admin.liveStats(testId, pool),
      grading.gradingStatus(testId, pool),
      jobs.listJobRuns(testId, pool),
    ]);
    res.json({ testId, stats, grading: gradingCounts, jobs: runs, serverTime: Date.now() });
  });

  router.get('/grading-status', async (req, res) => {
    const testId = await currentTestId(req.query);
    const [counts, failed] = await Promise.all([
      grading.gradingStatus(testId, pool),
      grading.listFailedGradingJobs(testId, 50, pool),
    ]);
    res.json({
      testId,
      counts,
      // Failed jobs are surfaced, never silently dropped: each one is a student
      // with a missing mark.
      failed: failed.map((job) => ({
        id: job.id,
        attemptId: job.attempt_id,
        questionId: job.question_id,
        attemptsMade: job.attempts_made,
        error: job.error,
      })),
    });
  });

  /**
   * The review queue. Sorted by severity so the strongest evidence is read
   * first — at 10,000 students expect 300-500 flagged attempts, which is
   * reviewable inside the grading window in that order.
   */
  router.get('/review-queue', async (req, res) => {
    const testId = await currentTestId(req.query);
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const queue = await admin.reviewQueue(testId, limit, pool);
    res.json({
      testId,
      count: queue.length,
      attempts: queue.map((row) => ({
        attemptId: row.attempt_id,
        email: row.email,
        status: row.status,
        receipt: row.receipt,
        flags: row.flags,
        flagCount: row.flag_count,
        severity: Number(row.severity),
        mcqScore: row.mcq_score,
        subjectiveScore: row.subjective_score,
        totalScore: row.total_score,
      })),
    });
  });

  /**
   * Everything a reviewer needs on one screen: the answer text, the flags with
   * their evidence, the sync growth curve for each question, and the assigned
   * score. "This answer went from 0 to 800 characters between 11:42 and 11:43"
   * is a defensible thing to say to a parent; "the AI thought it looked
   * suspicious" is not.
   */
  router.get('/attempt/:attemptId', async (req, res) => {
    const attemptId = z.string().uuid().parse(req.params.attemptId);
    const attempt = await attempts.getAttempt(attemptId, pool);
    if (!attempt) throw notFound('no_attempt', 'No such attempt.');

    const [snapshots, gradingJobs] = await Promise.all([
      attempts.listSnapshots(attemptId, pool),
      grading.listJobsForAttempt(attemptId, pool),
    ]);

    res.json({
      attemptId: attempt.id,
      userId: attempt.user_id,
      status: attempt.status,
      receipt: attempt.receipt,
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      revision: attempt.revision,
      answers: attempt.answers,
      telemetry: attempt.telemetry,
      flags: attempt.flags,
      needsReview: attempt.needs_review,
      scores: {
        mcq: attempt.mcq_score,
        subjective: attempt.subjective_score,
        total: attempt.total_score,
      },
      // The growth curve, straight from sync_snapshots.
      growth: snapshots.map((snapshot) => ({
        revision: snapshot.revision,
        at: snapshot.at.toISOString(),
        lengths: snapshot.lengths,
      })),
      grading: gradingJobs.map((job) => ({
        questionId: job.question_id,
        status: job.status,
        rawScore: job.raw_score,
        score: job.score,
        confidence: job.confidence,
        feedback: job.feedback,
        observation: job.rubric_output,
        error: job.error,
      })),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/override-score                                              */
  /* ---------------------------------------------------------------------- */
  const OverrideSchema = z.object({
    attemptId: z.string().uuid(),
    questionId: z.string().min(1),
    score: z.number().min(0).max(AWARD_CAP),
    reason: z.string().min(3).max(1000),
  });

  router.post('/override-score', async (req, res) => {
    const me = currentUser(req);
    const body = OverrideSchema.parse(req.body);

    const result = await admin.overrideQuestionScore(body, pool);
    if (!result) throw notFound('no_job', 'No grading job for that question.');

    // Logged with the admin's identity, before the response goes out.
    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'override_score',
        attemptId: body.attemptId,
        questionId: body.questionId,
        before: { score: result.before },
        after: { score: body.score },
        reason: body.reason,
      },
      pool,
    );
    await grading.rollUpScores(
      (await attempts.getAttempt(body.attemptId, pool))!.test_id,
      pool,
    );

    log.info({ attemptId: body.attemptId, adminId: me.id }, 'score overridden');
    res.json({ ok: true, before: result.before, after: body.score });
  });

  /** Marks a flagged attempt as reviewed. Flags stay on the row for the record. */
  router.post('/resolve-review', async (req, res) => {
    const me = currentUser(req);
    const body = z
      .object({ attemptId: z.string().uuid(), reason: z.string().min(3).max(1000) })
      .parse(req.body);

    await admin.resolveReview(body.attemptId, pool);
    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'resolve_review',
        attemptId: body.attemptId,
        questionId: null,
        before: { needsReview: true },
        after: { needsReview: false },
        reason: body.reason,
      },
      pool,
    );
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/run-job — schedules worker jobs. Never runs them inline.    */
  /* ---------------------------------------------------------------------- */
  const RunJobSchema = z.object({
    job: z.enum(['auto_submit', 'mcq_score', 'enqueue_grading', 'compute_flags', 'finalise_scores']),
    testId: z.number().int().positive().optional(),
  });

  router.post('/run-job', async (req, res) => {
    const me = currentUser(req);
    const body = RunJobSchema.parse(req.body);
    const testId = body.testId ?? (await currentTestId(undefined));

    // The request writes a row and returns. The worker claims it on its next
    // poll — grading never happens inside an HTTP request.
    const run = await jobs.requeueJob(body.job, testId, pool);
    if (!run) throw badRequest('schedule_failed', 'Could not schedule that job.');

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: `run_job:${body.job}`,
        attemptId: null,
        questionId: null,
        before: null,
        after: { job: body.job, testId },
        reason: 'admin triggered',
      },
      pool,
    );
    log.info({ job: body.job, testId, adminId: me.id }, 'job scheduled');
    res.json({ ok: true, job: run.job, testId, status: run.status });
  });

  return router;
}
