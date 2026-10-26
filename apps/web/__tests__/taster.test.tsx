import { describe, expect, it } from 'vitest';
import { MCQ_MARKS } from '@jee/shared/config';
import { TASTER_QUESTIONS } from '../lib/tasterQuestions';
import { tally, verdictFor } from '../components/TryQuestions';

/**
 * The taster is a sales argument, so the thing that has to hold is that it is
 * honest: it must mark the way the server marks, and its answer keys must be
 * the answers to the questions it prints.
 */

describe('taster questions', () => {
  it('gives every question four options and a key that points at one of them', () => {
    for (const question of TASTER_QUESTIONS) {
      expect(question.options).toHaveLength(4);
      expect(question.answer).toBeGreaterThanOrEqual(0);
      expect(question.answer).toBeLessThan(question.options.length);
      expect(question.why.length).toBeGreaterThan(20);
    }
  });

  it('keeps the ids unique, since they key the React list and the progress rail', () => {
    const ids = TASTER_QUESTIONS.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * Physics cannot be asserted, but the keys can be pinned: these are the
   * published answers to JEE Main 2024, 27 Jan Shift 1, and a reordering of
   * the options must not silently move the key off them.
   */
  it('still keys to the published answers', () => {
    const keyed = Object.fromEntries(
      TASTER_QUESTIONS.map((question) => [question.id, question.options[question.answer]]),
    );
    expect(keyed).toEqual({
      rod: 'R/25',
      gravity: '4g₀',
      momentum: '2 : 5',
      bohr: '16R / 9',
      shm: '2√3 cm',
    });
  });
});

describe('tally', () => {
  const allRight = TASTER_QUESTIONS.map((question) => question.answer);
  const allWrong = TASTER_QUESTIONS.map((question) => (question.answer + 1) % 4);

  it('marks the taster the way the server marks the paper', () => {
    expect(tally(allRight)).toBe(TASTER_QUESTIONS.length * MCQ_MARKS.correct);
    expect(tally(allWrong)).toBe(TASTER_QUESTIONS.length * MCQ_MARKS.wrong);
  });

  it('scores a skipped question as nothing, not as wrong', () => {
    expect(tally(TASTER_QUESTIONS.map(() => null))).toBe(0);
  });

  it('subtracts a mark for a wrong answer, as the real paper does', () => {
    const oneWrong = [...allRight];
    oneWrong[0] = (TASTER_QUESTIONS[0]!.answer + 2) % 4;
    expect(tally(oneWrong)).toBe(tally(allRight) - MCQ_MARKS.correct + MCQ_MARKS.wrong);
  });
});

describe('verdictFor', () => {
  it('has something to say at every score the taster can produce', () => {
    const lowest = TASTER_QUESTIONS.length * MCQ_MARKS.wrong;
    const highest = TASTER_QUESTIONS.length * MCQ_MARKS.correct;
    for (let marks = lowest; marks <= highest; marks += 1) {
      const verdict = verdictFor(marks);
      expect(verdict.title.length).toBeGreaterThan(0);
      expect(verdict.note.length).toBeGreaterThan(40);
    }
  });

  it('never tells a student off for a bad score', () => {
    const note = `${verdictFor(-5).title} ${verdictFor(-5).note}`.toLowerCase();
    for (const word of ['stupid', 'bad', 'fail', 'hopeless', 'weak']) {
      expect(note).not.toContain(word);
    }
  });
});
