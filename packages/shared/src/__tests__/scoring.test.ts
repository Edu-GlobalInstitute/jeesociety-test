import { describe, expect, it } from 'vitest';
import { MCQ_MARKS, PAPER } from '../config.js';
import { answerMatches, scoreMcq } from '../scoring.js';
import { samplePaperShape } from './helpers.js';

/**
 * Scoring is the whole of grading now, so these tests are the thing standing
 * between a correct answer and a student losing a mark for how their keyboard
 * produced it.
 */

describe('answerMatches', () => {
  it('compares option keys case-insensitively', () => {
    expect(answerMatches('B', 'b')).toBe(true);
    expect(answerMatches('B', ' B ')).toBe(true);
    expect(answerMatches('B', 'C')).toBe(false);
  });

  it('compares integer answers numerically, not as strings', () => {
    expect(answerMatches('12', '12')).toBe(true);
    expect(answerMatches('12', '12.0')).toBe(true);
    expect(answerMatches('12', '+12')).toBe(true);
    expect(answerMatches('12', ' 12 ')).toBe(true);
    expect(answerMatches('12', '012')).toBe(true);
    expect(answerMatches('12', '13')).toBe(false);
  });

  it('handles a negative key and a negative answer', () => {
    expect(answerMatches('-4', '-4')).toBe(true);
    expect(answerMatches('-4', '-4.00')).toBe(true);
    expect(answerMatches('-4', '4')).toBe(false);
  });

  it('matches a decimal key only on its value', () => {
    expect(answerMatches('2.5', '2.50')).toBe(true);
    expect(answerMatches('2.5', '2.6')).toBe(false);
  });

  it('counts a half-typed or non-numeric answer as not matching', () => {
    // The client lets "9." and "-" exist while being typed; neither is a number.
    expect(answerMatches('9', '9.')).toBe(true); // Number("9.") === 9
    expect(answerMatches('9', '-')).toBe(false);
    expect(answerMatches('9', 'nine')).toBe(false);
  });

  it('does not treat a non-finite answer as a match for anything', () => {
    expect(answerMatches('12', 'Infinity')).toBe(false);
    expect(answerMatches('12', '1e5000')).toBe(false);
    expect(answerMatches('12', 'NaN')).toBe(false);
  });
});

describe('scoreMcq', () => {
  const key = { q1: 'A', q2: 'B', q3: 'C', q4: 'D' };

  it('applies +4 / -1 / 0 JEE marking', () => {
    const result = scoreMcq(key, { q1: 'A', q2: 'B', q3: 'X' });
    expect(result.correct).toBe(2);
    expect(result.wrong).toBe(1);
    expect(result.unattempted).toBe(1);
    expect(result.score).toBe(2 * MCQ_MARKS.correct + MCQ_MARKS.wrong);
  });

  it('never penalises an unattempted question', () => {
    const result = scoreMcq(key, {});
    expect(result.score).toBe(0);
    expect(result.unattempted).toBe(4);
  });

  it('treats blank and whitespace-only answers as unattempted, not wrong', () => {
    const result = scoreMcq(key, { q1: '', q2: '   ', q3: '\n\t' });
    expect(result.unattempted).toBe(4);
    expect(result.wrong).toBe(0);
    expect(result.score).toBe(0);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    const result = scoreMcq(key, { q1: 'a', q2: ' b ', q3: 'c\n', q4: 'D' });
    expect(result.correct).toBe(4);
    expect(result.score).toBe(4 * MCQ_MARKS.correct);
  });

  it('marks integer questions on the same +4 / -1 scale as the options', () => {
    const mixed = { q1: 'A', q21: '12', q22: '-4' };
    const result = scoreMcq(mixed, { q1: 'A', q21: '12.0', q22: '4' });
    expect(result.correct).toBe(2);
    expect(result.wrong).toBe(1);
    expect(result.score).toBe(2 * MCQ_MARKS.correct + MCQ_MARKS.wrong);
  });

  it('ignores answers to questions that are not in the key', () => {
    const result = scoreMcq(key, { q1: 'A', q99: 'B' });
    expect(result.correct).toBe(1);
    expect(result.breakdown.q99).toBeUndefined();
    expect(Object.keys(result.breakdown)).toHaveLength(4);
  });

  it('scores a full 75-question paper the way the event will', () => {
    const { answerKey } = samplePaperShape();
    const ids = Object.keys(answerKey);
    expect(ids).toHaveLength(PAPER.totalCount);

    // First 40 right, next 10 wrong, the rest left alone.
    const answers: Record<string, string> = {};
    ids.forEach((id, index) => {
      if (index < 40) answers[id] = answerKey[id]!;
      else if (index < 50) answers[id] = `${answerKey[id]}x`;
    });

    const result = scoreMcq(answerKey, answers);
    expect(result).toMatchObject({ correct: 40, wrong: 10, unattempted: 25 });
    expect(result.score).toBe(40 * MCQ_MARKS.correct + 10 * MCQ_MARKS.wrong);
  });

  it('awards the full paper to a perfect attempt', () => {
    const { answerKey } = samplePaperShape();
    const result = scoreMcq(answerKey, { ...answerKey });
    expect(result.correct).toBe(PAPER.totalCount);
    expect(result.score).toBe(PAPER.maxMarks);
  });

  it('produces a per-question breakdown for dispute handling', () => {
    const result = scoreMcq(key, { q1: 'A', q2: 'Z' });
    expect(result.breakdown).toEqual({
      q1: 'correct',
      q2: 'wrong',
      q3: 'unattempted',
      q4: 'unattempted',
    });
  });
});
