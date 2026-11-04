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

/** What a scorecard shows for one subject. */
export interface SubjectScore {
  correct: number;
  wrong: number;
  unattempted: number;
  marks: number;
}

export type SubjectScores = Record<string, SubjectScore>;

/**
 * Rolls a per-question breakdown up by subject.
 *
 * Separate from scoreMcq because the two know different things: scoring needs
 * only the answer key, while this needs to know which subject each question
 * belongs to — which lives in the paper, not the key.
 *
 * Computed once at scoring time and stored on the attempt. Doing it per request
 * would mean decrypting the paper every time a student opened their scorecard,
 * which is both slow and a reason to hold the paper key somewhere it is not
 * needed.
 *
 * A question whose subject is not in `subjectByQuestion` is counted under
 * 'unknown' rather than dropped: a scorecard whose subject marks do not add up
 * to the total is worse than one with an odd row, because the student cannot
 * tell which number to trust.
 */
export function scoreBySubject(
  breakdown: McqResult['breakdown'],
  subjectByQuestion: Record<string, string>,
): SubjectScores {
  const out: SubjectScores = {};

  for (const [questionId, outcome] of Object.entries(breakdown)) {
    const subject = subjectByQuestion[questionId] ?? 'unknown';
    const row = out[subject] ?? { correct: 0, wrong: 0, unattempted: 0, marks: 0 };

    if (outcome === 'correct') {
      row.correct += 1;
      row.marks += MCQ_MARKS.correct;
    } else if (outcome === 'wrong') {
      row.wrong += 1;
      row.marks += MCQ_MARKS.wrong;
    } else {
      row.unattempted += 1;
      row.marks += MCQ_MARKS.unattempted;
    }

    out[subject] = row;
  }

  return out;
}
