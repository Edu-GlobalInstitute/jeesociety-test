import { PAPER } from '../config.js';
import type { AnswerKey } from '../types.js';

/**
 * A paper-shaped answer key, built from the same constants the real paper is
 * validated against. It mirrors packages/db samplePaper.ts deliberately rather
 * than importing it: @jee/shared must not depend on @jee/db.
 */
export function samplePaperShape(): { answerKey: AnswerKey } {
  const answerKey: AnswerKey = {};
  const options = ['A', 'B', 'C', 'D'];
  let number = 0;

  for (const [subjectIndex] of PAPER.subjects.entries()) {
    for (let i = 0; i < PAPER.scqPerSubject; i += 1) {
      answerKey[`q${(number += 1)}`] = options[(subjectIndex + i) % options.length]!;
    }
    for (let i = 0; i < PAPER.integerPerSubject; i += 1) {
      answerKey[`q${(number += 1)}`] = String(10 + subjectIndex * PAPER.integerPerSubject + i);
    }
  }
  return { answerKey };
}
