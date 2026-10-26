import { PAPER, type AnswerKey, type Paper, type Question } from '@jee/shared';

/**
 * A deterministic 75-question paper for local development, tests and the load
 * test. Deterministic so that a failing load test can be reproduced exactly, and
 * so that seeding twice produces the same answer key.
 *
 * It is laid out the way the real paper is: each subject contributes 20
 * single-correct questions and then 5 integer-answer ones, in that order, so
 * that the navigator's three sections look on a dev machine exactly as they
 * will on the day.
 *
 * This is not the real paper. The real one is authored elsewhere and passed to
 * tools/build-paper as JSON.
 */

const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

export function samplePaper(testId: number): { paper: Paper; answerKey: AnswerKey } {
  const questions: Question[] = [];
  const answerKey: AnswerKey = {};

  // Question numbers run 1..75 across the whole paper, subject by subject, so
  // "question 47" means the same thing to a student and in a support email.
  let number = 0;
  const nextId = () => `q${(number += 1)}`;

  for (const [subjectIndex, subject] of PAPER.subjects.entries()) {
    for (let i = 0; i < PAPER.scqPerSubject; i += 1) {
      const id = nextId();
      questions.push({
        id,
        kind: 'scq',
        subject,
        body: `[${subject}] Sample single-correct question ${number}. Which of the following is correct?`,
        options: OPTION_KEYS.map((key, index) => ({
          key,
          body: `Option ${key} for question ${number} (${index})`,
        })),
      });
      answerKey[id] = OPTION_KEYS[(subjectIndex + i) % OPTION_KEYS.length]!;
    }

    for (let i = 0; i < PAPER.integerPerSubject; i += 1) {
      const id = nextId();
      questions.push({
        id,
        kind: 'integer',
        subject,
        body:
          `[${subject}] Sample integer-answer question ${number}. A block of mass ${i + 2} kg ` +
          'slides down a frictionless incline. Give the magnitude of its acceleration, ' +
          'rounded to the nearest integer.',
        unit: 'm/s²',
      });
      // Spread across two digits so a numeric comparison is actually exercised
      // rather than every answer being a single character.
      answerKey[id] = String(10 + subjectIndex * PAPER.integerPerSubject + i);
    }
  }

  return {
    paper: { testId, name: `Sample Paper ${testId}`, durationMinutes: 180, questions },
    answerKey,
  };
}
