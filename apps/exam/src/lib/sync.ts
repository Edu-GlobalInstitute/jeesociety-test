import { CLIENT_TIMING, type AnswerMap } from '@jee/shared';
import { ApiError } from './api.js';

/**
 * The sync loop. Runs every 90 seconds for three hours on 10,000 machines.
 *
 * Two behaviours here are worth more than they look:
 *
 *  - **Skip when nothing changed.** If `revision` has not advanced since the
 *    last successful sync, the request is not sent at all. Across a cohort this
 *    drops well over half of all traffic — a student reading a question or
 *    working it out on paper is not generating state to save, and on an
 *    objective paper that is most of the three hours.
 *
 *  - **A stale response is success.** The server answers 200 with `stale: true`
 *    when it already holds a newer revision. Treating that as failure would
 *    produce a retry storm from clients whose only problem is a reordered
 *    packet.
 */

export interface SyncSnapshot {
  attemptId: string;
  revision: number;
  answers: AnswerMap;
}

export interface SyncOutcome {
  status: 'sent' | 'skipped' | 'failed';
  revision?: number;
  stale?: boolean;
  error?: string;
  /** True when the window has closed and the loop should stop trying. */
  stop?: boolean;
}

export interface SyncDeps {
  getSnapshot: () => SyncSnapshot;
  /** Highest revision the server has acknowledged. */
  getSyncedRevision: () => number;
  send: (payload: SyncSnapshot) => Promise<{ ok: true; revision: number; stale: boolean }>;
  onResult: (outcome: SyncOutcome, at: number) => void;
  now: () => number;
}

export async function syncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  const snapshot = deps.getSnapshot();

  if (snapshot.revision <= deps.getSyncedRevision()) {
    const outcome: SyncOutcome = { status: 'skipped' };
    deps.onResult(outcome, deps.now());
    return outcome;
  }

  try {
    const response = await deps.send(snapshot);
    const outcome: SyncOutcome = {
      status: 'sent',
      revision: response.revision,
      stale: response.stale,
    };
    deps.onResult(outcome, deps.now());
    return outcome;
  } catch (error) {
    const outcome: SyncOutcome = {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      // A closed window is not worth retrying: auto-submit has it from here.
      stop: error instanceof ApiError && error.code === 'window_closed',
    };
    deps.onResult(outcome, deps.now());
    return outcome;
  }
}

/** Starts the interval. Returns a function that stops it. */
export function startSyncLoop(deps: SyncDeps, intervalMs = CLIENT_TIMING.syncIntervalMs): () => void {
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    void syncOnce(deps).then((outcome) => {
      if (outcome.stop) {
        stopped = true;
        clearInterval(timer);
      }
    });
  }, intervalMs);

  // One more attempt as the tab goes away. Best-effort: if it does not land,
  // the last successful sync is still on the server and auto-submit covers it.
  const onHidden = () => {
    if (document.visibilityState === 'hidden' && !stopped) void syncOnce(deps);
  };
  document.addEventListener('visibilitychange', onHidden);

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHidden);
  };
}

export type SyncHealth = 'fresh' | 'stale' | 'never';

/**
 * Drives the save indicator. Deliberately coarse: a student does not need a
 * byte counter, they need to know their work is safe, and the only state worth
 * surfacing is "we have not reached the server in a while".
 */
export function syncHealth(lastSyncedAt: number | null, now: number): SyncHealth {
  if (lastSyncedAt === null) return 'never';
  return now - lastSyncedAt > CLIENT_TIMING.staleSyncWarnMs ? 'stale' : 'fresh';
}

export interface SubmitDeps {
  send: () => Promise<{ receipt: string; alreadySubmitted: boolean }>;
  onAttempt: (attempt: number) => void;
  sleep: (ms: number) => Promise<void>;
  schedule?: number[];
}

/**
 * Submit with exponential backoff.
 *
 * If every attempt fails the caller shows "Your answers are saved. We're
 * completing your submission." — which is true, because the last sync is on the
 * server and auto-submit will finalise it ten minutes after the window closes.
 */
export async function submitWithBackoff(
  deps: SubmitDeps,
): Promise<{ receipt: string; alreadySubmitted: boolean } | null> {
  const schedule = deps.schedule ?? CLIENT_TIMING.submitBackoffMs;

  for (let attempt = 0; attempt <= schedule.length; attempt += 1) {
    deps.onAttempt(attempt + 1);
    try {
      return await deps.send();
    } catch (error) {
      // A closed window means auto-submit already owns this attempt.
      if (error instanceof ApiError && error.code === 'window_closed') return null;
      if (attempt === schedule.length) return null;
      await deps.sleep(schedule[attempt]!);
    }
  }
  return null;
}

/**
 * Spreads submission across 45 seconds. 10,000 clients hitting submit at the
 * same instant would be a 10,000-request spike; jittered it is roughly 220/s,
 * which is ordinary traffic.
 */
export function submitDelayMs(random: () => number = Math.random): number {
  return Math.floor(random() * CLIENT_TIMING.submitJitterMs);
}
