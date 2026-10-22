import { PAPER, type AnswerKey, type Paper, type Rubric, type RubricMap } from '@jee/shared';

/**
 * A deterministic 75-question paper for local development, tests and the load
 * test. Deterministic so that a failing load test can be reproduced exactly, and
 * so that seeding twice produces the same answer key.
 *
 * This is not the real paper. The real one is authored elsewhere and passed to
 * tools/build-paper as JSON.
 */

const SUBJECTS = ['physics', 'chemistry', 'maths'] as const;
const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

export function samplePaper(testId: number): { paper: Paper; answerKey: AnswerKey; rubrics: RubricMap } {
  const questions: Paper['questions'] = [];
  const answerKey: AnswerKey = {};
  const rubrics: RubricMap = {};

  for (let i = 0; i < PAPER.mcqCount; i += 1) {
    const id = `q${i + 1}`;
    const subject = SUBJECTS[i % SUBJECTS.length]!;
    questions.push({
      id,
      kind: 'mcq',
      subject,
      body: `[${subject}] Sample objective question ${i + 1}. Which of the following is correct?`,
      options: OPTION_KEYS.map((key, index) => ({
        key,
        body: `Option ${key} for question ${i + 1} (${index})`,
      })),
    });
    answerKey[id] = OPTION_KEYS[i % OPTION_KEYS.length]!;
  }

  for (let i = 0; i < PAPER.subjectiveCount; i += 1) {
    const number = PAPER.mcqCount + i + 1;
    const id = `q${number}`;
    const subject = SUBJECTS[i % SUBJECTS.length]!;
    questions.push({
      id,
      kind: 'subjective',
      subject,
      body:
        `[${subject}] Sample subjective question ${number}. A block of mass m slides down a ` +
        `frictionless incline of angle θ. Derive its acceleration and state the units.`,
      });
    rubrics[id] = sampleRubric(id);
  }

  return {
    paper: { testId, name: `Sample Paper ${testId}`, durationMinutes: 180, questions },
    answerKey,
    rubrics,
  };
}

/**
 * The shape a real rubric must take. Note the worked examples: few-shot anchors
 * do more for consistency across 150,000 calls than any instruction about
 * strictness, and each one shows what earns a particular mark.
 */
function sampleRubric(questionId: string): Rubric {
  return {
    questionId,
    statement:
      'A full-credit answer resolves the weight into components along and normal to ' +
      'the incline, applies Newton\'s second law along the incline, and reports ' +
      'a = g·sin(θ) with units of m/s².',
    marks: {
      approach: 'Recognises that the net force along a frictionless incline is mg·sin(θ).',
      setup: 'Resolves weight into components correctly and writes ΣF = ma along the incline.',
      calculation: 'Cancels m correctly and simplifies without algebraic error.',
      final_answer: 'States a = g·sin(θ) with units (m/s²).',
    },
    examples: [
      {
        answer:
          'Along the incline the only force is the component of gravity, mg sin θ. ' +
          'So ma = mg sin θ, giving a = g sin θ = 9.8 sin θ m/s².',
        observation: {
          approach_correct: true,
          approach_reason: 'Identifies mg·sin(θ) as the net force along the incline.',
          setup_correct: true,
          calculation_correct: true,
          calculation_error: null,
          final_answer_correct: true,
          units_present: true,
          confidence: 'high',
          off_topic_or_blank: false,
        },
        note: 'Earns all four marks; capped to 3.',
      },
      {
        answer:
          'The force on the block is mg sin θ so the acceleration is g sin θ.',
        observation: {
          approach_correct: true,
          approach_reason: 'Correct net force, but no explicit resolution of components.',
          setup_correct: false,
          calculation_correct: true,
          calculation_error: null,
          final_answer_correct: true,
          units_present: false,
          confidence: 'high',
          off_topic_or_blank: false,
        },
        note: 'No setup shown and no units: approach and calculation only.',
      },
      {
        answer: 'a = g because gravity pulls it down.',
        observation: {
          approach_correct: false,
          approach_reason: 'Ignores the incline; uses free-fall acceleration.',
          setup_correct: false,
          calculation_correct: false,
          calculation_error: 'No resolution of the weight along the incline.',
          final_answer_correct: false,
          units_present: false,
          confidence: 'high',
          off_topic_or_blank: false,
        },
        note: 'Zero. The physics is wrong, not merely incomplete.',
      },
    ],
  };
}

export function subjectiveQuestionIds(paper: Paper): string[] {
  return paper.questions.filter((q) => q.kind === 'subjective').map((q) => q.id);
}
