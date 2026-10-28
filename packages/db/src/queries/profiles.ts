import { one, rows, type Queryable } from '../query.js';

/**
 * Student profiles: the registration fields Better Auth does not own.
 *
 * Nothing here runs during the event. The one query that matters operationally
 * is `isComplete`, which the payment route calls before creating an order.
 */

export interface ProfileRow {
  user_id: string;
  phone: string;
  class: '11' | '12' | 'dropper';
  target_year: number;
  dob: Date | null;
  state: string | null;
  city: string | null;
  school: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  guardian_consent_at: Date | null;
  referral_source: string | null;
  profile_complete: boolean;
}

export function getProfile(userId: string, db?: Queryable): Promise<ProfileRow | null> {
  return one<ProfileRow>(
    `SELECT user_id, phone, class, target_year, dob, state, city, school,
            guardian_name, guardian_phone, guardian_consent_at, referral_source,
            profile_complete
       FROM student_profiles WHERE user_id = $1`,
    [userId],
    db,
  );
}

/**
 * Gate for selling an attempt. A student with no phone number on file is a
 * student we cannot reach if the exam moves, so payment waits for the profile.
 */
export async function isComplete(userId: string, db?: Queryable): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    `SELECT COALESCE(
              (SELECT profile_complete FROM student_profiles WHERE user_id = $1),
              false
            ) AS ok`,
    [userId],
    db,
  );
  return row?.ok ?? false;
}

export interface UpsertProfileParams {
  userId: string;
  phone: string;
  class: '11' | '12' | 'dropper';
  targetYear: number;
  dob: string | null;
  state: string | null;
  city: string | null;
  school: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  /** True only when the student is a minor and ticked the box. */
  guardianConsent: boolean;
  referralSource: string | null;
}

/**
 * Creates or updates the profile. Idempotent on user_id, so a student who
 * submits the form twice (double-click, or a retry after a dropped response)
 * ends with one row rather than a unique-violation page.
 *
 * `profile_complete` is not in the column list on purpose: the trigger in
 * 005_student_profile.sql derives it. Passing it here would let a request body
 * decide whether it can pay.
 *
 * The UNIQUE violation on `phone` is not caught here — it is a distinct error
 * the route turns into "this number is already registered, log in instead",
 * which is different advice from a validation failure.
 */
export async function upsertProfile(
  params: UpsertProfileParams,
  db?: Queryable,
): Promise<ProfileRow> {
  const result = await rows<ProfileRow>(
    `INSERT INTO student_profiles
       (user_id, phone, class, target_year, dob, state, city, school,
        guardian_name, guardian_phone, guardian_consent_at, referral_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $11::boolean THEN now() ELSE NULL END, $12)
     ON CONFLICT (user_id) DO UPDATE SET
       phone = excluded.phone,
       class = excluded.class,
       target_year = excluded.target_year,
       dob = excluded.dob,
       state = excluded.state,
       city = excluded.city,
       school = excluded.school,
       guardian_name = excluded.guardian_name,
       guardian_phone = excluded.guardian_phone,
       -- Consent is kept once given: re-saving the form to fix a typo in the
       -- city must not quietly withdraw it, and re-timestamping it would
       -- misdate the record.
       guardian_consent_at = COALESCE(student_profiles.guardian_consent_at,
                                      excluded.guardian_consent_at),
       referral_source = excluded.referral_source
     RETURNING user_id, phone, class, target_year, dob, state, city, school,
               guardian_name, guardian_phone, guardian_consent_at, referral_source,
               profile_complete`,
    [
      params.userId,
      params.phone,
      params.class,
      params.targetYear,
      params.dob,
      params.state,
      params.city,
      params.school,
      params.guardianName,
      params.guardianPhone,
      params.guardianConsent,
      params.referralSource,
    ],
    db,
  );
  // The upsert always returns a row; this keeps the signature non-nullable.
  return result[0]!;
}

/** True when the number belongs to a different account. Drives the form's hint. */
export async function phoneTakenByOther(
  phone: string,
  userId: string,
  db?: Queryable,
): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    `SELECT EXISTS (
              SELECT 1 FROM student_profiles WHERE phone = $1 AND user_id <> $2
            ) AS ok`,
    [phone, userId],
    db,
  );
  return row?.ok ?? false;
}

/**
 * Which providers an account can sign in with.
 *
 * The site needs this to answer one question honestly: a student who signed up
 * with Google and lands on "forgot password" has no password to reset, and
 * telling them to check their inbox would leave them waiting for an email that
 * is never coming.
 */
export async function authProviders(userId: string, db?: Queryable): Promise<string[]> {
  const list = await rows<{ providerId: string }>(
    `SELECT DISTINCT "providerId" FROM "account" WHERE "userId" = $1`,
    [userId],
    db,
  );
  return list.map((row) => row.providerId);
}
