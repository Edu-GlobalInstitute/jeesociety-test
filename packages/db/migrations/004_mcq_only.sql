-- The paper became all-objective: 75 machine-marked questions, 20 single-correct
-- and 5 integer-answer per subject. Nothing is read by a model any more, so the
-- subjective half of the schema goes with it.
--
-- Written as a forward migration rather than an edit to 002 so that an already
-- migrated database — the Neon dev instance included — reaches the new shape
-- without being dropped and re-created.

-- The LLM grading queue: one row per subjective answer, holding the structured
-- observation, the raw and capped scores, and the model's confidence. There is
-- no replacement table, because scoring an objective paper is a pure function
-- of attempts.answers and tests.answer_key (see scoring.ts) and needs no
-- bookkeeping to resume.
DROP TABLE IF EXISTS grading_jobs;

-- Per-question rubrics, which only ever shaped a grading prompt.
ALTER TABLE tests DROP COLUMN IF EXISTS rubrics;

-- subjective_score was summed from grading_jobs; total_score is now always
-- equal to mcq_score and remains the single column results and ranking read.
ALTER TABLE attempts DROP COLUMN IF EXISTS subjective_score;

-- Keystroke and paste counters. They existed to feed the keystroke-ratio
-- signal, which measured how typed prose grew; a one-character answer has no
-- growth to measure, so the counters are no longer collected on the hot path.
ALTER TABLE attempts DROP COLUMN IF EXISTS telemetry;

COMMENT ON COLUMN tests.answer_key IS
  'SECRET: read only by the worker, after the test ends. One entry for all 75 questions.';
