import type { SubjectScores } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

/**
 * Results: ranking the cohort, releasing it, and reading one student's card.
 *
 * The ordering rule throughout is that nothing student-facing reads a score
 * until `tests.results_released_at` is set. Scoring happens the moment the
 * paper closes; publishing is a separate decision taken later, for everyone at
 * once. Keeping them apart is what lets the worker start immediately without
 * anyone being able to see a partial rank list.
 */

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

export interface RankSummary {
  ranked: number;
  topScore: number | null;
  medianScore: number | null;
}

/**
 * Computes rank and percentile for every scored attempt, in one statement.
 *
 * Standard competitive ranking (1, 2, 2, 4): two students on the same marks
 * share a rank, and the next rank skips. `rank()` rather than `dense_rank()`
 * because a student asking "where did I come out of 25,000" means position,
 * not distinct-score position — telling someone they are 1,200th when 4,000
 * people scored above them would be indefensible.
 *
 * Percentile is the share of the cohort scoring strictly below, which is the
 * JEE definition: the top student is 100, and nobody is 0 unless they are last
 * outright. Computed from the same window pass so the two can never disagree.
 *
 * One UPDATE over the whole test rather than a row at a time. At 25,000
 * attempts the per-row version is 25,000 round trips to Neon — minutes of
 * them — and leaves a half-ranked cohort if it dies in the middle.
 */
export async function computeRanks(testId: number, db?: Queryable): Promise<RankSummary> {
  await rows(
    `WITH ranked AS (
       SELECT id,
              rank() OVER (ORDER BY total_score DESC) AS position,
              -- The share scoring strictly below this attempt. percent_rank()
              -- gives exactly that, as a 0..1 fraction over the window.
              round((percent_rank() OVER (ORDER BY total_score ASC) * 100)::numeric, 3)
                AS pct
         FROM attempts
        WHERE test_id = $1
          AND submitted_at IS NOT NULL
          AND total_score IS NOT NULL
     )
     UPDATE attempts a
        SET rank = r.position,
            percentile = r.pct
       FROM ranked r
      WHERE a.id = r.id`,
    [testId],
    db,
  );

  const summary = await one<{ ranked: number; top: number | null; median: number | null }>(
    `SELECT count(*)::int AS ranked,
            max(total_score) AS top,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY total_score) AS median
       FROM attempts
      WHERE test_id = $1 AND rank IS NOT NULL`,
    [testId],
    db,
  );

  return {
    ranked: summary?.ranked ?? 0,
    topScore: summary?.top ?? null,
    medianScore: summary?.median ?? null,
  };
}

/** Attempts that were submitted but carry no score. Blocks a release. */
export async function countUnscored(testId: number, db?: Queryable): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM attempts
      WHERE test_id = $1 AND submitted_at IS NOT NULL AND total_score IS NULL`,
    [testId],
    db,
  );
  return row?.n ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Release                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Publishes the results.
 *
 * Idempotent on purpose: the guard means a second press cannot re-date a
 * release that already happened, which would move the published timestamp
 * every time someone clicked. Returns null when it was already released, so
 * the caller can say so rather than reporting a success that did nothing.
 */
export function releaseResults(
  params: { testId: number; adminId: string },
  db?: Queryable,
): Promise<{ results_released_at: Date } | null> {
  return one<{ results_released_at: Date }>(
    `UPDATE tests
        SET results_released_at = now(),
            results_released_by = $2
      WHERE id = $1 AND results_released_at IS NULL
      RETURNING results_released_at`,
    [params.testId, params.adminId],
    db,
  );
}

/**
 * Withdraws a release.
 *
 * Exists for the case that actually happens: results go out, a wrong answer key
 * entry is spotted within the hour, and the honest move is to pull them,
 * correct the key, re-score and publish again. Without this the only options
 * are leaving wrong results up or editing the database by hand.
 *
 * Scores and ranks are left alone — withdrawing is about visibility, and
 * clearing them here would destroy the evidence of what was published.
 */
export async function withdrawResults(testId: number, db?: Queryable): Promise<void> {
  await rows(
    `UPDATE tests
        SET results_released_at = NULL, results_released_by = NULL
      WHERE id = $1`,
    [testId],
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* Reading a scorecard                                                         */
/* -------------------------------------------------------------------------- */

export interface ScorecardRow {
  attempt_id: string;
  test_id: number;
  test_name: string;
  status: string;
  receipt: string | null;
  submitted_at: Date | null;
  total_score: string | null;
  rank: number | null;
  percentile: string | null;
  subject_scores: SubjectScores | null;
  cohort_size: number;
  results_released_at: Date | null;
}

/**
 * One student's result, with the release state attached.
 *
 * The release check is part of this query rather than a separate read, so there
 * is no window in which a caller holds a score and then looks up whether it may
 * show it. The route still refuses on `results_released_at` being null — this
 * returns the fact, not the permission.
 */
export function getScorecard(
  params: { userId: string; testId: number },
  db?: Queryable,
): Promise<ScorecardRow | null> {
  return one<ScorecardRow>(
    `SELECT a.id AS attempt_id, a.test_id, t.name AS test_name, a.status, a.receipt,
            a.submitted_at, a.total_score, a.rank, a.percentile, a.subject_scores,
            (SELECT count(*)::int FROM attempts c
              WHERE c.test_id = a.test_id AND c.rank IS NOT NULL) AS cohort_size,
            t.results_released_at
       FROM attempts a
       JOIN tests t ON t.id = a.test_id
      WHERE a.user_id = $1 AND a.test_id = $2`,
    [params.userId, params.testId],
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* The admin's attempt list                                                    */
/* -------------------------------------------------------------------------- */

export interface AttemptListRow {
  attempt_id: string;
  user_id: string;
  name: string | null;
  email: string;
  phone: string | null;
  class: string | null;
  target_year: number | null;
  city: string | null;
  state: string | null;
  status: string;
  receipt: string | null;
  submitted_at: Date | null;
  total_score: string | null;
  rank: number | null;
  percentile: string | null;
  needs_review: boolean;
}

/**
 * Everyone who sat the paper, with the details an admin needs beside them.
 *
 * Ordered by rank when there is one, so the list reads as a merit list after
 * release and as an arrival list before it.
 */
export function listAttempts(
  params: { testId: number; limit?: number; offset?: number; search?: string },
  db?: Queryable,
): Promise<AttemptListRow[]> {
  const limit = Math.min(params.limit ?? 100, 1000);
  const search = params.search?.trim();

  return rows<AttemptListRow>(
    `SELECT a.id AS attempt_id, a.user_id, u."name", u."email",
            p.phone, p.class, p.target_year, p.city, p.state,
            a.status, a.receipt, a.submitted_at,
            a.total_score, a.rank, a.percentile, a.needs_review
       FROM attempts a
       JOIN "user" u ON u."id" = a.user_id
       LEFT JOIN student_profiles p ON p.user_id = a.user_id
      WHERE a.test_id = $1
        AND ($4::text IS NULL
             OR u."name" ILIKE $4 OR u."email" ILIKE $4 OR p.phone ILIKE $4
             OR a.receipt ILIKE $4)
      ORDER BY a.rank ASC NULLS LAST, a.submitted_at DESC NULLS LAST
      LIMIT $2 OFFSET $3`,
    [params.testId, limit, params.offset ?? 0, search ? `%${search}%` : null],
    db,
  );
}

export interface AttemptStats {
  registered: number;
  submitted: number;
  autoSubmitted: number;
  scored: number;
  ranked: number;
  needsReview: number;
}

/** The counts above the attempt list. */
export async function attemptStats(testId: number, db?: Queryable): Promise<AttemptStats> {
  const row = await one<Record<string, string>>(
    `SELECT
       count(*) FILTER (WHERE status = 'registered')     AS registered,
       count(*) FILTER (WHERE status = 'submitted')      AS submitted,
       count(*) FILTER (WHERE status = 'auto_submitted') AS auto_submitted,
       count(*) FILTER (WHERE total_score IS NOT NULL)   AS scored,
       count(*) FILTER (WHERE rank IS NOT NULL)          AS ranked,
       count(*) FILTER (WHERE needs_review)              AS needs_review
     FROM attempts WHERE test_id = $1`,
    [testId],
    db,
  );

  return {
    registered: Number(row?.registered ?? 0),
    submitted: Number(row?.submitted ?? 0),
    autoSubmitted: Number(row?.auto_submitted ?? 0),
    scored: Number(row?.scored ?? 0),
    ranked: Number(row?.ranked ?? 0),
    needsReview: Number(row?.needs_review ?? 0),
  };
}
