import { z } from 'zod';
import { LIMITS } from './config.js';

/**
 * The wire contract. The exam client and the API both import these schemas, so a
 * mismatch between them fails at compile time rather than at minute 40 of the
 * event. Changing anything here changes both sides at once — that is the point.
 */

const questionId = z.string().min(1).max(16);

export const SyncSchema = z.object({
  attemptId: z.string().uuid(),
  /** Monotonic per attempt. The server's concurrency guard: WHERE revision < $n. */
  revision: z.number().int().positive(),
  /** Full state, every time. Never a diff — see SYSTEM_DESIGN.md D-007. */
  answers: z.record(questionId, z.string().max(LIMITS.maxAnswerChars)),
  telemetry: z
    .record(
      questionId,
      z.object({
        keystrokes: z.number().int().nonnegative(),
        pastes: z.number().int().nonnegative(),
        pastedChars: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export type SyncRequest = z.infer<typeof SyncSchema>;

export const SyncResponseSchema = z.object({
  ok: z.literal(true),
  /** The revision the server now holds. May be ahead of the one just sent. */
  revision: z.number().int().nonnegative(),
  /** True when this request did not advance server state (stale, still a 200). */
  stale: z.boolean(),
  serverTime: z.number().int(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

export const SubmitSchema = z.object({
  attemptId: z.string().uuid(),
  revision: z.number().int().positive(),
  answers: z.record(questionId, z.string().max(LIMITS.maxAnswerChars)),
  telemetry: SyncSchema.shape.telemetry,
});
export type SubmitRequest = z.infer<typeof SubmitSchema>;

export const SubmitResponseSchema = z.object({
  ok: z.literal(true),
  receipt: z.string(),
  submittedAt: z.string(),
  /** True when the attempt was already submitted and this call changed nothing. */
  alreadySubmitted: z.boolean(),
});
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;

export const TestStatusResponseSchema = z.object({
  testId: z.number().int(),
  name: z.string(),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  lobbyOpensAt: z.number().int(),
  serverTime: z.number().int(),
  paperUrl: z.string().nullable(),
  /** Whether this user has paid and may enter the lobby. */
  paid: z.boolean(),
  attempt: z
    .object({
      id: z.string().uuid(),
      status: z.string(),
      revision: z.number().int().nonnegative(),
      submittedAt: z.string().nullable(),
      receipt: z.string().nullable(),
    })
    .nullable(),
});
export type TestStatusResponse = z.infer<typeof TestStatusResponseSchema>;

export const RegisterResponseSchema = z.object({
  attemptId: z.string().uuid(),
  status: z.string(),
  revision: z.number().int().nonnegative(),
  registeredAt: z.string(),
});
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const KeyResponseSchema = z.object({
  /** base64url AES-GCM key. Released at starts_at and not one millisecond before. */
  key: z.string(),
  attemptId: z.string().uuid(),
  endsAt: z.number().int(),
  serverTime: z.number().int(),
});
export type KeyResponse = z.infer<typeof KeyResponseSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
