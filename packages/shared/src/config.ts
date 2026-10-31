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
 * The one thing being given away: a seat in the mentorship programme.
 *
 * Every mention of it on the landing page — the headline, the ticker, the
 * reward ladder, the metadata — reads these fields, so the programme's length,
 * its price and who teaches it cannot drift apart across the site.
 */
export const MENTORSHIP = {
  /** The full programme, and what the top band wins outright. */
  months: 6,
  /** What a seat costs anyone who buys one, in rupees. */
  worthRupees: 10_000,
  /** What the shorter runner-up seat is, in months. */
  runnerUpMonths: 3,
  /** Who teaches it. Quoted verbatim, so it stays accurate. */
  mentors: 'IIT Bombay students',
  /** Half price, for the third band. Derived so the two can never disagree. */
  get halfPriceRupees() {
    return this.worthRupees / 2;
  },
} as const;

/**
 * Reward bands, by percentile in this test's own rank list.
 *
 * The bands do not overlap — a 99.2 percentile student is in the first band
 * only — and they are read top-down, so the first band whose `floor` a student
 * clears is the one they are in. `share` is true by the definition of a
 * percentile rather than a projection: each band is one student in a hundred.
 */
export const REWARD_BANDS = [
  {
    floor: 99,
    label: `${MENTORSHIP.months} months of mentorship, free`,
    share: 'top 1 in 100',
  },
  {
    floor: 98,
    label: `${MENTORSHIP.runnerUpMonths} months of mentorship, free`,
    share: 'the next 1 in 100',
  },
  {
    floor: 97,
    label: `Half off the ${MENTORSHIP.months}-month seat`,
    share: 'the next 1 in 100',
  },
] as const;

/**
 * When the paper opens. ISO-8601 with an explicit offset so every label on the
 * site and the server agree regardless of where either is run. This must match
 * `tests.starts_at` in the database for the test being sold.
 */
export const TEST_STARTS_AT = '2026-11-29T09:00:00+05:30';

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

/**
 * Who the paper is written for, and what a student walks away with.
 *
 * The offer, in numbers. The paper is for students still scoring below
 * `entryCeilingMarks`, or still short of `syllabusCeilingPercent` of the
 * syllabus — either one is enough, because a student can be under the
 * ceiling for either reason. The report that follows is written to be worth
 * `liftMarks`, and `webinarHost` is who takes the class through that report
 * afterwards. Every one of them is read by the landing page and by the ladder
 * in its hero, so they are stated once here rather than typed into the
 * poster.
 */
export const DIAGNOSTIC = {
  /** The paper is for students still under this, out of PAPER.maxMarks. */
  entryCeilingMarks: 150,
  /**
   * The other way in: a student who has not finished more than this much of
   * the syllabus. Marks are not the only reason to be behind.
   */
  syllabusCeilingPercent: 60,
  /** What the report and the webinar are built to add to that score. */
  liftMarks: 100,
  /**
   * Who runs the webinar after the paper. The bare noun, without an article,
   * so a sentence can put "an" in front of it and a label can stand it on its
   * own. Quoted verbatim, so it stays accurate.
   */
  webinarHost: 'IIT Bombay mentor',
} as const;

/* The offer has to be arithmetically possible: a student sitting right at the
   ceiling must still have `liftMarks` left on the paper to win. */
if (DIAGNOSTIC.entryCeilingMarks + DIAGNOSTIC.liftMarks > PAPER.maxMarks) {
  throw new Error(
    `DIAGNOSTIC promises ${DIAGNOSTIC.liftMarks} marks on top of `
    + `${DIAGNOSTIC.entryCeilingMarks}, but the whole paper is worth ${PAPER.maxMarks}.`,
  );
}

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
