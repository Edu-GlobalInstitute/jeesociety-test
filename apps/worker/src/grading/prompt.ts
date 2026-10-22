import { RubricObservationSchema, type Rubric, type RubricObservation } from '@jee/shared';

/**
 * Prompt construction.
 *
 * The one rule that governs this file: **never ask the model for a score.**
 * Models are poorly calibrated on absolute numbers and drift across 150,000
 * calls, so the prompt asks only for observations a reader could verify, and
 * the number is computed from them in scoreRubric(). The cap is likewise a code
 * constant, not an instruction — an instruction holds most of the time, which
 * over 150,000 answers is not good enough.
 *
 * The rubric sits in a cached prefix: it is identical for every one of the
 * 10,000 answers to a given question, so caching it is the difference between
 * paying for it once and paying for it 10,000 times.
 */

export const SYSTEM_PROMPT = `You are grading one answer from an Indian JEE-level examination.

You do not assign scores. You report observations about the answer, and a
separate program computes the mark from your observations. Report what you
actually see in the answer, not what you think it deserves.

Rules:
- Judge the physics/chemistry/mathematics, not the English. Most candidates are
  writing in their second or third language; awkward phrasing, Indian English
  conventions and terse notation are not errors.
- A correct method with an arithmetic slip is approach_correct: true and
  calculation_correct: false. These are different observations and both matter.
- Do not reward length. A short, correct answer is a correct answer.
- Do not speculate about whether the answer was written by a person or a
  machine. That is not your job and you have no reliable way to tell.
- Set off_topic_or_blank only when the answer is empty, or is about something
  else entirely. A wrong attempt at the right question is not off-topic.
- Set confidence: "low" when the answer is illegible, ambiguous, uses an
  unfamiliar but possibly valid method, or you would want a human to look.

The response format is enforced by the API schema, so report observations and
nothing else.`;

export interface GradingPrompt {
  /** Identical across the whole run. */
  systemPrompt: string;
  /** Identical across every answer to this question — cache this prefix. */
  cachedPrefix: string;
  /** The only part that varies per call. */
  userContent: string;
}

export function buildPrompt(rubric: Rubric, answer: string): GradingPrompt {
  const examples = rubric.examples
    .map(
      (example, index) =>
        [
          `### Worked example ${index + 1}`,
          `Answer:`,
          example.answer,
          ``,
          `Observations:`,
          JSON.stringify(example.observation, null, 2),
          ``,
          `Why: ${example.note}`,
        ].join('\n'),
    )
    .join('\n\n');

  const cachedPrefix = [
    `## Question ${rubric.questionId}`,
    ``,
    `## What a full-credit answer contains`,
    rubric.statement,
    ``,
    `## What each observation means for this question`,
    `- approach_correct: ${rubric.marks.approach}`,
    `- setup_correct: ${rubric.marks.setup}`,
    `- calculation_correct: ${rubric.marks.calculation}`,
    `- final_answer_correct: ${rubric.marks.final_answer}`,
    ``,
    `## Worked examples`,
    examples,
    ``,
    `## Required JSON shape`,
    JSON.stringify(
      {
        approach_correct: 'boolean',
        approach_reason: 'string, one sentence',
        setup_correct: 'boolean',
        calculation_correct: 'boolean',
        calculation_error: 'string or null',
        final_answer_correct: 'boolean',
        units_present: 'boolean',
        confidence: '"high" | "medium" | "low"',
        off_topic_or_blank: 'boolean',
      },
      null,
      2,
    ),
  ].join('\n');

  const userContent = [`## Candidate answer`, answer.trim() || '(blank)'].join('\n');

  return { systemPrompt: SYSTEM_PROMPT, cachedPrefix, userContent };
}

/**
 * Parses and validates the model's reply.
 *
 * The API already enforces the schema, so this is the second line of defence
 * rather than the first — but it is the line the scorer's types rest on, and a
 * malformed reply must be an error that sends the job back to the queue, never
 * a silent zero for the student.
 */
export function parseObservation(raw: string): RubricObservation {
  const text = raw.trim();
  // Tolerate a fenced block, which some replies still carry.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1]!.trim() : text;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('model reply was not JSON');
    parsed = JSON.parse(candidate.slice(start, end + 1));
  }

  return RubricObservationSchema.parse(parsed);
}

/** Short, factual feedback for the student, assembled from the observations. */
export function feedbackFrom(observation: RubricObservation): string {
  if (observation.off_topic_or_blank) {
    return 'No answer was recorded for this question, or it addressed a different question.';
  }
  const parts: string[] = [];
  parts.push(
    observation.approach_correct
      ? `Method: correct. ${observation.approach_reason}`.trim()
      : `Method: not correct. ${observation.approach_reason}`.trim(),
  );
  if (!observation.setup_correct) parts.push('The setup was incomplete or not shown.');
  if (!observation.calculation_correct) {
    parts.push(
      observation.calculation_error
        ? `Calculation: ${observation.calculation_error}`
        : 'Calculation: an error was found in the working.',
    );
  }
  if (observation.final_answer_correct && !observation.units_present) {
    parts.push('The final answer is right but the units are missing.');
  }
  return parts.join(' ');
}
