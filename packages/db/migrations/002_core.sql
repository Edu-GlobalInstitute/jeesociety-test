-- The core event schema. Three shapes matter here and are explained inline:
-- one row per attempt (not per answer), `revision` as the concurrency guard,
-- and raw_score/score kept separate so the cap policy can change later.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE tests (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,        -- absolute, same for everyone
  lobby_opens_at timestamptz NOT NULL,
  paper_url      text,                        -- R2 URL of the encrypted blob
  paper_key      text,                        -- AES key, NEVER sent before starts_at
  answer_key     jsonb,                       -- {"q1":"B",...} NEVER sent to client
  rubrics        jsonb,                       -- per subjective question
  status         text NOT NULL DEFAULT 'draft',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tests_window_ordered CHECK (lobby_opens_at <= starts_at AND starts_at < ends_at),
  CONSTRAINT tests_status_known CHECK (status IN ('draft','scheduled','live','closed','graded'))
);

-- paper_key and answer_key must never be selected into a response. Queries in
-- packages/db/src/queries/tests.ts use explicit column lists for exactly this
-- reason; there is no SELECT * on this table anywhere in the codebase.
COMMENT ON COLUMN tests.paper_key  IS 'SECRET: released only by GET /attempt/key at/after starts_at';
COMMENT ON COLUMN tests.answer_key IS 'SECRET: read only by the worker, after the test ends';

CREATE TABLE payments (
  id                 bigserial PRIMARY KEY,
  user_id            text NOT NULL REFERENCES "user"("id"),
  test_id            bigint NOT NULL REFERENCES tests(id),
  razorpay_order_id  text NOT NULL,
  razorpay_payment_id text UNIQUE,            -- UNIQUE = webhook idempotency
  amount             integer NOT NULL,        -- paise
  status             text NOT NULL DEFAULT 'created',
  raw_webhook        jsonb,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  CONSTRAINT payments_status_known CHECK (status IN ('created','paid','failed','refunded'))
);
CREATE INDEX ON payments (user_id, test_id);
CREATE UNIQUE INDEX ON payments (razorpay_order_id);
-- The reconciliation job scans this: payments captured whose webhook never arrived.
CREATE INDEX payments_stuck_created_idx ON payments (created_at) WHERE status = 'created';

CREATE TABLE attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL REFERENCES "user"("id"),
  test_id       bigint NOT NULL REFERENCES tests(id),
  -- One JSONB column overwritten on every sync. 75 rows per student would be
  -- 750,000 rows and a slow submit path; there is no answer history table,
  -- because sync_snapshots stores lengths and that is all the history needed.
  answers       jsonb NOT NULL DEFAULT '{}',
  -- The concurrency guard. Every write carries WHERE revision < $new, which
  -- makes out-of-order syncs harmless and lets a student switch devices or keep
  -- two tabs open without corrupting state.
  revision      integer NOT NULL DEFAULT 0,
  telemetry     jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'registered',
  registered_at timestamptz DEFAULT now(),
  key_issued_at timestamptz,
  last_sync_at  timestamptz,
  submitted_at  timestamptz,
  receipt       text UNIQUE,
  mcq_score        numeric,
  subjective_score numeric,
  total_score      numeric,
  needs_review  boolean NOT NULL DEFAULT false,
  flags         jsonb NOT NULL DEFAULT '[]',
  last_ip       inet,
  UNIQUE (user_id, test_id),
  CONSTRAINT attempts_status_known
    CHECK (status IN ('registered','in_progress','submitted','auto_submitted')),
  CONSTRAINT attempts_revision_nonnegative CHECK (revision >= 0)
);

CREATE INDEX ON attempts (test_id, submitted_at);
CREATE INDEX ON attempts (test_id, status);
CREATE INDEX ON attempts (test_id, needs_review) WHERE needs_review;

-- Lengths only, never full text. Powers burst-appearance detection, which is
-- the one anti-cheat signal the client cannot forge: the browser can lie in its
-- telemetry, but it must send the actual answer text, and the server watches
-- how that text grew on its own.
CREATE TABLE sync_snapshots (
  attempt_id uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  revision   integer NOT NULL,
  lengths    jsonb NOT NULL,                  -- {"q61": 310, "q62": 0}
  -- The address this revision arrived from. Carried here rather than in its own
  -- table so the IP-change signal costs no extra write on the hot path.
  ip         inet,
  at         timestamptz DEFAULT now(),
  PRIMARY KEY (attempt_id, revision)
);

CREATE TABLE grading_jobs (
  id            bigserial PRIMARY KEY,
  attempt_id    uuid NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id   text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  attempts_made integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  raw_score     numeric,                      -- 0-4, before the cap
  score         numeric,                      -- after the cap, what counts
  rubric_output jsonb,                        -- the structured LLM response
  feedback      text,
  confidence    text,
  error         text,
  created_at    timestamptz DEFAULT now(),
  completed_at  timestamptz,
  UNIQUE (attempt_id, question_id),
  CONSTRAINT grading_jobs_status_known
    CHECK (status IN ('pending','processing','done','failed'))
);

CREATE INDEX ON grading_jobs (status, id)
  WHERE status IN ('pending', 'processing');
CREATE INDEX ON grading_jobs (attempt_id);
