import { MCQ_MARKS } from './config.js';
import type { AnswerKey, AnswerMap } from './types.js';

/**
 * Pure scoring. No database, no network, no model. Everything here is a function
 * of its arguments, so the whole scoring surface is unit-testable without a test
 * event and the same code can be re-run against stored answers if a policy
 * constant ever changes.
 */

export interface McqResult {
  score: number;
  correct: number;
  wrong: number;
  unattempted: number;
  /** Per-question outcome, for the admin view and for dispute handling. */
  breakdown: Record<string, 'correct' | 'wrong' | 'unattempted'>;
}

/** An answer counts as attempted only once it is a non-blank string. */
function attempted(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A finite number, or null for anything else — including "" and "1e5000". */
function asNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether a student's answer matches the key.
 *
 * One rule covers both question types, which is why scoring needs no access to
 * the paper — only to the key:
 *
 *  - When the key is a number, the comparison is numeric. That is the integer
 *    questions: "12", "12.0", "+12" and " 12 " are one answer, and a student is
 *    not marked wrong for how their keyboard produced it.
 *  - Otherwise it is a trimmed, case-insensitive string comparison. That is the
 *    single-correct questions: an option recorded as "b" by one client and "B"
 *    by another is the same choice.
 */
export function answerMatches(expected: string, given: string): boolean {
  const expectedNumber = asNumber(expected);
  if (expectedNumber !== null) {
    const givenNumber = asNumber(given);
    return givenNumber !== null && givenNumber === expectedNumber;
  }
  return given.trim().toUpperCase() === expected.trim().toUpperCase();
}

/**
 * Compares a student's answers against the key. The key is read server-side from
 * tests.answer_key and must never appear in any response — this function is the
 * only place the two meet.
 *
 * The key has an entry for all 75 questions, so iterating it covers the whole
 * paper: a question the student never opened is counted as unattempted rather
 * than skipped.
 */
export function scoreMcq(answerKey: AnswerKey, answers: AnswerMap): McqResult {
  let score = 0;
  let correct = 0;
  let wrong = 0;
  let unattempted = 0;
  const breakdown: McqResult['breakdown'] = {};

  for (const [questionId, expected] of Object.entries(answerKey)) {
    const given = answers[questionId];
    if (!attempted(given)) {
      unattempted += 1;
      score += MCQ_MARKS.unattempted;
      breakdown[questionId] = 'unattempted';
      continue;
    }
    if (answerMatches(String(expected), given)) {
      correct += 1;
      score += MCQ_MARKS.correct;
      breakdown[questionId] = 'correct';
    } else {
      wrong += 1;
      score += MCQ_MARKS.wrong;
      breakdown[questionId] = 'wrong';
    }
  }

  return { score, correct, wrong, unattempted, breakdown };
}
