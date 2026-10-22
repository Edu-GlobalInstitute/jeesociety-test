import { jobs, tests, type Pool } from '@jee/db';
import type { Logger } from 'pino';

/**
 * The job the whole design rests on.
 *
 * Ten minutes after the window closes, every attempt still open is finalised
 * from its last synced answers. This is what makes the submit button a
 * convenience: a student whose machine died at minute 178, or whose submit
 * request failed five times, is graded on what the server already holds.
 *
 * It is one UPDATE, so there is no partial sweep to resume, and re-running it
 * matches nothing. Safe to trigger again by hand at any time.
 */
export async function runAutoSubmit(
  testId: number,
  pool: Pool,
  log: Logger,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const { autoSubmitted } = await jobs.autoSubmitAll(testId, pool);
  const report = await jobs.reconciliationReport(testId, pool);

  // Emitted every time, because the shape of this report is how you find out
  // that sync was failing for part of the cohort. A high auto-submit count or
  // a high staleAtClose count both mean something went wrong during the test.
  log.info({ durationMs: Date.now() - started, ...report }, 'auto-submit reconciliation');

  if (report.started > 0) {
    const autoShare = report.autoSubmitted / report.started;
    if (autoShare > 0.1) {
      log.warn(
        { autoShare: Number(autoShare.toFixed(3)), ...report },
        'unusually high auto-submit share — sync was probably failing for part of the cohort',
      );
    }
  }

  await tests.setTestStatus(testId, 'closed', pool);
  return { ...report, autoSubmitted };
}
