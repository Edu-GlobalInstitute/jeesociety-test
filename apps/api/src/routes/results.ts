import { Router } from 'express';
import { z } from 'zod';
import { REWARD_BANDS } from '@jee/shared';
import { results, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireUser } from '../middleware/session.js';
import { notFound } from '../middleware/errors.js';

/**
 * The student's result.
 *
 * One rule governs this whole file: nothing here returns a mark, a rank or a
 * percentile until `tests.results_released_at` is set. Scoring runs the moment
 * the paper closes, so between submission and the announcement every attempt in
 * the database has a total — and a route that forgot this check would publish
 * the cohort early to anyone who refreshed.
 *
 * Before release the response is a receipt: submitted, when, and that results
 * are coming. Deliberately not a count of attempted questions or an echo of the
 * answers, because results are announced for everyone at once and anything a
 * score can be inferred from is an early release by another name.
 */
export function resultRoutes({ pool, auth }: { pool: Pool; auth: Auth }): Router {
  const router = Router();
  router.use(requireUser(auth));

  /**
   * GET /results/:testId — the scorecard, or the receipt that precedes it.
   */
  router.get('/:testId', async (req, res) => {
    const me = currentUser(req);
    const testId = z.coerce.number().int().positive().parse(req.params.testId);

    const card = await results.getScorecard({ userId: me.id, testId }, pool);
    if (!card) {
      throw notFound('no_attempt', 'You did not sit this test.');
    }

    const submitted = card.submitted_at !== null;
    const released = card.results_released_at !== null;

    // The receipt half, which is all a student sees before the announcement.
    const base = {
      testId: card.test_id,
      testName: card.test_name,
      status: card.status,
      receipt: card.receipt,
      submittedAt: card.submitted_at?.toISOString() ?? null,
      submitted,
      released,
    };

    if (!released) {
      res.json({
        ...base,
        message: submitted
          ? 'Your paper has been submitted. Results will be published for everyone at the '
            + 'same time — we will let you know.'
          : 'This test is over. Our records show no submitted paper for your account.',
      });
      return;
    }

    const total = card.total_score === null ? null : Number(card.total_score);
    const percentile = card.percentile === null ? null : Number(card.percentile);

    res.json({
      ...base,
      releasedAt: card.results_released_at?.toISOString() ?? null,
      score: total,
      rank: card.rank,
      percentile,
      cohortSize: card.cohort_size,
      subjects: card.subject_scores ?? {},
      // The band is derived here rather than stored: it is a function of the
      // percentile and the table in @jee/shared, and storing it would let the
      // two disagree after a bands change.
      rewardBand: percentile === null ? null : bandFor(percentile),
    });
  });

  return router;
}

/**
 * The reward band a percentile falls in, or null for none.
 *
 * REWARD_BANDS is ordered top-down and its floors do not overlap, so the first
 * floor cleared is the band — see the comment on the constant.
 */
function bandFor(percentile: number): { label: string; share: string } | null {
  for (const band of REWARD_BANDS) {
    if (percentile >= band.floor) return { label: band.label, share: band.share };
  }
  return null;
}

/**
 * Which tests this student can ask about, so the site can link to a result
 * without guessing an id.
 */
export function resultIndexRoute({ pool, auth }: { pool: Pool; auth: Auth }): Router {
  const router = Router();
  router.use(requireUser(auth));

  router.get('/', async (_req, res) => {
    const published = await tests.listPublishedTests(pool);
    res.json({
      tests: published.map((test) => ({
        testId: test.id,
        name: test.name,
        kind: test.kind,
        startsAt: test.starts_at.toISOString(),
      })),
    });
  });

  return router;
}
