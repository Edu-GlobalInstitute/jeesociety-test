-- Operational tables: one-shot job bookkeeping and the admin audit trail.

-- Every one-shot worker job (auto-submit, MCQ scoring, enqueue-grading, flag
-- computation, reconciliation) is a row here rather than a timer in process
-- memory. That is what makes the worker killable at any moment: on restart it
-- re-reads the table and continues. `run_after` schedules, `locked_until`
-- leases, and UNIQUE (job, test_id) means a double-trigger cannot run twice.
CREATE TABLE job_runs (
  id            bigserial PRIMARY KEY,
  job           text NOT NULL,
  test_id       bigint REFERENCES tests(id),
  status        text NOT NULL DEFAULT 'pending',
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  attempts_made integer NOT NULL DEFAULT 0,
  result        jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  UNIQUE (job, test_id),
  CONSTRAINT job_runs_status_known
    CHECK (status IN ('pending','running','done','failed'))
);
CREATE INDEX job_runs_claimable_idx ON job_runs (run_after)
  WHERE status IN ('pending', 'running');

-- Score overrides and any other admin action that changes a student's outcome.
-- Append-only: there is no UPDATE or DELETE on this table anywhere in the code.
CREATE TABLE admin_audit (
  id         bigserial PRIMARY KEY,
  admin_id   text NOT NULL REFERENCES "user"("id"),
  action     text NOT NULL,
  attempt_id uuid REFERENCES attempts(id),
  question_id text,
  before     jsonb,
  after      jsonb,
  reason     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_audit (attempt_id);
CREATE INDEX ON admin_audit (admin_id, at);
