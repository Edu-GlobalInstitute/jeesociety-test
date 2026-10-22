import { describe, expect, it } from 'vitest';
import { AWARD_CAP, MCQ_MARKS } from '../config.js';
import { scoreMcq, scoreRubric, totalScore } from '../scoring.js';
import type { RubricObservation } from '../types.js';

const observation = (over: Partial<RubricObservation> = {}): RubricObservation => ({
  approach_correct: false,
  approach_reason: '',
  setup_correct: false,
  calculation_correct: false,
  calculation_error: null,
  final_answer_correct: false,
  units_present: false,
  confidence: 'high',
  off_topic_or_blank: false,
  ...over,
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

  it('ignores answers to questions that are not in the key', () => {
    // Subjective answers ride in the same map; they must not affect mcq_score.
    const result = scoreMcq(key, { q1: 'A', q61: 'a long subjective answer' });
    expect(result.correct).toBe(1);
    expect(result.breakdown.q61).toBeUndefined();
    expect(Object.keys(result.breakdown)).toHaveLength(4);
  });

  it('scores a full 60-question paper the way the event will', () => {
    const fullKey = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`q${i + 1}`, 'ABCD'[i % 4]!]),
    );
    const answers = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [
        `q${i + 1}`,
        i < 40 ? 'ABCD'[i % 4]! : i < 50 ? 'ABCD'[(i + 1) % 4]! : '',
      ]),
    );
    const result = scoreMcq(fullKey, answers);
    expect(result).toMatchObject({ correct: 40, wrong: 10, unattempted: 10 });
    expect(result.score).toBe(40 * 4 + 10 * -1);
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

describe('scoreRubric', () => {
  it('awards one mark per satisfied rubric line', () => {
    expect(scoreRubric(observation({ approach_correct: true })).raw).toBe(1);
    expect(
      scoreRubric(observation({ approach_correct: true, setup_correct: true })).raw,
    ).toBe(2);
  });

  it('requires units for the final-answer mark', () => {
    expect(scoreRubric(observation({ final_answer_correct: true })).raw).toBe(0);
    expect(
      scoreRubric(observation({ final_answer_correct: true, units_present: true })).raw,
    ).toBe(1);
  });

  it('caps the awarded score at AWARD_CAP while preserving raw', () => {
    const perfect = scoreRubric(
      observation({
        approach_correct: true,
        setup_correct: true,
        calculation_correct: true,
        final_answer_correct: true,
        units_present: true,
      }),
    );
    expect(perfect.raw).toBe(4);
    expect(perfect.score).toBe(AWARD_CAP);
    expect(perfect.score).toBeLessThan(perfect.raw);
  });

  it('never returns a score above the cap for any combination of observations', () => {
    const booleans = [false, true];
    for (const approach_correct of booleans)
      for (const setup_correct of booleans)
        for (const calculation_correct of booleans)
          for (const final_answer_correct of booleans)
            for (const units_present of booleans)
              for (const off_topic_or_blank of booleans) {
                const result = scoreRubric(
                  observation({
                    approach_correct,
                    setup_correct,
                    calculation_correct,
                    final_answer_correct,
                    units_present,
                    off_topic_or_blank,
                  }),
                );
                expect(result.score).toBeLessThanOrEqual(AWARD_CAP);
                expect(result.score).toBeGreaterThanOrEqual(0);
                expect(result.raw).toBeGreaterThanOrEqual(result.score);
              }
  });

  it('routes low confidence to review without changing the score', () => {
    const result = scoreRubric(
      observation({ approach_correct: true, setup_correct: true, confidence: 'low' }),
    );
    expect(result.score).toBe(2);
    expect(result.needsReview).toBe(true);
    expect(result.reviewReasons).toContain('grader_low_confidence');
  });

  it('routes off-topic/blank to review rather than trusting the zero', () => {
    const result = scoreRubric(
      observation({ off_topic_or_blank: true, approach_correct: true }),
    );
    expect(result.score).toBe(0);
    expect(result.needsReview).toBe(true);
    expect(result.reviewReasons).toContain('off_topic_or_blank');
  });

  it('does not flag a confident ordinary zero for review', () => {
    const result = scoreRubric(observation({ confidence: 'high' }));
    expect(result.score).toBe(0);
    expect(result.needsReview).toBe(false);
  });
});

describe('totalScore', () => {
  it('sums mcq and subjective', () => {
    expect(totalScore(120, [3, 2, 0, 3])).toEqual({ subjective: 8, total: 128 });
  });

  it('tolerates a partially graded attempt', () => {
    // Subjective grading runs over days; the total is recomputed as it advances.
    expect(totalScore(120, [])).toEqual({ subjective: 0, total: 120 });
  });

  it('keeps a negative mcq score negative rather than clamping it', () => {
    expect(totalScore(-5, [1]).total).toBe(-4);
  });
});
