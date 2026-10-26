import type { AttemptFlag } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

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
