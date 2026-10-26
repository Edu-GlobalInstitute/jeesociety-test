import { flagSeverity, ipChangeFlags, mergeFlags, type AttemptFlag } from '@jee/shared';
import { attempts, type Pool } from '@jee/db';
import type { Logger } from 'pino';

/**
 * Computes the review signals over the whole cohort.
 *
 * The governing rule, repeated here because it is the one that matters: this
 * job gathers evidence and a human decides. It writes to `flags` and
 * `needs_review` and touches no score column — there is no code path from a
 * flag to a mark.
 *
 * On an all-objective paper one signal is left, and it is the weak one: a
 * change of IP address mid-attempt. The behavioural signals that used to carry
 * this job read the growth curve of typed prose, and a one-character answer has
 * none. Nothing has replaced them, because nothing honest can: there is no way
 * to tell a student who picked (C) themselves from one who was told to, and a
 * detector that guessed would wrongly accuse hundreds of this cohort. Expect
 * this job to flag a large share of the cohort on mobile networks — read its
 * output as "worth a glance beside the submission times", not as a finding.
 */
export async function runComputeFlags(
  testId: number,
  pool: Pool,
  log: Logger,
  batchSize = 200,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let examined = 0;
  let flagged = 0;
  const byCode: Record<string, number> = {};
  let lastId = '00000000-0000-0000-0000-000000000000';

  for (;;) {
    const batch = await pool.query<{
      id: string;
      flags: AttemptFlag[];
    }>(
      `SELECT id, flags
         FROM attempts
        WHERE test_id = $1 AND key_issued_at IS NOT NULL AND id > $2
        ORDER BY id
        LIMIT $3`,
      [testId, lastId, batchSize],
    );
    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      examined += 1;
      const snapshots = await attempts.listSnapshots(row.id, pool);

      const found = ipChangeFlags(
        snapshots
          .filter((s): s is typeof s & { ip: string } => Boolean(s.ip))
          .map((s) => ({ ip: s.ip, at: s.at })),
      );

      if (found.length === 0) continue;

      // Merged by (code, questionId), so re-running this job is idempotent and
      // does not multiply flags on an attempt that was already examined.
      const merged = mergeFlags(row.flags ?? [], found);
      await attempts.addFlags(row.id, merged, pool);

      flagged += 1;
      for (const flag of found) byCode[flag.code] = (byCode[flag.code] ?? 0) + 1;
    }

    lastId = batch.rows[batch.rows.length - 1]!.id;
  }

  const summary = {
    testId,
    examined,
    flagged,
    byCode,
    durationMs: Date.now() - started,
  };
  log.info(summary, 'flag computation complete');
  return summary;
}

export { flagSeverity };
