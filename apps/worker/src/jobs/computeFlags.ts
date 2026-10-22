import {
  answerLengths,
  burstAppearanceFlags,
  flagSeverity,
  ipChangeFlags,
  keystrokeRatioFlags,
  mergeFlags,
  type AnswerMap,
  type AttemptFlag,
  type TelemetryMap,
} from '@jee/shared';
import { attempts, type Pool } from '@jee/db';
import type { Logger } from 'pino';

/**
 * Computes the three behavioural signals over the whole cohort.
 *
 * The governing rule, repeated here because it is the one that matters: this
 * job gathers evidence and a human decides. It writes to `flags` and
 * `needs_review` and touches no score column — there is no code path from a
 * flag to a mark.
 *
 * There is deliberately no AI-text detection on answer content. It is
 * unreliable, and it is specifically biased against non-native English writers
 * producing formal technical prose, which describes this entire population. At
 * 10,000 students a 1% false-positive rate wrongly accuses 100 honest students,
 * while anyone who lightly rewords a generated answer passes anyway.
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
      answers: AnswerMap;
      telemetry: TelemetryMap;
      flags: AttemptFlag[];
    }>(
      `SELECT id, answers, telemetry, flags
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

      const found = [
        // Signal 1: client-reported, forgeable only by faking both counters.
        ...keystrokeRatioFlags(answerLengths(row.answers ?? {}), row.telemetry ?? {}),
        // Signal 2: server-derived from the growth curve. The strong one.
        ...burstAppearanceFlags(
          snapshots.map((s) => ({ revision: s.revision, lengths: s.lengths, at: s.at })),
        ),
        // Signal 3: weak alone, useful alongside the others.
        ...ipChangeFlags(
          snapshots
            .filter((s): s is typeof s & { ip: string } => Boolean(s.ip))
            .map((s) => ({ ip: s.ip, at: s.at })),
        ),
      ];

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
  // Expect 300-500 flagged attempts at 10,000 students. An order of magnitude
  // more than that means a threshold is wrong, not that the cohort cheated.
  log.info(summary, 'flag computation complete');
  return summary;
}

export { flagSeverity };
