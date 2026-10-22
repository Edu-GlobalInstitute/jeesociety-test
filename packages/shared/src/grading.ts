import { z } from 'zod';

/**
 * The shape we ask the grading model for — and the one place it is defined.
 *
 * It is a zod schema rather than a bare interface because the same object is
 * handed to the model as a JSON schema (so the reply is schema-valid by
 * construction) and used to type scoreRubric()'s input. One definition means
 * the prompt and the scorer cannot drift apart.
 *
 * Note what is absent: any field resembling a score, a mark or a grade. The
 * model reports observations; scoreRubric() computes the number.
 */
export const RubricObservationSchema = z.object({
  approach_correct: z.boolean(),
  approach_reason: z.string(),
  setup_correct: z.boolean(),
  calculation_correct: z.boolean(),
  calculation_error: z.string().nullable(),
  final_answer_correct: z.boolean(),
  units_present: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  off_topic_or_blank: z.boolean(),
});

export type RubricObservation = z.infer<typeof RubricObservationSchema>;

/**
 * The same shape as a JSON Schema, for the API's structured-output format.
 *
 * It is hand-written next to the zod schema rather than generated, so both are
 * visible in one diff; a test asserts that they accept and reject the same
 * objects, which is what actually keeps them in step.
 *
 * `additionalProperties: false` plus a complete `required` list is what makes
 * the reply schema-valid by construction — this, rather than a sampling
 * parameter, is how determinism is obtained now that the Messages API rejects
 * `temperature` (SYSTEM_DESIGN.md D-024).
 */
export const RUBRIC_OBSERVATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'approach_correct',
    'approach_reason',
    'setup_correct',
    'calculation_correct',
    'calculation_error',
    'final_answer_correct',
    'units_present',
    'confidence',
    'off_topic_or_blank',
  ],
  properties: {
    approach_correct: { type: 'boolean' },
    approach_reason: { type: 'string' },
    setup_correct: { type: 'boolean' },
    calculation_correct: { type: 'boolean' },
    calculation_error: { type: ['string', 'null'] },
    final_answer_correct: { type: 'boolean' },
    units_present: { type: 'boolean' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    off_topic_or_blank: { type: 'boolean' },
  },
} as const satisfies Record<string, unknown>;
