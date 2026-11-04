import express, { Router } from 'express';
import { z } from 'zod';
import { admin, jobs, results, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireAdmin } from '../middleware/session.js';
import { badRequest, notFound } from '../middleware/errors.js';
import type { Logger } from '../logger.js';

/**
 * Releasing results, and the list of who sat the paper.
 *
 * The release is the one irreversible-feeling action in the portal, so it is
 * built to refuse rather than to warn: a half-published rank list is not
 * something an apology fixes. It checks that every submitted attempt has been
 * scored before it will publish anything.
 */
export function adminResultRoutes({
  pool,
  auth,
  log,
}: {
  pool: Pool;
  auth: Auth;
  log: Logger;
}): Router {
  const router = Router();
  router.use(express.json({ limit: '16kb' }));
  router.use(requireAdmin(auth, pool));

  const TestId = z.coerce.number().int().positive();

  /* ---------------------------------------------------------------------- */
  /* GET /admin/results/:testId/status — what the Launch button reads.       */
  /* ---------------------------------------------------------------------- */
  router.get('/results/:testId/status', async (req, res) => {
    const testId = TestId.parse(req.params.testId);
    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');

    const [stats, unscored] = await Promise.all([
      results.attemptStats(testId, pool),
      results.countUnscored(testId, pool),
    ]);

    res.json({
      testId,
      testName: test.name,
      testStatus: test.status,
      released: test.results_released_at !== null,
      releasedAt: test.results_released_at?.toISOString() ?? null,
      stats,
      unscored,
      // What stops the button being pressed, stated so the screen can show it
      // rather than only reporting a refusal after the fact.
      blockers: releaseBlockers({ testStatus: test.status, stats, unscored }),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/results/:testId/score — schedule scoring.                   */
  /* ---------------------------------------------------------------------- */
  /**
   * Queues the worker's scoring pass. Returns immediately: marking 25,000
   * attempts does not belong inside a request that a browser is waiting on, and
   * would time out behind the proxy long before it finished.
   *
   * Re-runnable by design. Scoring is deterministic, so running it twice
   * produces the same numbers — which is what makes correcting an answer key
   * and re-scoring a safe thing to do rather than a gamble.
   */
  router.post('/results/:testId/score', async (req, res) => {
    const me = currentUser(req);
    const testId = TestId.parse(req.params.testId);

    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');

    const run = await jobs.requeueJob('mcq_score', testId, pool);
    if (!run) throw badRequest('schedule_failed', 'Could not schedule scoring.');

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'results_score',
        attemptId: null,
        questionId: null,
        before: null,
        after: { testId },
        reason: 'scoring scheduled from the results screen',
      },
      pool,
    );

    log.info({ testId, adminId: me.id }, 'scoring scheduled');
    res.json({ ok: true, job: run.job, status: run.status });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/results/:testId/release — Launch result.                    */
  /* ---------------------------------------------------------------------- */
  const ReleaseSchema = z.object({
    reason: z.string().trim().min(3).max(1000).default('results launched'),
  });

  router.post('/results/:testId/release', async (req, res) => {
    const me = currentUser(req);
    const testId = TestId.parse(req.params.testId);
    const body = ReleaseSchema.parse(req.body ?? {});

    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');

    const [stats, unscored] = await Promise.all([
      results.attemptStats(testId, pool),
      results.countUnscored(testId, pool),
    ]);

    const blockers = releaseBlockers({ testStatus: test.status, stats, unscored });
    if (blockers.length > 0) {
      // Refuse rather than publish part of a cohort. A student whose rank
      // appears an hour after everyone else's has been told, in effect, that
      // the rank list was not final when it was announced.
      throw badRequest(
        'not_ready',
        `Results cannot be launched yet: ${blockers.length} thing${blockers.length === 1 ? '' : 's'} to resolve.`,
        { blockers },
      );
    }

    // Ranks are computed here, at the moment of release, rather than by the
    // scoring pass. A rank is a position in the whole cohort, so it is only
    // final once nothing more will be scored — computing it earlier means
    // publishing a list that was accurate when it was written and is not now.
    const ranking = await results.computeRanks(testId, pool);

    const released = await results.releaseResults({ testId, adminId: me.id }, pool);
    if (!released) {
      res.json({ ok: true, alreadyReleased: true, ranked: ranking.ranked });
      return;
    }

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'results_release',
        attemptId: null,
        questionId: null,
        before: { released: false },
        after: { released: true, ranked: ranking.ranked, topScore: ranking.topScore },
        reason: body.reason,
      },
      pool,
    );

    log.warn(
      { testId, adminId: me.id, ranked: ranking.ranked },
      'results released to students',
    );

    res.json({
      ok: true,
      releasedAt: released.results_released_at.toISOString(),
      ranked: ranking.ranked,
      topScore: ranking.topScore,
      medianScore: ranking.medianScore,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /admin/results/:testId/withdraw — take them back down.             */
  /* ---------------------------------------------------------------------- */
  /**
   * For the case that actually happens: results go out, a wrong answer-key
   * entry is spotted within the hour, and the honest move is to withdraw,
   * correct the key, re-score and publish again.
   *
   * Scores and ranks are left in place. Withdrawing is about visibility, and
   * wiping them would destroy the record of what was published.
   */
  router.post('/results/:testId/withdraw', async (req, res) => {
    const me = currentUser(req);
    const testId = TestId.parse(req.params.testId);
    const body = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);

    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');
    if (test.results_released_at === null) {
      throw badRequest('not_released', 'These results have not been published.');
    }

    await results.withdrawResults(testId, pool);
    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'results_withdraw',
        attemptId: null,
        questionId: null,
        before: { releasedAt: test.results_released_at.toISOString() },
        after: { released: false },
        reason: body.reason,
      },
      pool,
    );

    log.warn({ testId, adminId: me.id }, 'results withdrawn');
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------------- */
  /* GET /admin/attempts/:testId — everyone who sat the paper.               */
  /* ---------------------------------------------------------------------- */
  router.get('/attempts/:testId', async (req, res) => {
    const testId = TestId.parse(req.params.testId);
    const query = z
      .object({
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    const [list, stats] = await Promise.all([
      results.listAttempts({ testId, ...query }, pool),
      results.attemptStats(testId, pool),
    ]);

    res.json({
      testId,
      stats,
      attempts: list.map((row) => ({
        attemptId: row.attempt_id,
        userId: row.user_id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        class: row.class,
        targetYear: row.target_year,
        city: row.city,
        state: row.state,
        status: row.status,
        receipt: row.receipt,
        submittedAt: row.submitted_at?.toISOString() ?? null,
        score: row.total_score === null ? null : Number(row.total_score),
        rank: row.rank,
        percentile: row.percentile === null ? null : Number(row.percentile),
        needsReview: row.needs_review,
      })),
    });
  });

  return router;
}

/**
 * Everything standing between now and a publishable rank list.
 *
 * Returned as sentences rather than codes because they are shown to the person
 * deciding whether to press the button, and "4 attempts have not been scored"
 * is actionable where `UNSCORED_ATTEMPTS` is not.
 */
function releaseBlockers(params: {
  testStatus: string;
  stats: { submitted: number; autoSubmitted: number; scored: number };
  unscored: number;
}): string[] {
  const blockers: string[] = [];
  const sat = params.stats.submitted + params.stats.autoSubmitted;

  if (params.testStatus === 'live') {
    blockers.push('The test is still live. Students are sitting it.');
  }
  if (sat === 0) {
    blockers.push('Nobody has submitted a paper for this test.');
  }
  if (params.unscored > 0) {
    blockers.push(
      `${params.unscored} submitted attempt${params.unscored === 1 ? ' has' : 's have'} not been `
        + 'scored yet. Run scoring and wait for it to finish.',
    );
  }
  return blockers;
}
