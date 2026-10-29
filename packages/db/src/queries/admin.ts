import type { AttemptFlag } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

/** The single administrator account provisioned for this deployment. */
const BOOTSTRAP_ADMIN_EMAIL = 'jeesocietydev@gmail.com';

/** Admin-only reads and the audit trail. Nothing here runs during the event. */

export async function isAdmin(userId: string, db?: Queryable): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM admins WHERE user_id = $1) AS ok`,
    [userId],
    db,
  );
  return row?.ok ?? false;
}

export interface ReviewQueueRow {
  attempt_id: string;
  user_id: string;
  email: string;
  status: string;
  receipt: string | null;
  flags: AttemptFlag[];
  flag_count: number;
  severity: number;
  mcq_score: number | null;
  total_score: number | null;
}

/**
 * The review queue, sorted by severity then flag count so the strongest evidence
 * is read first.
 *
 * Severity is computed in SQL from the same weights as
 * packages/shared/src/config.ts FLAG_SEVERITY; the two are asserted equal by a
 * test rather than kept in sync by hand.
 *
 * On an all-objective paper `ip_change` is the only flag there is, so this queue
 * is a list of attempts worth a glance rather than the ranked evidence pile it
 * was when answers were prose. Read it next to the submission times; an address
 * change on a mobile network is ordinary.
 */
export function reviewQueue(
  testId: number,
  limit = 500,
  db?: Queryable,
): Promise<ReviewQueueRow[]> {
  return rows<ReviewQueueRow>(
    `SELECT a.id AS attempt_id, a.user_id, u."email" AS email, a.status, a.receipt,
            a.flags, jsonb_array_length(a.flags) AS flag_count,
            COALESCE((
              SELECT sum(CASE f ->> 'code'
                           WHEN 'ip_change' THEN 1
                           ELSE 0 END)
                FROM jsonb_array_elements(a.flags) AS f
            ), 0) AS severity,
            a.mcq_score, a.total_score
       FROM attempts a
       JOIN "user" u ON u."id" = a.user_id
      WHERE a.test_id = $1 AND a.needs_review
      ORDER BY severity DESC, flag_count DESC, a.id
      LIMIT $2`,
    [testId, limit],
    db,
  );
}

/**
 * Records an admin action that changed a student's outcome. Append-only; there
 * is no UPDATE or DELETE against admin_audit anywhere in the codebase.
 */
export async function logAdminAction(
  params: {
    adminId: string;
    action: string;
    attemptId: string | null;
    questionId: string | null;
    before: unknown;
    after: unknown;
    reason: string;
  },
  db?: Queryable,
): Promise<void> {
  await rows(
    `INSERT INTO admin_audit
       (admin_id, action, attempt_id, question_id, before, after, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.adminId,
      params.action,
      params.attemptId,
      params.questionId,
      JSON.stringify(params.before ?? null),
      JSON.stringify(params.after ?? null),
      params.reason,
    ],
    db,
  );
}

/** Clears the review flag once a human has looked. Flags stay for the record. */
export async function resolveReview(attemptId: string, db?: Queryable): Promise<void> {
  await rows(`UPDATE attempts SET needs_review = false WHERE id = $1`, [attemptId], db);
}

export interface LiveStats {
  registered: number;
  inProgress: number;
  submitted: number;
  autoSubmitted: number;
  syncsLastMinute: number;
  syncsLast5Minutes: number;
  staleOver4Minutes: number;
  flagged: number;
}

/**
 * The during-test dashboard. The number that matters is staleOver4Minutes: it
 * answers "is sync working across the whole cohort" with a count rather than a
 * guess.
 */
export async function liveStats(testId: number, db?: Queryable): Promise<LiveStats> {
  const row = await one<Record<string, number>>(
    `SELECT
       count(*) FILTER (WHERE status = 'registered')      AS registered,
       count(*) FILTER (WHERE status = 'in_progress')     AS in_progress,
       count(*) FILTER (WHERE status = 'submitted')       AS submitted,
       count(*) FILTER (WHERE status = 'auto_submitted')  AS auto_submitted,
       count(*) FILTER (WHERE last_sync_at > now() - interval '1 minute')  AS syncs_1m,
       count(*) FILTER (WHERE last_sync_at > now() - interval '5 minutes') AS syncs_5m,
       count(*) FILTER (WHERE status = 'in_progress'
                          AND (last_sync_at IS NULL
                               OR last_sync_at < now() - interval '4 minutes')) AS stale,
       count(*) FILTER (WHERE needs_review)               AS flagged
     FROM attempts WHERE test_id = $1`,
    [testId],
    db,
  );
  return {
    registered: Number(row?.registered ?? 0),
    inProgress: Number(row?.in_progress ?? 0),
    submitted: Number(row?.submitted ?? 0),
    autoSubmitted: Number(row?.auto_submitted ?? 0),
    syncsLastMinute: Number(row?.syncs_1m ?? 0),
    syncsLast5Minutes: Number(row?.syncs_5m ?? 0),
    staleOver4Minutes: Number(row?.stale ?? 0),
    flagged: Number(row?.flagged ?? 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Admin security                                                             */
/* -------------------------------------------------------------------------- */

export interface AdminStandingRow {
  is_admin: boolean;
  require_2fa: boolean;
  /** True once the grace period for setting up 2FA has passed. */
  grace_expired: boolean;
  /** From "user"."twoFactorEnabled": whether a second factor is set up. */
  two_factor_enabled: boolean;
  granted_by: string | null;
  granted_at: Date | null;
  mfa_grace_until: Date | null;
}

/**
 * Everything requireAdmin needs, in one query.
 *
 * One round trip rather than three, because this runs on every single admin
 * request — and because reading the admin row and the 2FA flag separately
 * leaves a window in which they disagree.
 *
 * `isAdmin` above is kept: the review and event-console routes only ever asked
 * the yes-or-no question, and widening it would make every caller carry fields
 * it does not use.
 */
export async function adminStanding(
  userId: string,
  db?: Queryable,
): Promise<AdminStandingRow> {
  const row = await one<AdminStandingRow>(
    `SELECT
       true AS is_admin,
       a.require_2fa,
       -- NULL grace reads as expired: a row with no grace period is one that
       -- was never granted one, and the safe reading of that is "no grace".
       (a.mfa_grace_until IS NULL OR a.mfa_grace_until <= now()) AS grace_expired,
       COALESCE(u."twoFactorEnabled", false) AS two_factor_enabled,
       a.granted_by,
       a.created_at AS granted_at,
       a.mfa_grace_until
     FROM admins a
     JOIN "user" u ON u."id" = a.user_id
     WHERE a.user_id = $1
       AND lower(u."email") = lower($2)`,
    [userId, BOOTSTRAP_ADMIN_EMAIL],
    db,
  );

  return (
    row ?? {
      is_admin: false,
      require_2fa: true,
      grace_expired: true,
      two_factor_enabled: false,
      granted_by: null,
      granted_at: null,
      mfa_grace_until: null,
    }
  );
}

/**
 * Records an attempt to reach an admin route, granted or refused.
 *
 * Append-only. Refusals are the point: an attempt that changes nothing writes
 * no admin_audit row, so without this there is no trace of someone trying an
 * admin account repeatedly and failing.
 *
 * Never throws. This is instrumentation on the authorisation path, and a
 * logging failure must not be able to lock an admin out of their own portal —
 * so a broken insert is swallowed rather than propagated.
 */
export async function logAdminAccess(
  params: {
    userId: string | null;
    email: string | null;
    outcome: 'granted' | 'no_session' | 'not_admin' | 'mfa_required' | 'mfa_stale';
    path: string | null;
    ip: string | null;
    userAgent: string | null;
  },
  db?: Queryable,
): Promise<void> {
  try {
    await rows(
      `INSERT INTO admin_access_log
         (user_id, email, outcome, path, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.userId,
        params.email,
        params.outcome,
        params.path,
        params.ip,
        params.userAgent?.slice(0, 500) ?? null,
      ],
      db,
    );
  } catch {
    // Deliberately silent. See the note above.
  }
}

export interface AccessLogRow {
  id: number;
  email: string | null;
  outcome: string;
  path: string | null;
  ip: string | null;
  user_agent: string | null;
  at: Date;
}

/** Recent admin access attempts, newest first. Drives the security screen. */
export function recentAdminAccess(
  options: { refusedOnly?: boolean; limit?: number } = {},
  db?: Queryable,
): Promise<AccessLogRow[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  return rows<AccessLogRow>(
    `SELECT id, email, outcome, path, ip::text AS ip, user_agent, at
       FROM admin_access_log
      ${options.refusedOnly ? `WHERE outcome <> 'granted'` : ''}
      ORDER BY at DESC, id DESC
      LIMIT $1`,
    [limit],
    db,
  );
}

/** The admin list, for the security screen. */
export function listAdminAccounts(
  db?: Queryable,
): Promise<
  {
    user_id: string;
    name: string | null;
    email: string;
    note: string | null;
    require_2fa: boolean;
    two_factor_enabled: boolean;
    mfa_grace_until: Date | null;
    granted_by_email: string | null;
    created_at: Date;
  }[]
> {
  return rows(
    `SELECT a.user_id, u."name", u."email", a.note, a.require_2fa,
            COALESCE(u."twoFactorEnabled", false) AS two_factor_enabled,
            a.mfa_grace_until,
            g."email" AS granted_by_email,
            a.created_at
       FROM admins a
       JOIN "user" u ON u."id" = a.user_id
       LEFT JOIN "user" g ON g."id" = a.granted_by
      ORDER BY a.created_at`,
    [],
    db,
  );
}

/**
 * Grants admin access by email address.
 *
 * Returns null when no such account exists, which is the common case rather
 * than an error: admin is granted to someone who has already signed up, and
 * there is no row in "user" to reference until they have. Creating a shell
 * account here would mean an admin row whose password nobody set.
 *
 * The new admin gets their own grace period from the column default, because
 * they have to be able to sign in before they can set up an authenticator.
 */
export async function grantAdmin(
  params: { email: string; note: string; grantedBy: string },
  db?: Queryable,
): Promise<{ user_id: string } | null> {
  return one<{ user_id: string }>(
    `INSERT INTO admins (user_id, note, granted_by)
     SELECT u."id", $2, $3 FROM "user" u WHERE lower(u."email") = lower($1)
     ON CONFLICT (user_id) DO UPDATE SET
       note = excluded.note,
       granted_by = excluded.granted_by
     RETURNING user_id`,
    [params.email, params.note, params.grantedBy],
    db,
  );
}

/**
 * Removes admin access, unless doing so would leave nobody who can get in.
 *
 * "Nobody who can get in" means no remaining admin with a second factor
 * actually set up — not merely no remaining admin row. An admin whose grace
 * period has expired without setting up an authenticator is refused by
 * requireAdmin, so counting them as a survivor would be counting someone who
 * is already locked out.
 *
 * The guard is a condition on the DELETE rather than a check before it, so two
 * admins revoking each other at the same instant cannot both pass a
 * pre-flight read and leave zero.
 */
export async function revokeAdmin(userId: string, db?: Queryable): Promise<boolean> {
  const deleted = await rows<{ user_id: string }>(
    `DELETE FROM admins
      WHERE user_id = $1
        AND EXISTS (
          SELECT 1 FROM admins a
          JOIN "user" u ON u."id" = a.user_id
          WHERE a.user_id <> $1
            AND COALESCE(u."twoFactorEnabled", false)
        )
      RETURNING user_id`,
    [userId],
    db,
  );
  return deleted.length > 0;
}
