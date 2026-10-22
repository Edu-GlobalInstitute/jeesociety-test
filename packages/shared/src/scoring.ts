import { AWARD_CAP, MCQ_MARKS, RUBRIC_MAX_RAW } from './config.js';
import type { AnswerKey, AnswerMap, RubricObservation } from './types.js';

/**
 * Pure scoring. No database, no network, no model. Everything here is a function
 * of its arguments so the whole scoring surface is unit-testable without a test
 * event, and so the same code can be re-run against stored observations if a
 * policy constant ever changes.
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

/**
 * Compares a student's answers against the key. The key is read server-side from
 * tests.answer_key and must never appear in any response — this function is the
 * only place the two meet.
 *
 * Comparison is case-insensitive and whitespace-trimmed: an option recorded as
 * "b" by one client and "B" by another is the same choice, and a student is not
 * penalised for the encoding of their click.
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
    if (given.trim().toUpperCase() === String(expected).trim().toUpperCase()) {
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

export interface RubricScore {
  /** 0..RUBRIC_MAX_RAW, straight from the observations. */
  raw: number;
  /** raw after the cap. This is what counts toward the total. */
  score: number;
  /** True when a human should look at this answer before it stands. */
  needsReview: boolean;
  reviewReasons: string[];
}

/**
 * Reduces the model's structured observations to a number.
 *
 * The cap is applied here, in code, because that is the only way to guarantee it
 * holds across every one of 150,000 calls — a prompt instruction holds only most
 * of the time. raw is returned alongside so the cap policy can change later
 * without re-grading anything.
 */
export function scoreRubric(observation: RubricObservation): RubricScore {
  let raw = 0;

  if (observation.off_topic_or_blank) {
    // Nothing to award against the rubric, but a human decides whether the
    // model simply failed to read the answer. The score is not final here.
    return {
      raw: 0,
      score: 0,
      needsReview: true,
      reviewReasons: ['off_topic_or_blank'],
    };
  }

  if (observation.approach_correct) raw += 1;
  if (observation.setup_correct) raw += 1;
  if (observation.calculation_correct) raw += 1;
  if (observation.final_answer_correct && observation.units_present) raw += 1;

  const reviewReasons: string[] = [];
  if (observation.confidence === 'low') reviewReasons.push('grader_low_confidence');

  return {
    raw: Math.min(raw, RUBRIC_MAX_RAW),
    score: Math.min(raw, AWARD_CAP),
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}

/**
 * Totals an attempt. Subjective scores arrive over days, so this is called again
 * each time grading advances; it tolerates a partially graded attempt.
 */
export function totalScore(mcqScore: number, subjectiveScores: number[]): {
  subjective: number;
  total: number;
} {
  const subjective = subjectiveScores.reduce((sum, s) => sum + s, 0);
  return { subjective, total: mcqScore + subjective };
}
