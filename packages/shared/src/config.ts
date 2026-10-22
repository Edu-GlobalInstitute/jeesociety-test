/**
 * Every tunable number in the system lives here, so that policy changes are a
 * one-line diff rather than a hunt through the codebase. Nothing in this file
 * may be read from a prompt or from the client's request body — in particular
 * AWARD_CAP is enforced in code (see scoring.ts), never asked of the model.
 */

/** JEE objective marking. Applied server-side only, after the test ends. */
export const MCQ_MARKS = {
  correct: 4,
  wrong: -1,
  unattempted: 0,
} as const;

/**
 * Maximum mark a single subjective answer can earn after the rubric observations
 * are reduced to a number. raw_score (0-4) is stored alongside so this policy can
 * change later without re-grading 150,000 answers.
 */
export const AWARD_CAP = 3;

/** Highest raw score the rubric reducer can produce, before the cap. */
export const RUBRIC_MAX_RAW = 4;

export const PAPER = {
  mcqCount: 60,
  subjectiveCount: 15,
  get totalCount() {
    return this.mcqCount + this.subjectiveCount;
  },
} as const;

export const CLIENT_TIMING = {
  /** IndexedDB write debounce. The student's protection against a refresh. */
  idbDebounceMs: 300,
  /** Server sync cadence. Worst-case loss on a dead laptop. */
  syncIntervalMs: 90_000,
  /** Quiet warning threshold on the sync indicator. Not alarming language. */
  staleSyncWarnMs: 4 * 60_000,
  /** Submission is spread across this window to flatten the end-of-test spike. */
  submitJitterMs: 45_000,
  /** Exponential backoff schedule for submit retries. */
  submitBackoffMs: [1_000, 2_000, 4_000, 8_000, 16_000],
  /** Lobby opens this far before starts_at. Also the registration window. */
  lobbyLeadMs: 30 * 60_000,
  /** How often the client re-syncs its clock offset with the server. */
  clockResyncMs: 5 * 60_000,
} as const;

export const SERVER_TIMING = {
  /** Auto-submit sweeps unsubmitted attempts this long after ends_at. */
  autoSubmitDelayMs: 10 * 60_000,
  /** A grading job claimed by a lane is released again after this long. */
  gradingLockMs: 5 * 60_000,
  /** A grading job is marked failed (never silently dropped) after this many tries. */
  gradingMaxAttempts: 3,
  /** Payments stuck in `created` older than this are reconciled against Razorpay. */
  paymentReconcileAfterMs: 15 * 60_000,
} as const;

export const LIMITS = {
  /** express.json body ceiling. Full state for 75 answers gzips to ~10 KB. */
  jsonBodyLimit: '256kb',
  /** Per-answer character ceiling, enforced by zod on every sync. */
  maxAnswerChars: 5_000,
  /** Per-user sync rate. The client syncs at 1 per 90s; this allows retries. */
  syncPerMinute: 2,
  /** Per-IP auth attempts per minute. */
  authPerMinute: 10,
} as const;

/** Anti-cheat thresholds. These produce flags for a human, never score changes. */
export const FLAGS = {
  /** Keystroke ratio is only meaningful once an answer is substantial. */
  keystrokeMinAnswerLen: 200,
  /** Below this ratio of keystrokes to characters, flag for review. */
  keystrokeRatio: 0.4,
  /** Growth in one sync interval that no one types by hand. */
  burstDeltaChars: 400,
} as const;

export type FlagCode =
  | 'low_keystroke_ratio'
  | 'burst_appearance'
  | 'ip_change'
  | 'grader_low_confidence'
  | 'off_topic_or_blank';

/**
 * Review ordering only. Severity never implies guilt and never touches a score —
 * it is how the review queue is sorted so the strongest evidence is read first.
 */
export const FLAG_SEVERITY: Record<FlagCode, number> = {
  burst_appearance: 3,
  low_keystroke_ratio: 2,
  off_topic_or_blank: 2,
  grader_low_confidence: 1,
  ip_change: 1,
};
