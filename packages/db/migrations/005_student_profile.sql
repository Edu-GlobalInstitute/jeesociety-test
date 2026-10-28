-- Student profile: the registration fields Better Auth does not own.
--
-- A separate table rather than columns on "user", for the same reason `admins`
-- is separate (001_auth.sql): a Better Auth upgrade can rewrite its own four
-- tables without touching anything here.
--
-- It also carries the weight of the Google sign-in flow. Google returns an
-- email and a name and nothing else, so a student who signs in that way has a
-- "user" row and no profile. `profile_complete` is what the site reads to
-- decide whether to send them to /complete-profile before checkout, and the
-- payment route reads it too: an attempt must never be sold to a row that has
-- no phone number on it.

CREATE TABLE student_profiles (
  user_id    text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,

  -- Normalised to 10 digits, no country code: see apps/api/src/lib/phone.ts.
  -- UNIQUE enforces one account per number, which is the only real check on a
  -- phone number in a system that sends no OTP (BUILD_PLAN s7.2).
  phone      text NOT NULL UNIQUE,

  class      text NOT NULL CHECK (class IN ('11', '12', 'dropper')),
  -- The year the student sits the actual JEE. Bounded rather than free: a typo
  -- here silently puts them in the wrong cohort of the rank list.
  target_year integer NOT NULL CHECK (target_year BETWEEN 2026 AND 2032),

  dob        date,
  state      text,
  city       text,
  school     text,

  -- Collected only when the student is under 18 on the exam date, and then
  -- both are required together: a consent timestamp with no named guardian is
  -- not consent. Enforced in the zod schema; the CHECK is the backstop.
  guardian_name  text,
  guardian_phone text,
  guardian_consent_at timestamptz,

  referral_source text,

  -- Set by the one transaction that writes a complete profile. Derived rather
  -- than trusted: see trg_student_profiles_complete below.
  profile_complete boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guardian_fields_together CHECK (
    (guardian_consent_at IS NULL AND guardian_name IS NULL AND guardian_phone IS NULL)
    OR (guardian_consent_at IS NOT NULL AND guardian_name IS NOT NULL AND guardian_phone IS NOT NULL)
  )
);

-- Admin filters the student list by these (BUILD_PLAN s13).
CREATE INDEX ON student_profiles (class, target_year);
CREATE INDEX ON student_profiles (state);

-- `profile_complete` is computed from the columns, never taken from the caller.
-- The flag gates payment, so a request body must not be able to set it: this
-- trigger is the difference between "the server decided" and "the client said".
CREATE OR REPLACE FUNCTION student_profiles_set_complete() RETURNS trigger AS $$
BEGIN
  NEW.profile_complete :=
    NEW.phone IS NOT NULL
    AND NEW.class IS NOT NULL
    AND NEW.target_year IS NOT NULL;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_student_profiles_complete
  BEFORE INSERT OR UPDATE ON student_profiles
  FOR EACH ROW EXECUTE FUNCTION student_profiles_set_complete();
