-- Results: scored when the paper closes, visible only when you say so.
--
-- The two are deliberately separate. Scoring 25,000 attempts takes time and
-- must start the moment the window shuts; publishing is a decision made later,
-- for everyone at once. Without a flag between them, the only way to hold
-- results back is to not score — which turns "launch the results" into a job
-- that runs while students are refreshing the page.
--
-- So: the worker scores into attempts.total_score as soon as the test closes,
-- and nothing student-facing reads it until results_released_at is set.

/* -------------------------------------------------------------------------- */
/* 1. The switch                                                              */
/* -------------------------------------------------------------------------- */

ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS results_released_at timestamptz;

-- Who pressed it. Not for blame: when a result is disputed weeks later, the
-- question is always "when was this published and by whom", and admin_audit
-- answers it only if someone remembers to look there.
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS results_released_by text REFERENCES "user"("id") ON DELETE SET NULL;

COMMENT ON COLUMN tests.results_released_at IS
  'NULL = scored but not published. Every student-facing result route checks this.';

/* -------------------------------------------------------------------------- */
/* 2. Rank and percentile, computed once                                      */
/* -------------------------------------------------------------------------- */

-- Stored rather than computed per request.
--
-- A rank is a position in the whole cohort, so calculating it on read means
-- ranking 25,000 rows every time one student loads their scorecard — and they
-- all load it within the same few minutes of the announcement. Computed once at
-- release, read as a column thereafter.
--
-- They are also *stable* this way. A rank recomputed on every read would shift
-- under a student if a late attempt were scored afterwards, and a scorecard
-- that says 1,247 one minute and 1,248 the next is not a scorecard.
ALTER TABLE attempts
  ADD COLUMN IF NOT EXISTS rank integer;

ALTER TABLE attempts
  ADD COLUMN IF NOT EXISTS percentile numeric(6, 3);

ALTER TABLE attempts
  DROP CONSTRAINT IF EXISTS attempts_percentile_range;
ALTER TABLE attempts
  ADD CONSTRAINT attempts_percentile_range
    CHECK (percentile IS NULL OR (percentile >= 0 AND percentile <= 100));

ALTER TABLE attempts
  DROP CONSTRAINT IF EXISTS attempts_rank_positive;
ALTER TABLE attempts
  ADD CONSTRAINT attempts_rank_positive CHECK (rank IS NULL OR rank > 0);

-- The rank list itself: every scored attempt for a test, best first. This is
-- the index the release job writes through and the scorecard reads back.
CREATE INDEX IF NOT EXISTS attempts_rank_idx
  ON attempts (test_id, rank)
  WHERE rank IS NOT NULL;

COMMENT ON COLUMN attempts.rank IS
  'All-India rank within this test. Written once by the release job, never per request.';

/* -------------------------------------------------------------------------- */
/* 3. Per-subject marks                                                       */
/* -------------------------------------------------------------------------- */

-- The scorecard breaks the total down by subject, and recomputing that per
-- request means decrypting the paper to find out which subject each question
-- belonged to. Stored as JSONB at scoring time instead:
--
--   {"physics": {"correct": 18, "wrong": 4, "unattempted": 3, "marks": 68}, ...}
--
-- JSONB rather than columns because the subject list lives in @jee/shared and a
-- fourth subject should not need a migration.
ALTER TABLE attempts
  ADD COLUMN IF NOT EXISTS subject_scores jsonb;

COMMENT ON COLUMN attempts.subject_scores IS
  'Per-subject correct/wrong/unattempted/marks, written by mcq_score. Never computed on read.';
