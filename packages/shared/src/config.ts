/**
 * Every tunable number in the system lives here, so that policy changes are a
 * one-line diff rather than a hunt through the codebase.
 */

/**
 * JEE objective marking. Applied server-side only, after the test ends.
 *
 * One rule for the whole paper: single-correct and integer questions are marked
 * identically, which is both current JEE Main policy and the only version that
 * fits on a landing page without a footnote.
 */
export const MCQ_MARKS = {
  correct: 4,
  wrong: -1,
  unattempted: 0,
} as const;

/**
 * What a student pays, in paise. The landing page quotes this and the payment
 * route charges it, so the two cannot drift apart. TEST_FEE_PAISE in the API's
 * environment overrides it; this is the default and the number on the page.
 */
export const TEST_FEE_PAISE = 30_000;

/**
 * Reward bands, by percentile in this test's own rank list.
 *
 * The bands do not overlap — a 99.2 percentile student is in the first band
 * only — and they are read top-down, so the first band whose `floor` a student
 * clears is the one they are in. `share` is true by the definition of a
 * percentile rather than a projection: each band is one student in a hundred.
 */
export const REWARD_BANDS = [
  { floor: 99, label: 'An iPad or an iPhone', share: 'top 1 in 100' },
  { floor: 98, label: 'Mentorship worth ₹10,000', share: 'the next 1 in 100' },
  { floor: 97, label: 'Half off that mentorship', share: 'the next 1 in 100' },
] as const;

/**
 * When the paper opens. ISO-8601 with an explicit offset so the landing
 * page's countdown and the server agree regardless of where either is run.
 * This must match `tests.starts_at` in the database for the test being sold.
 */
export const TEST_STARTS_AT = '2026-11-10T09:00:00+05:30';

/**
 * The paper's shape, in one place.
 *
 * Three subjects, each with 20 single-correct questions and 5 integer-answer
 * ones: 75 questions and 300 marks, the JEE Main pattern. Every question is
 * machine-marked against `tests.answer_key`, so there is no human or model in
 * the scoring path at all.
 */
export const PAPER = {
  subjects: ['physics', 'chemistry', 'maths'],
  scqPerSubject: 20,
  integerPerSubject: 5,
  /** Questions per subject — the size of one navigator section. */
  get perSubject() {
    return this.scqPerSubject + this.integerPerSubject;
  },
  get scqCount() {
    return this.scqPerSubject * this.subjects.length;
  },
  get integerCount() {
    return this.integerPerSubject * this.subjects.length;
  },
  get totalCount() {
    return this.scqCount + this.integerCount;
  },
  /** What a perfect paper is worth. Quoted on the landing page. */
  get maxMarks() {
    return this.totalCount * MCQ_MARKS.correct;
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
  /** A one-shot job claimed by the scheduler is released again after this long. */
  jobLockMs: 5 * 60_000,
  /** A job is marked failed (never silently dropped) after this many tries. */
  jobMaxAttempts: 3,
  /** Payments stuck in `created` older than this are reconciled against Razorpay. */
  paymentReconcileAfterMs: 15 * 60_000,
  /**
   * How long after ends_at a submit is still accepted. The client jitters its
   * submission across 45 s and then retries for another ~31 s, so a hard cutoff
   * at ends_at would reject exactly the submissions the jitter was designed to
   * spread out. Comfortably inside autoSubmitDelayMs, which finalises whatever
   * is left.
   */
  submitGraceMs: 5 * 60_000,
} as const;

export const LIMITS = {
  /** express.json body ceiling. Full state for 75 answers is well under 2 KB. */
  jsonBodyLimit: '256kb',
  /**
   * Per-answer character ceiling, enforced by zod on every sync. An answer is
   * now either an option key ("A") or a number ("-12.5"), so this is tight on
   * purpose: the sync endpoint is no longer a place anyone can post prose.
   */
  maxAnswerChars: 16,
  /** Per-user sync rate. The client syncs at 1 per 90s; this allows retries. */
  syncPerMinute: 2,
  /** Per-IP auth attempts per minute. */
  authPerMinute: 10,
} as const;

/**
 * Review flags. These produce evidence for a human, never a score change.
 *
 * On an all-objective paper there is deliberately only one signal left. The
 * behavioural signals this system used to compute — keystroke-to-character
 * ratio and burst appearance — measured how typed prose grew, and an answer
 * that is one character long has no growth curve to read. Keeping them would
 * have implied a protection that cannot exist, so they are gone rather than
 * dormant.
 */
export type FlagCode = 'ip_change';

/**
 * Review ordering only. Severity never implies guilt and never touches a score —
 * it is how the review queue is sorted so the strongest evidence is read first.
 */
export const FLAG_SEVERITY: Record<FlagCode, number> = {
  ip_change: 1,
};
