import { describe, expect, it } from 'vitest';
import { PAPER, decryptPaper } from '@jee/shared';
import { compilePaper, validateQuestionSet } from '../queries/questions.js';
import type { QuestionRow } from '../queries/questions.js';

/**
 * Paper validation and compilation.
 *
 * These two functions decide what 25,000 students download and what their marks
 * are computed against, and both are pure — so unlike the rest of this suite
 * they need no database. That is worth keeping: it means the rules can be
 * tested exhaustively and cheaply, and a CI run with no Postgres still covers
 * the part of the system with no second chance.
 *
 * The cases are chosen for what they cost on the day. A key naming an option
 * the question does not have means every student who attempts it loses a mark
 * for trying; an answer leaking into the blob means the paper is open before it
 * opens. Both are tested directly.
 */

let nextId = 1;

function scq(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: nextId++,
    test_id: 1,
    question_ref: `q${nextId}`,
    subject: 'physics',
    kind: 'scq',
    sort_order: 1,
    body: 'A body starts from rest. How far in 5 s?',
    options: [
      { key: 'A', body: '10 m' },
      { key: 'B', body: '25 m' },
      { key: 'C', body: '50 m' },
      { key: 'D', body: '100 m' },
    ],
    correct_answer: 'B',
    image_url: null,
    solution_text: null,
    solution_image_url: null,
    unit: null,
    marks_correct: '4',
    marks_wrong: '-1',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function integer(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return scq({
    kind: 'integer',
    options: [],
    correct_answer: '12',
    ...overrides,
  });
}

/** A paper in exactly the advertised shape: 20 + 5 per subject. */
function fullPaper(): QuestionRow[] {
  const rows: QuestionRow[] = [];
  let counter = 0;
  for (const subject of PAPER.subjects) {
    for (let index = 0; index < PAPER.scqPerSubject; index += 1) {
      counter += 1;
      rows.push(scq({ subject, question_ref: `q${counter}`, sort_order: index + 1 }));
    }
    for (let index = 0; index < PAPER.integerPerSubject; index += 1) {
      counter += 1;
      rows.push(
        integer({ subject, question_ref: `q${counter}`, sort_order: PAPER.scqPerSubject + index + 1 }),
      );
    }
  }
  return rows;
}

describe('validateQuestionSet', () => {
  it('accepts a paper in the advertised shape', () => {
    expect(validateQuestionSet(fullPaper())).toEqual([]);
  });

  it('refuses an empty test', () => {
    expect(validateQuestionSet([])).toEqual(['This test has no questions yet.']);
  });

  /**
   * The expensive one. A key naming an option the question does not carry makes
   * the question unanswerable, and with negative marking every student who
   * attempts it scores −1 for trying.
   */
  it('catches an answer that is not one of the options', () => {
    const problems = validateQuestionSet([scq({ question_ref: 'q7', correct_answer: 'E' })], {
      strictShape: false,
    });
    expect(problems).toContain('q7: the correct answer "E" is not one of its options.');
  });

  it('catches a missing answer', () => {
    const problems = validateQuestionSet([scq({ question_ref: 'q3', correct_answer: null })], {
      strictShape: false,
    });
    expect(problems).toContain('q3: no correct answer set.');
  });

  /**
   * Scoring compares integer answers numerically, so a non-numeric key can
   * never match anything a student is able to type.
   */
  it('catches a non-numeric answer on an integer question', () => {
    const problems = validateQuestionSet(
      [integer({ question_ref: 'q61', correct_answer: 'twelve' })],
      { strictShape: false },
    );
    expect(problems).toContain('q61: the answer "twelve" is not a number.');
  });

  it('catches two questions sharing a number', () => {
    const problems = validateQuestionSet(
      [scq({ question_ref: 'q4' }), scq({ question_ref: 'q4' })],
      { strictShape: false },
    );
    expect(problems).toContain('q4: duplicate question number.');
  });

  it('catches an option that is blank with no figure either', () => {
    const problems = validateQuestionSet(
      [
        scq({
          question_ref: 'q9',
          options: [
            { key: 'A', body: '' },
            { key: 'B', body: '25 m' },
          ],
        }),
      ],
      { strictShape: false },
    );
    expect(problems).toContain('q9: option A is blank.');
  });

  /** A figure-only option is ordinary in physics and must not be refused. */
  it('accepts an option that has a figure but no text', () => {
    const problems = validateQuestionSet(
      [
        scq({
          question_ref: 'q9',
          options: [
            { key: 'A', body: '', imageUrl: '/papers/images/abc123' },
            { key: 'B', body: '25 m' },
          ],
          correct_answer: 'A',
        }),
      ],
      { strictShape: false },
    );
    expect(problems).toEqual([]);
  });

  it('catches an unknown subject', () => {
    const problems = validateQuestionSet(
      [scq({ question_ref: 'q2', subject: 'biology' })],
      { strictShape: false },
    );
    expect(problems).toContain('q2: "biology" is not a subject in this paper.');
  });

  /**
   * Per subject, not only in total: 75 physics questions would pass a
   * total-only check and be the wrong paper.
   */
  it('catches a paper of the right size with the wrong subject mix', () => {
    const rows = fullPaper().map((row) => ({ ...row, subject: 'physics' }));
    const problems = validateQuestionSet(rows);
    expect(problems.some((problem) => problem.includes('No chemistry questions at all.'))).toBe(true);
  });

  /**
   * Truncating the paper drops whole questions from the end. fullPaper() lays
   * each subject out as its 20 single-correct followed by its 5 integer, so
   * cutting the last five removes maths integer questions — and the shape
   * check has to notice both the total and the per-subject shortfall.
   */
  it('catches a short paper', () => {
    const problems = validateQuestionSet(fullPaper().slice(0, 70));
    expect(problems).toContain(
      `Expected ${PAPER.integerCount} integer questions, found 10.`,
    );
    expect(problems).toContain(
      `maths: expected ${PAPER.integerPerSubject} integer, found 0.`,
    );
    // The single-correct half is untouched, so it must not be complained about.
    expect(problems.some((problem) => problem.includes('single-correct'))).toBe(false);
  });

  /**
   * Mocks are exempt from the shape rule. A 20-question chemistry-only mock is
   * a legitimate thing to set, and refusing it would make the designer useless
   * for most of what mocks are for.
   */
  it('lets a mock be any size while still checking each question', () => {
    const short = [
      scq({ question_ref: 'm1', subject: 'chemistry' }),
      scq({ question_ref: 'm2', subject: 'chemistry', correct_answer: 'Z' }),
    ];
    const problems = validateQuestionSet(short, { strictShape: false });
    expect(problems).toEqual(['m2: the correct answer "Z" is not one of its options.']);
  });
});

describe('compilePaper', () => {
  const test = { id: 1, name: 'Mock 1', duration_minutes: 180 };

  it('puts every answer in the key and none in the paper', async () => {
    const rows = fullPaper();
    const compiled = await compilePaper(test, rows);

    // Every question has an entry: a question the key does not mention is one
    // the whole cohort scores zero on.
    expect(Object.keys(compiled.answerKey)).toHaveLength(rows.length);
    expect(compiled.answerKey.q1).toBe('B');

    // The serialised paper must not contain the answer key in any form. This is
    // the check that would catch a future refactor accidentally spreading a
    // row — including correct_answer — into a paper question.
    const serialised = JSON.stringify(compiled.paper);
    expect(serialised).not.toContain('correct_answer');
    expect(serialised).not.toContain('correctAnswer');
    for (const question of compiled.paper.questions) {
      expect(Object.keys(question)).not.toContain('correct_answer');
    }
  });

  it('produces a blob that decrypts back to the exact paper', async () => {
    const compiled = await compilePaper(test, fullPaper());
    const blob = JSON.parse(compiled.body.toString('utf8'));
    const reopened = await decryptPaper(blob, compiled.paperKey);
    expect(reopened).toEqual(compiled.paper);
  });

  it('cannot be opened with a different key', async () => {
    const first = await compilePaper(test, fullPaper());
    const second = await compilePaper(test, fullPaper());
    const blob = JSON.parse(first.body.toString('utf8'));
    // Each compile mints a fresh key, so a re-launch invalidates the old one.
    expect(second.paperKey).not.toBe(first.paperKey);
    await expect(decryptPaper(blob, second.paperKey)).rejects.toThrow();
  });

  /**
   * Figures travel inside the body as Markdown, because the exam client renders
   * bodies and has no separate image field. See `withImage`.
   */
  it('appends a figure to the body it belongs to', async () => {
    const compiled = await compilePaper(test, [
      scq({ question_ref: 'q1', image_url: '/papers/images/deadbeef' }),
    ]);
    expect(compiled.paper.questions[0]!.body).toContain('![figure](/papers/images/deadbeef)');
  });

  it('carries the unit of an integer question and omits it otherwise', async () => {
    const compiled = await compilePaper(test, [
      integer({ question_ref: 'q61', unit: 'm/s²' }),
      integer({ question_ref: 'q62', unit: null }),
    ]);
    const [first, second] = compiled.paper.questions;
    expect(first).toMatchObject({ kind: 'integer', unit: 'm/s²' });
    expect(second).not.toHaveProperty('unit');
  });

  it('keeps the paper in the order the questions were given', async () => {
    const compiled = await compilePaper(test, fullPaper());
    expect(compiled.paper.questions.map((question) => question.id).slice(0, 3)).toEqual([
      'q1',
      'q2',
      'q3',
    ]);
  });

  it('carries the test name and duration the client shows', async () => {
    const compiled = await compilePaper(
      { id: 9, name: 'Scholarship Test', duration_minutes: 120 },
      fullPaper(),
    );
    expect(compiled.paper).toMatchObject({
      testId: 9,
      name: 'Scholarship Test',
      durationMinutes: 120,
    });
  });
});
