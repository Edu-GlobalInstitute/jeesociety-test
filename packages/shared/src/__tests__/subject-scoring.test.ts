import { describe, expect, it } from 'vitest';
import { MCQ_MARKS } from '../config.js';
import { scoreBySubject, scoreMcq } from '../scoring.js';

/**
 * Rolling a score up by subject.
 *
 * The number that must always hold: the subject marks add up to the total. A
 * scorecard whose rows do not sum to the figure printed beneath them gives a
 * student no way to know which to believe, and that is the kind of thing
 * disputes are made of.
 */

const subjects = {
  q1: 'physics',
  q2: 'physics',
  q3: 'chemistry',
  q4: 'chemistry',
  q5: 'maths',
  q6: 'maths',
};

describe('scoreBySubject', () => {
  it('splits correct, wrong and unattempted by subject', () => {
    const key = { q1: 'A', q2: 'B', q3: 'C', q4: 'D', q5: '12', q6: '7' };
    const answers = { q1: 'A', q2: 'C', q3: 'C', q5: '12' };

    const result = scoreMcq(key, answers);
    const bySubject = scoreBySubject(result.breakdown, subjects);

    expect(bySubject.physics).toEqual({
      correct: 1,
      wrong: 1,
      unattempted: 0,
      marks: MCQ_MARKS.correct + MCQ_MARKS.wrong,
    });
    expect(bySubject.chemistry).toEqual({
      correct: 1,
      wrong: 0,
      unattempted: 1,
      marks: MCQ_MARKS.correct,
    });
    expect(bySubject.maths).toEqual({
      correct: 1,
      wrong: 0,
      unattempted: 1,
      marks: MCQ_MARKS.correct,
    });
  });

  /** The invariant the whole scorecard rests on. */
  it('always sums to the total score', () => {
    const key = { q1: 'A', q2: 'B', q3: 'C', q4: 'D', q5: '12', q6: '7' };
    const answers = { q1: 'A', q2: 'X', q3: 'C', q4: 'A', q5: '99' };

    const result = scoreMcq(key, answers);
    const bySubject = scoreBySubject(result.breakdown, subjects);
    const summed = Object.values(bySubject).reduce((total, row) => total + row.marks, 0);

    expect(summed).toBe(result.score);
  });

  /**
   * A question with no subject is filed under 'unknown' rather than dropped.
   * Dropping it would silently break the sum above, which is worse than an odd
   * row on the card — and this happens for real, on a paper built by the older
   * CLI that wrote no `questions` rows.
   */
  it('files an unmapped question under unknown rather than losing it', () => {
    const key = { q1: 'A', q99: 'B' };
    const answers = { q1: 'A', q99: 'B' };

    const result = scoreMcq(key, answers);
    const bySubject = scoreBySubject(result.breakdown, { q1: 'physics' });

    expect(bySubject.unknown).toEqual({
      correct: 1,
      wrong: 0,
      unattempted: 0,
      marks: MCQ_MARKS.correct,
    });

    const summed = Object.values(bySubject).reduce((total, row) => total + row.marks, 0);
    expect(summed).toBe(result.score);
  });

  it('is empty for an empty breakdown rather than throwing', () => {
    expect(scoreBySubject({}, subjects)).toEqual({});
  });

  /**
   * An entirely unattempted paper must still produce a row per subject: a
   * scorecard that omits chemistry reads as though chemistry was not on the
   * paper.
   */
  it('reports subjects a student attempted nothing in', () => {
    const key = { q1: 'A', q3: 'C', q5: '12' };
    const result = scoreMcq(key, {});
    const bySubject = scoreBySubject(result.breakdown, subjects);

    expect(Object.keys(bySubject).sort()).toEqual(['chemistry', 'maths', 'physics']);
    for (const row of Object.values(bySubject)) {
      expect(row).toMatchObject({ correct: 0, wrong: 0, marks: 0 });
    }
  });
});
