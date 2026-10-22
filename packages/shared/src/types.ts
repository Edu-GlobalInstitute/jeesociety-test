import type { FlagCode } from './config.js';
export type { RubricObservation } from './grading.js';
import type { RubricObservation } from './grading.js';

export type AttemptStatus =
  | 'registered'
  | 'in_progress'
  | 'submitted'
  | 'auto_submitted';

export type TestStatus = 'draft' | 'scheduled' | 'live' | 'closed' | 'graded';

export type GradingJobStatus = 'pending' | 'processing' | 'done' | 'failed';

export type PaymentStatus = 'created' | 'paid' | 'failed' | 'refunded';

export type QuestionKind = 'mcq' | 'subjective';

/** Question ids are strings throughout ("q1".."q75"), never array indices. */
export type QuestionId = string;

/** What the client holds and sends. Keys are question ids. */
export type AnswerMap = Record<QuestionId, string>;

/** Per-subjective-question counters. Counters only — never keystroke streams. */
export interface QuestionTelemetry {
  keystrokes: number;
  pastes: number;
  pastedChars: number;
}

export type TelemetryMap = Record<QuestionId, QuestionTelemetry>;

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

export interface McqQuestion {
  id: QuestionId;
  kind: 'mcq';
  subject: string;
  body: string;
  options: { key: string; body: string }[];
}

export interface SubjectiveQuestion {
  id: QuestionId;
  kind: 'subjective';
  subject: string;
  body: string;
}

export type Question = McqQuestion | SubjectiveQuestion;

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

/* -------------------------------------------------------------------------- */
/* Grading                                                                     */
/* -------------------------------------------------------------------------- */

export interface Rubric {
  questionId: QuestionId;
  /** Model-facing statement of what a full-credit answer contains. */
  statement: string;
  /** What each of the four marks is for. */
  marks: {
    approach: string;
    setup: string;
    calculation: string;
    final_answer: string;
  };
  /** 2-3 worked anchors. Few-shot anchors beat any instruction about strictness. */
  examples: {
    answer: string;
    observation: RubricObservation;
    note: string;
  }[];
}

export type RubricMap = Record<QuestionId, Rubric>;

/** {"q1": "B", ...}. Lives in tests.answer_key and never leaves the server. */
export type AnswerKey = Record<QuestionId, string>;
