import type { FlagCode } from './config.js';

export type AttemptStatus =
  | 'registered'
  | 'in_progress'
  | 'submitted'
  | 'auto_submitted';

export type TestStatus = 'draft' | 'scheduled' | 'live' | 'closed' | 'graded';

/**
 * Whether the exam surface — lobby, paper key, sync, submit — is open.
 *
 * `scheduled` is the on-sale-but-locked state: the public site takes
 * registrations and payments, and the exam app shows a coming-soon screen
 * instead of a lobby. Promoting the row to `live` is the one switch that opens
 * the inside, and it is checked on the server so the lock is not cosmetic.
 */
export function isExamOpen(status: TestStatus): boolean {
  return status === 'live';
}

/**
 * Whether the test has *ever* been open. Submit and resume are allowed in the
 * past tense too: auto-submit moves the row to `closed` ten minutes after the
 * window shuts, and a student fetching their receipt after that must not be
 * told the test does not exist.
 */
export function hasExamOpened(status: TestStatus): boolean {
  return status === 'live' || status === 'closed' || status === 'graded';
}

export type PaymentStatus = 'created' | 'paid' | 'failed' | 'refunded';

/**
 * The two question types. `scq` is single-correct-option; `integer` takes a
 * numeric value typed by the student. Both are marked by comparison against
 * `tests.answer_key` — see scoring.ts.
 */
export type QuestionKind = 'scq' | 'integer';

/** Question ids are strings throughout ("q1".."q75"), never array indices. */
export type QuestionId = string;

/**
 * What the client holds and sends. Keys are question ids; each value is an
 * option key for an `scq` question or a typed number for an `integer` one.
 */
export type AnswerMap = Record<QuestionId, string>;

/** Character lengths per question. What sync_snapshots stores — never the text. */
export type LengthMap = Record<QuestionId, number>;

export interface AttemptFlag {
  code: FlagCode;
  questionId: QuestionId | null;
  /** Evidence a human can read back to a parent on the phone. */
  evidence: Record<string, unknown>;
  at: string;
}

/* -------------------------------------------------------------------------- */
/* Paper                                                                       */
/* -------------------------------------------------------------------------- */

export interface ScqQuestion {
  id: QuestionId;
  kind: 'scq';
  subject: string;
  body: string;
  options: { key: string; body: string }[];
}

/**
 * An integer-answer question. There are no options: the student types a value
 * and the worker compares it numerically against the key, so "12", "12.0" and
 * " 12 " are the same answer.
 */
export interface IntegerQuestion {
  id: QuestionId;
  kind: 'integer';
  subject: string;
  body: string;
  /** Shown next to the input, e.g. "m/s²". Display only — never marked on. */
  unit?: string;
}

export type Question = ScqQuestion | IntegerQuestion;

/**
 * The decrypted paper. Byte-identical for all 10,000 students, which is what
 * makes it a CDN object rather than an API response. It contains no answers.
 */
export interface Paper {
  testId: number;
  name: string;
  durationMinutes: number;
  questions: Question[];
}

/** The envelope stored in R2. The ciphertext decrypts to a `Paper` JSON. */
export interface EncryptedPaper {
  v: 1;
  alg: 'AES-GCM';
  /** base64url, 12 bytes */
  iv: string;
  /** base64url ciphertext including the GCM tag */
  ct: string;
}

/**
 * {"q1": "B", "q61": "12"}. Lives in tests.answer_key and never leaves the
 * server. Every one of the 75 questions has an entry — there is no question in
 * this paper that something other than this map decides.
 */
export type AnswerKey = Record<QuestionId, string>;
