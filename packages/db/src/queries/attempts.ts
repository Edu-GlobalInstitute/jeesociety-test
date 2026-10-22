import type {
  AnswerMap,
  AttemptFlag,
  AttemptStatus,
  LengthMap,
  TelemetryMap,
} from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

/**
 * The attempt row and the four statements that move it. Three of these run
 * during the event and are the reason the system is safe:
 *
 *   syncAttempt    - guarded by `revision <`, so out-of-order delivery is a no-op
 *   submitAttempt  - guarded by `submitted_at IS NULL`, so it is idempotent
 *   autoSubmitAll  - finalises everything the two above missed (in jobs.ts)
 */

export interface AttemptRow {
  id: string;
  user_id: string;
  test_id: number;
  answers: AnswerMap;
  revision: number;
  telemetry: TelemetryMap;
  status: AttemptStatus;
  registered_at: Date | null;
  key_issued_at: Date | null;
  last_sync_at: Date | null;
  submitted_at: Date | null;
  receipt: string | null;
  mcq_score: number | null;
  subjective_score: number | null;
  total_score: number | null;
  needs_review: boolean;
  flags: AttemptFlag[];
  last_ip: string | null;
}

const ATTEMPT_COLUMNS = `
  id, user_id, test_id, answers, revision, telemetry, status,
  registered_at, key_issued_at, last_sync_at, submitted_at, receipt,
  mcq_score, subjective_score, total_score, needs_review, flags, last_ip
`;

export function getAttempt(attemptId: string, db?: Queryable): Promise<AttemptRow | null> {
  return one<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = $1`,
    [attemptId],
    db,
  );
}

export function getAttemptForUser(
  userId: string,
  testId: number,
  db?: Queryable,
): Promise<AttemptRow | null> {
  return one<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE user_id = $1 AND test_id = $2`,
    [userId, testId],
    db,
  );
}

/**
 * Registration is what admits a student. It happens in the lobby, and after
 * starts_at the route refuses to call this at all — the cutoff is on
 * registration, never on the later key request, so a student whose key call is
 * slow still gets in.
 *
 * ON CONFLICT makes a double-click, a refresh or two open tabs return the same
 * row rather than an error.
 */
export function registerAttempt(
  userId: string,
  testId: number,
  db?: Queryable,
): Promise<AttemptRow | null> {
  return one<AttemptRow>(
    `INSERT INTO attempts (user_id, test_id, status)
          VALUES ($1, $2, 'registered')
     ON CONFLICT (user_id, test_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING ${ATTEMPT_COLUMNS}`,
    [userId, testId],
    db,
  );
}

/** Records that the paper key was handed over and the student is now sitting. */
export function markKeyIssued(attemptId: string, db?: Queryable): Promise<AttemptRow | null> {
  return one<AttemptRow>(
    `UPDATE attempts
        SET key_issued_at = COALESCE(key_issued_at, now()),
            status = CASE WHEN status = 'registered' THEN 'in_progress' ELSE status END
      WHERE id = $1
      RETURNING ${ATTEMPT_COLUMNS}`,
    [attemptId],
    db,
  );
}

export interface SyncResult {
  /** True when this request advanced server state. */
  updated: boolean;
  /** The revision the server now holds — not necessarily the one just sent. */
  revision: number;
}

/**
 * The hot path. Runs ~1.2M times per event.
 *
 * `revision < $revision` is the whole concurrency story: a sync that arrives out
 * of order, or from a second tab that is behind, matches nothing and changes
 * nothing. That is not an error — it is the normal consequence of a flaky
 * network — so the caller returns 200 with the server's current revision and the
 * client carries on at its own pace.
 *
 * `submitted_at IS NULL` means a late sync can never reopen a finalised attempt.
 */
export async function syncAttempt(
  params: {
    attemptId: string;
    userId: string;
    revision: number;
    answers: AnswerMap;
    telemetry: TelemetryMap;
    ip: string | null;
  },
  db?: Queryable,
): Promise<SyncResult> {
  const row = await one<{ updated_revision: number | null; current_revision: number }>(
    `WITH guarded AS (
       UPDATE attempts
          SET answers      = $3,
              telemetry    = $4,
              revision     = $5,
              last_sync_at = now(),
              last_ip      = $6,
              status       = CASE WHEN status = 'registered' THEN 'in_progress'
                                  ELSE status END
        WHERE id = $1
          AND user_id = $2
          AND revision < $5
          AND submitted_at IS NULL
        RETURNING revision
     )
     SELECT (SELECT revision FROM guarded) AS updated_revision,
            a.revision                     AS current_revision
       FROM attempts a
      WHERE a.id = $1 AND a.user_id = $2`,
    [
      params.attemptId,
      params.userId,
      JSON.stringify(params.answers),
      JSON.stringify(params.telemetry),
      params.revision,
      params.ip,
    ],
    db,
  );

  if (!row) return { updated: false, revision: 0 };
  return {
    updated: row.updated_revision !== null,
    revision: row.updated_revision ?? row.current_revision,
  };
}

/**
 * Lengths only — never the text. Recorded even for a stale revision, because a
 * late-arriving revision still describes real state at that point and makes the
 * growth curve more complete. ON CONFLICT DO NOTHING keeps the first writer.
 */
export async function recordSnapshot(
  attemptId: string,
  revision: number,
  lengths: LengthMap,
  ip: string | null,
  db?: Queryable,
): Promise<void> {
  await rows(
    `INSERT INTO sync_snapshots (attempt_id, revision, lengths, ip)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (attempt_id, revision) DO NOTHING`,
    [attemptId, revision, JSON.stringify(lengths), ip],
    db,
  );
}

export interface SnapshotRow {
  revision: number;
  lengths: LengthMap;
  ip: string | null;
  at: Date;
}

export function listSnapshots(attemptId: string, db?: Queryable): Promise<SnapshotRow[]> {
  return rows<SnapshotRow>(
    `SELECT revision, lengths, ip, at
       FROM sync_snapshots
      WHERE attempt_id = $1
      ORDER BY revision ASC`,
    [attemptId],
    db,
  );
}

export interface SubmitResult {
  /** The receipt now on the row — the new one, or the one already there. */
  receipt: string;
  submittedAt: Date;
  /** True when this call found the attempt already submitted and changed nothing. */
  alreadySubmitted: boolean;
}

/**
 * Idempotent finalise. Writes one row and returns; it computes no score and
 * calls no model.
 *
 * `submitted_at IS NULL` is what makes a double-click, a client retry and a
 * racing auto-submit all safe: the first one wins and every later one reads back
 * the same receipt. `revision <= $revision` accepts a submit carrying the state
 * the server already has, which is the common case when the last sync landed.
 */
export async function submitAttempt(
  params: {
    attemptId: string;
    userId: string;
    revision: number;
    answers: AnswerMap;
    telemetry: TelemetryMap;
    receipt: string;
  },
  db?: Queryable,
): Promise<SubmitResult | null> {
  const updated = await one<{ receipt: string; submitted_at: Date }>(
    `UPDATE attempts
        SET answers      = $3,
            telemetry    = $4,
            revision     = GREATEST(revision, $5),
            submitted_at = now(),
            status       = 'submitted',
            receipt      = $6
      WHERE id = $1
        AND user_id = $2
        AND submitted_at IS NULL
        AND revision <= $5
      RETURNING receipt, submitted_at`,
    [
      params.attemptId,
      params.userId,
      JSON.stringify(params.answers),
      JSON.stringify(params.telemetry),
      params.revision,
      params.receipt,
    ],
    db,
  );

  if (updated) {
    return {
      receipt: updated.receipt,
      submittedAt: updated.submitted_at,
      alreadySubmitted: false,
    };
  }

  // Zero rows. Either it was already submitted — the usual case, and a 200 with
  // the existing receipt — or the client is behind the server's revision, which
  // must still finalise rather than leave the attempt open.
  const existing = await one<{ receipt: string | null; submitted_at: Date | null }>(
    `SELECT receipt, submitted_at FROM attempts WHERE id = $1 AND user_id = $2`,
    [params.attemptId, params.userId],
    db,
  );
  if (!existing) return null;

  if (existing.submitted_at && existing.receipt) {
    return {
      receipt: existing.receipt,
      submittedAt: existing.submitted_at,
      alreadySubmitted: true,
    };
  }

  // Not submitted, but the submit carried a revision older than the server's.
  // The server's state is the newer of the two, so finalise what it already
  // holds rather than overwriting it with the client's stale copy.
  const finalised = await one<{ receipt: string; submitted_at: Date }>(
    `UPDATE attempts
        SET submitted_at = now(), status = 'submitted', receipt = $3
      WHERE id = $1 AND user_id = $2 AND submitted_at IS NULL
      RETURNING receipt, submitted_at`,
    [params.attemptId, params.userId, params.receipt],
    db,
  );
  if (!finalised) return null;
  return {
    receipt: finalised.receipt,
    submittedAt: finalised.submitted_at,
    alreadySubmitted: false,
  };
}

/** Appends flags and raises needs_review. Never touches any score column. */
export async function addFlags(
  attemptId: string,
  flags: AttemptFlag[],
  db?: Queryable,
): Promise<void> {
  if (flags.length === 0) return;
  await rows(
    `UPDATE attempts
        SET flags = $2::jsonb,
            needs_review = true
      WHERE id = $1`,
    [attemptId, JSON.stringify(flags)],
    db,
  );
}
