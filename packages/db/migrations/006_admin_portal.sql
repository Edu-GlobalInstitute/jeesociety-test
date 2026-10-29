-- The admin portal: an editable question bank, more than one test, and a sales
-- pipeline over the students who have already signed up.
--
-- Three things arrive here, and the order matters because each rests on the one
-- before it:
--
--   1. `tests.kind` — a mock test is free and open to anyone signed in; the
--      scholarship test is the paid one. Until now there was exactly one test
--      and `getCurrentTest` returned it, so "which test" was never a question.
--   2. `questions` — the question bank. The paper used to exist only as an
--      encrypted blob built by a CLI from a hand-written JSON file, which meant
--      there was nothing in the database to edit. These rows are the editable
--      source; `tests.paper_url` stays the thing students download.
--   3. `lead_pipeline` / `lead_notes` — sales state beside a student, not a
--      copy of one. Name, phone and email already live in "user" and
--      student_profiles, and duplicating them here would mean two numbers for
--      one student and no way to say which is current.

/* -------------------------------------------------------------------------- */
/* 1. Tests become plural                                                      */
/* -------------------------------------------------------------------------- */

-- 'scholarship' is the default because the one existing row is the scholarship
-- test, and a default of 'mock' would silently make it free.
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'scholarship';

ALTER TABLE tests
  DROP CONSTRAINT IF EXISTS tests_kind_known;
ALTER TABLE tests
  ADD CONSTRAINT tests_kind_known CHECK (kind IN ('mock', 'scholarship'));

-- Whether entering costs money. Derived from `kind` on insert, but kept as its
-- own column so that a free scholarship-shaped test (a pilot, a re-run for
-- students whose centre lost power) does not need a schema change or a lie
-- about what kind of test it is.
--
-- The exam routes read this, not `kind`: authorisation should turn on the thing
-- that means "must have paid" rather than on a label beside it.
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS requires_payment boolean NOT NULL DEFAULT true;

UPDATE tests SET requires_payment = (kind = 'scholarship')
 WHERE requires_payment IS DISTINCT FROM (kind = 'scholarship');

-- How long a student gets. The paper blob already carries durationMinutes for
-- the client; this is the server's copy, so a compile can read it from the test
-- rather than being told it twice.
ALTER TABLE tests
  ADD COLUMN IF NOT EXISTS duration_minutes integer NOT NULL DEFAULT 180;
ALTER TABLE tests
  DROP CONSTRAINT IF EXISTS tests_duration_positive;
ALTER TABLE tests
  ADD CONSTRAINT tests_duration_positive CHECK (duration_minutes > 0);

-- Students browse "the mocks" and "the scholarship test" separately, and the
-- dashboard orders both by when they open.
CREATE INDEX IF NOT EXISTS tests_kind_starts_idx ON tests (kind, starts_at DESC);

COMMENT ON COLUMN tests.kind IS
  'mock = free practice, open to any signed-in student. scholarship = the paid event.';
COMMENT ON COLUMN tests.requires_payment IS
  'Checked by /attempt/register. Authorisation turns on this, not on kind.';

/* -------------------------------------------------------------------------- */
/* 2. The question bank                                                        */
/* -------------------------------------------------------------------------- */

-- One row per question per test, and the editable source of truth for a paper.
--
-- `correct_answer` lives here, in the same row as the question it belongs to.
-- That is deliberate: the old shape kept questions in a JSON file and answers
-- in a separate `answerKey` object, and the CLI needed four validation rules
-- just to catch the ways the two could disagree — a key for a question that
-- does not exist, a question with no key, a key naming an option the question
-- does not have. A single row cannot drift from itself.
--
-- The answer still never reaches a student. `tests.answer_key` is compiled from
-- this column at launch and stays server-side, and the blob published to the
-- CDN is built from the other columns only (see compilePaper in
-- queries/questions.ts). This table is admin-read-only by virtue of there being
-- no student-facing route that touches it.
CREATE TABLE IF NOT EXISTS questions (
  id              bigserial PRIMARY KEY,
  test_id         bigint NOT NULL REFERENCES tests(id) ON DELETE CASCADE,

  -- The paper-facing id ("q1".."q75"). Not the primary key: a question can be
  -- re-ordered or replaced while the student-visible numbering stays stable,
  -- and attempts.answers is keyed by this string for the life of the attempt.
  question_ref    text NOT NULL,

  subject         text NOT NULL,
  kind            text NOT NULL,
  -- Order within the subject, which is what decides paper order. Not globally
  -- unique: physics #1 and maths #1 both exist.
  --
  -- Named sort_order rather than `position`, which is a reserved word in SQL
  -- (the position(x in y) function). Unquoted in a CHECK or an ORDER BY it is a
  -- parse hazard, and quoting it everywhere forever is worse than a clear name.
  sort_order      integer NOT NULL,

  body            text NOT NULL,
  -- [{"key":"A","body":"...","imageUrl":null}, ...] for scq; [] for integer.
  -- JSONB rather than an options table: options are never queried
  -- independently of their question, and a four-row join per question across
  -- 75 questions buys nothing a single column does not already give.
  options         jsonb NOT NULL DEFAULT '[]',

  -- The option key ("B") for scq, or the numeric value as typed ("12") for
  -- integer. Text for both so one column holds both kinds without a union.
  correct_answer  text,

  -- Figures. Separate from the body so a question can be edited without
  -- re-uploading its diagram, and so a missing image is visible as a NULL
  -- rather than a broken tag inside prose.
  image_url       text,
  solution_text   text,
  solution_image_url text,

  -- Display only, never marked on — same as IntegerQuestion.unit in shared.
  unit            text,
  marks_correct   numeric NOT NULL DEFAULT 4,
  marks_wrong     numeric NOT NULL DEFAULT -1,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Two questions numbered q12 in one paper is a paper that cannot be marked.
  UNIQUE (test_id, question_ref),
  CONSTRAINT questions_kind_known CHECK (kind IN ('scq', 'integer')),
  CONSTRAINT questions_sort_order_positive CHECK (sort_order > 0),

  -- An scq needs options and an integer question must not have any. Enforced
  -- here rather than in the route because a bulk upload of 75 questions is the
  -- most likely place for this to go wrong, and a CHECK fails the one bad row
  -- instead of letting it through a loop.
  CONSTRAINT questions_options_match_kind CHECK (
    (kind = 'scq'     AND jsonb_array_length(options) >= 2)
    OR
    (kind = 'integer' AND jsonb_array_length(options) = 0)
  ),

  -- An integer question's answer has to be a number, because scoring compares
  -- it numerically: a non-numeric key can never match anything a student types,
  -- so every student would score zero on it. NULL is allowed — that is a
  -- question still being written, and `launch` is what refuses to publish it.
  CONSTRAINT questions_integer_answer_numeric CHECK (
    kind <> 'integer'
    OR correct_answer IS NULL
    OR correct_answer ~ '^-?[0-9]+(\.[0-9]+)?$'
  )
);

CREATE INDEX IF NOT EXISTS questions_test_order_idx
  ON questions (test_id, subject, sort_order);

-- Which questions are not finished. Drives the "12 questions incomplete"
-- warning in the designer and the refusal to launch.
CREATE INDEX IF NOT EXISTS questions_incomplete_idx
  ON questions (test_id) WHERE correct_answer IS NULL;

COMMENT ON COLUMN questions.correct_answer IS
  'SECRET: compiled into tests.answer_key at launch. No student-facing route selects this column.';

-- updated_at honestly, rather than whenever a route remembers to set it.
CREATE OR REPLACE FUNCTION questions_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_questions_touch ON questions;
CREATE TRIGGER trg_questions_touch
  BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION questions_touch_updated_at();

/* -------------------------------------------------------------------------- */
/* 3. The sales pipeline                                                       */
/* -------------------------------------------------------------------------- */

-- Sales state beside a student, keyed by the same user id.
--
-- There is no name, phone or email column here on purpose. Those live in "user"
-- and student_profiles, where phone is already NOT NULL and UNIQUE; a copy here
-- would be a second number for one student with nothing to say which is right.
-- The CRM list is a join, not a table.
--
-- A row is created lazily — the first time someone sets a stage or writes a
-- note. A student with no row is a lead in the 'new' stage, which `leadBoard`
-- expresses with a LEFT JOIN and COALESCE rather than by backfilling a row for
-- all 5,500 existing students.
CREATE TABLE IF NOT EXISTS lead_pipeline (
  user_id      text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  stage        text NOT NULL DEFAULT 'new',
  -- Who is working this lead. NULL is unassigned, which the board shows as its
  -- own column so nobody has to remember to look for them.
  owner_id     text REFERENCES "user"("id") ON DELETE SET NULL,
  -- Free-text, from a fixed list in the UI. Not a CHECK: sales reasons change
  -- more often than schemas should, and a wrong label here harms nothing.
  lost_reason  text,
  next_follow_up_at timestamptz,
  last_contacted_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- 'paid' is not in this list. Whether a student has paid is a payments row,
  -- and a stage that could disagree with it would be a second answer to a
  -- question that already has one. The board derives the paid column from
  -- payments and shows it beside the stage.
  CONSTRAINT lead_stage_known CHECK (
    stage IN ('new', 'contacted', 'interested', 'not_interested', 'lost')
  )
);

CREATE INDEX IF NOT EXISTS lead_pipeline_stage_idx ON lead_pipeline (stage);
CREATE INDEX IF NOT EXISTS lead_pipeline_owner_idx ON lead_pipeline (owner_id, stage);
-- The follow-up list: who is due, soonest first.
CREATE INDEX IF NOT EXISTS lead_pipeline_followup_idx
  ON lead_pipeline (next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

COMMENT ON TABLE lead_pipeline IS
  'Sales state only. Name/phone/email come from "user" and student_profiles.';
COMMENT ON COLUMN lead_pipeline.stage IS
  'No paid stage: payment is a payments row, derived on read.';

CREATE OR REPLACE FUNCTION lead_pipeline_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_pipeline_touch ON lead_pipeline;
CREATE TRIGGER trg_lead_pipeline_touch
  BEFORE UPDATE ON lead_pipeline
  FOR EACH ROW EXECUTE FUNCTION lead_pipeline_touch_updated_at();

-- The contact log: append-only, one row per call, message or note.
--
-- Append-only for the same reason admin_audit is: "we called on the 3rd and
-- they asked us to call back after boards" is a record, and a record that can
-- be edited afterwards is not evidence of anything. There is no UPDATE or
-- DELETE against this table anywhere in the code.
CREATE TABLE IF NOT EXISTS lead_notes (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  author_id  text NOT NULL REFERENCES "user"("id"),
  -- What happened, not what was decided. The stage change is a separate write.
  channel    text NOT NULL DEFAULT 'note',
  body       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_notes_channel_known CHECK (
    channel IN ('note', 'call', 'whatsapp', 'email', 'sms', 'stage_change')
  ),
  CONSTRAINT lead_notes_body_present CHECK (length(btrim(body)) > 0)
);

-- The timeline on one student's card: newest first.
CREATE INDEX IF NOT EXISTS lead_notes_user_idx ON lead_notes (user_id, at DESC);

COMMENT ON TABLE lead_notes IS
  'Append-only contact log. No UPDATE or DELETE on this table anywhere in the codebase.';

/* -------------------------------------------------------------------------- */
/* 4. Where a compiled paper blob lives                                       */
/* -------------------------------------------------------------------------- */

-- The encrypted paper, stored in Postgres so that launching a test from the
-- browser needs no object store configured.
--
-- The design intent is unchanged: the paper is a public, cacheable, immutable
-- blob and the secret is the AES key, which stays in tests.paper_key. What
-- changes is only where the bytes sit. R2 remains the right home for the
-- scholarship test — 25,000 students fetching the same object at 09:00:00 is
-- precisely what a CDN is for, and an API route serving it would put that
-- stampede through one Render instance. The API route exists because mock tests
-- need to be launchable now, by someone with a browser and no S3 credentials.
--
-- tools/build-paper still uploads to R2 and writes an R2 URL; this table is
-- only read when paper_url points back at the API. Both paths write the same
-- two columns on `tests`, so nothing downstream has to know which was used.
CREATE TABLE IF NOT EXISTS paper_blobs (
  test_id    bigint PRIMARY KEY REFERENCES tests(id) ON DELETE CASCADE,
  -- The serialised EncryptedPaper envelope: {"v":1,"alg":"AES-GCM","iv":..,"ct":..}.
  -- Ciphertext only. Without tests.paper_key this is noise, which is why it is
  -- safe for the route that serves it to be unauthenticated and cached.
  body       bytea NOT NULL,
  -- Content hash, used as the URL's cache-busting segment and as the ETag. A
  -- re-launch changes the digest, so a student holding the previous blob gets
  -- the new one instead of a stale cache hit.
  sha256     text NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE paper_blobs IS
  'Encrypted paper ciphertext. Public by design: the secret is tests.paper_key.';

/* -------------------------------------------------------------------------- */
/* 5. Question images                                                         */
/* -------------------------------------------------------------------------- */

-- Figures for questions, options and solutions.
--
-- In Postgres rather than an object store, for the same reason paper_blobs is:
-- the designer has to work for someone with a browser and no S3 credentials,
-- and a diagram that cannot be uploaded is a question that cannot be written.
-- The volume is small and bounded — a 75-question paper carries perhaps 40
-- figures of a few hundred KB — so this is a few megabytes per paper, not a
-- growing blob store. The upload route caps each file and rejects anything
-- that is not an image.
--
-- These are served to students (a figure is part of the question), so the route
-- that serves them is public and cached hard. They are keyed by a random id
-- rather than a filename so that one cannot be guessed from another, which
-- matters before a paper opens: the ciphertext is safe without its key, but a
-- figure is a figure.
CREATE TABLE IF NOT EXISTS question_images (
  id          text PRIMARY KEY,
  test_id     bigint REFERENCES tests(id) ON DELETE CASCADE,
  uploaded_by text REFERENCES "user"("id") ON DELETE SET NULL,
  mime_type   text NOT NULL,
  size_bytes  integer NOT NULL,
  body        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Only raster formats the client can draw without a plugin. SVG is excluded
  -- deliberately: it is a document that can carry script, and these are served
  -- from the API's own origin.
  CONSTRAINT question_images_type_known CHECK (
    mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  ),
  CONSTRAINT question_images_size_sane CHECK (size_bytes > 0 AND size_bytes <= 5242880)
);

CREATE INDEX IF NOT EXISTS question_images_test_idx ON question_images (test_id, created_at DESC);

COMMENT ON TABLE question_images IS
  'Question figures. Served publicly by id: a figure is part of the question a student reads.';
