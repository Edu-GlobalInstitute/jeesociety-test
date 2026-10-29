-- Two-factor authentication, and the admin session rules that go with it.
--
-- Why this exists: before it, an admin was a student account with a row in
-- `admins`. The same eight-character minimum and the same twelve-hour session
-- protected one student's test attempt and the whole question bank, the answer
-- key, and 5,500 students' phone numbers. A reused or phished password was
-- total compromise.
--
-- A second admin-only password would not have fixed that. It is typed into the
-- same browser the session cookie already lives in, so a keylogger or a
-- convincing phishing page captures both. What raises the bar is a factor the
-- attacker does not hold -- a phone -- which is what TOTP is.
--
-- Better Auth owns the `twoFactor` table and the `user.twoFactorEnabled` flag.
-- They are written out here rather than generated at runtime for the same
-- reason 001_auth.sql writes out the other four: every column in the database
-- should be reviewable in this directory, and a schema change should be a
-- migration with a number rather than a surprise on boot.
--
-- Verify against `npx @better-auth/cli generate` after any Better Auth upgrade.
-- Checked against better-auth 1.1.14, src/plugins/two-factor/schema.ts.

/* -------------------------------------------------------------------------- */
/* 1. Better Auth's two-factor tables                                         */
/* -------------------------------------------------------------------------- */

-- camelCase and quoted, because Better Auth's query builder quotes them;
-- unquoted identifiers fold to lowercase and would never match.
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean NOT NULL DEFAULT false;

-- One row per user with 2FA set up.
--
-- `secret` is the TOTP shared secret and `backupCodes` the recovery codes. Both
-- are marked `returned: false` in the plugin's schema, meaning Better Auth
-- never serialises them into a response -- the same discipline tests.paper_key
-- gets, and for the same reason: either one is a complete bypass of the second
-- factor.
--
-- No `enabled` column, despite the plugin's TypeScript interface naming one.
-- The authoritative flag is "user"."twoFactorEnabled"; the row's existence and
-- that flag are what the plugin actually reads. Adding an unused third source
-- of truth would be a column that could disagree with the other two.
CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id"          text PRIMARY KEY,
  "secret"      text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId"      text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor" ("userId");

COMMENT ON COLUMN "twoFactor"."secret" IS
  'SECRET: the TOTP shared secret. Never selected into a response.';
COMMENT ON COLUMN "twoFactor"."backupCodes" IS
  'SECRET: recovery codes. Shown once at setup and never again.';

/* -------------------------------------------------------------------------- */
/* 2. Admin access: how it was granted, and by whom                           */
/* -------------------------------------------------------------------------- */

-- `admins` existed as (user_id, note, created_at) -- enough to answer "is this
-- person an admin" and nothing else. These columns answer the question that
-- matters after an incident: who granted this, when, and is 2FA required of
-- them.
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS granted_by text REFERENCES "user"("id") ON DELETE SET NULL;

-- Whether this admin must hold a verified second factor.
--
-- Default true, so an admin row created by hand in the Neon console -- which is
-- how the first one is always created -- is covered without anyone remembering
-- to set it. The grace period below is what makes that workable rather than a
-- lockout.
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS require_2fa boolean NOT NULL DEFAULT true;

-- Until this instant, an admin without 2FA may still use the portal, so that
-- the person who was just granted access can get in and set it up. After it,
-- requireAdmin refuses them until they do.
--
-- Seven days rather than forever, because a grace period with no end is just a
-- switch nobody turns off. Seven days rather than an hour, because the
-- alternative to "I will do it tomorrow" is being locked out of your own
-- portal on a Sunday.
ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS mfa_grace_until timestamptz
    DEFAULT (now() + interval '7 days');

-- Existing admin rows predate this column and would otherwise have a NULL
-- grace period, which reads as "expired" and locks them out on deploy.
UPDATE admins
   SET mfa_grace_until = now() + interval '7 days'
 WHERE mfa_grace_until IS NULL;

COMMENT ON COLUMN admins.require_2fa IS
  'Default true: an admin row created by hand in SQL is covered without anyone remembering.';
COMMENT ON COLUMN admins.mfa_grace_until IS
  'Admin access without 2FA is allowed until this instant, so a new admin can set it up.';

/* -------------------------------------------------------------------------- */
/* 3. Admin sign-in attempts                                                  */
/* -------------------------------------------------------------------------- */

-- Every attempt to use an admin route, successful or not.
--
-- Separate from admin_audit, which records actions that changed something. This
-- records reaching for the door, including the attempts that were turned away:
-- "someone has been trying this account from an address in another country for
-- three days" is a sentence admin_audit can never produce, because none of
-- those attempts changed anything to log.
--
-- Append-only, like admin_audit. No UPDATE or DELETE on this table anywhere in
-- the codebase.
CREATE TABLE IF NOT EXISTS admin_access_log (
  id         bigserial PRIMARY KEY,
  -- Nullable: a refusal may be from someone with no account at all.
  user_id    text REFERENCES "user"("id") ON DELETE SET NULL,
  -- Recorded as typed, so a refused attempt on an address that does not exist
  -- is still attributable to something.
  email      text,
  outcome    text NOT NULL,
  path       text,
  ip         inet,
  user_agent text,
  at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_access_outcome_known CHECK (
    outcome IN ('granted', 'no_session', 'not_admin', 'mfa_required', 'mfa_stale')
  )
);

-- The two reads this table is for: one admin's recent history, and everything
-- that was refused lately.
CREATE INDEX IF NOT EXISTS admin_access_log_user_idx ON admin_access_log (user_id, at DESC);
CREATE INDEX IF NOT EXISTS admin_access_log_refused_idx ON admin_access_log (at DESC)
  WHERE outcome <> 'granted';

COMMENT ON TABLE admin_access_log IS
  'Append-only record of admin access attempts, including refusals. No UPDATE or DELETE anywhere.';
