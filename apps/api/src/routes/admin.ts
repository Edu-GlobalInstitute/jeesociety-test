import express, { Router } from 'express';
import { z } from 'zod';
import { admin, attempts, jobs, tests, type Pool } from '@jee/db';
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
    const [test, stats, runs] = await Promise.all([
      tests.getTest(testId, pool),
      admin.liveStats(testId, pool),
      jobs.listJobRuns(testId, pool),
    ]);
    res.json({
      testId,
      // The lock, so the dashboard can say whether students can get in at all.
      test: test
        ? { name: test.name, status: test.status, paperPublished: Boolean(test.paper_url) }
        : null,
      stats,
      jobs: runs,
      serverTime: Date.now(),
    });
  });

  /**
   * The review queue. Sorted by severity so the strongest evidence is read
   * first. On an all-objective paper the only signal left is a change of IP
   * address mid-attempt, so this is a list to glance down rather than a ranked
   * evidence pile — see queries/admin.ts.
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
        totalScore: row.total_score,
      })),
    });
  });

  /**
   * Everything a reviewer needs on one screen: the recorded answers, the flags
   * with their evidence, and the sync trail showing what the server held at
   * each revision and from which address. "At 11:42 this attempt had 31 answers
   * recorded, from these two addresses" is a defensible thing to say to a
   * parent; a guess about intent is not.
   */
  router.get('/attempt/:attemptId', async (req, res) => {
    const attemptId = z.string().uuid().parse(req.params.attemptId);
    const attempt = await attempts.getAttempt(attemptId, pool);
    if (!attempt) throw notFound('no_attempt', 'No such attempt.');

    const snapshots = await attempts.listSnapshots(attemptId, pool);

    res.json({
      attemptId: attempt.id,
      userId: attempt.user_id,
      status: attempt.status,
      receipt: attempt.receipt,
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      revision: attempt.revision,
      answers: attempt.answers,
      flags: attempt.flags,
      needsReview: attempt.needs_review,
      scores: {
        mcq: attempt.mcq_score,
        total: attempt.total_score,
      },
      // The sync trail, straight from sync_snapshots.
      growth: snapshots.map((snapshot) => ({
        revision: snapshot.revision,
        at: snapshot.at.toISOString(),
        lengths: snapshot.lengths,
      })),
    });
  });

  /**
   * There is no per-student score override any more.
   *
   * Overriding used to mean correcting one model-graded subjective answer. On an
   * all-objective paper a disputed mark is never about one student: it is a
   * wrong entry in `tests.answer_key`, and the fix is to correct the key and
   * re-run `mcq_score`, which is idempotent and rescores the whole cohort the
   * same way. Fixing it per student would leave 9,999 others wrong.
   */

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
  /* POST /admin/test-status — the one switch that opens or locks the inside. */
  /* ---------------------------------------------------------------------- */
  /**
   * `scheduled` sells the test and keeps the exam app on its coming-soon
   * screen. `live` opens the lobby, the paper key and sync.
   *
   * Only those two values are accepted. `closed` and `graded` are written by
   * the worker as the event moves through its own lifecycle, and letting an
   * admin set them by hand would mean a mistyped request could shut sync on a
   * cohort mid-test — the one thing hard constraint 1 forbids.
   */
  const TestStatusSchema = z.object({
    status: z.enum(['scheduled', 'live']),
    reason: z.string().min(3).max(1000),
    testId: z.number().int().positive().optional(),
  });

  router.post('/test-status', async (req, res) => {
    const me = currentUser(req);
    const body = TestStatusSchema.parse(req.body);
    const testId = body.testId ?? (await currentTestId(undefined));

    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');
    if (test.status === body.status) {
      res.json({ ok: true, status: test.status, changed: false });
      return;
    }
    // A test cannot go live without a paper to open. Students would reach the
    // lobby, pass their checks and then find nothing to download.
    if (body.status === 'live' && !test.paper_url) {
      throw badRequest(
        'no_paper',
        'This test has no published paper. Upload it before going live.',
      );
    }
    // Nor can it go back to locked once it has ended — that status is the
    // worker's to set, and reopening a finished event is never what was meant.
    if (!['scheduled', 'live'].includes(test.status)) {
      throw badRequest(
        'not_switchable',
        `This test is ${test.status}. Only a scheduled or live test can be switched.`,
      );
    }

    await tests.setTestStatus(testId, body.status, pool);
    await admin.logAdminAction(
      {
        adminId: me.id,
        action: `test_status:${body.status}`,
        attemptId: null,
        questionId: null,
        before: { status: test.status },
        after: { status: body.status },
        reason: body.reason,
      },
      pool,
    );

    log.info({ testId, from: test.status, to: body.status, adminId: me.id }, 'test status set');
    res.json({ ok: true, status: body.status, changed: true });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/run-job — schedules worker jobs. Never runs them inline.    */
  /* ---------------------------------------------------------------------- */
  const RunJobSchema = z.object({
    job: z.enum(['auto_submit', 'mcq_score', 'compute_flags']),
    testId: z.number().int().positive().optional(),
  });

  router.post('/run-job', async (req, res) => {
    const me = currentUser(req);
    const body = RunJobSchema.parse(req.body);
    const testId = body.testId ?? (await currentTestId(undefined));

    // The request writes a row and returns. The worker claims it on its next
    // poll — scoring 10,000 attempts never happens inside an HTTP request.
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
