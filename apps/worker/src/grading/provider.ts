import Anthropic from '@anthropic-ai/sdk';
import { RUBRIC_OBSERVATION_JSON_SCHEMA, type RubricObservation } from '@jee/shared';
import type { Env } from '../env.js';
import { parseObservation, type GradingPrompt } from './prompt.js';

/**
 * The model call. One per subjective answer, ~150,000 times.
 *
 * Three things here are deliberate:
 *
 *  - **Structured output, not prompt-coaxed JSON.** The observation schema is
 *    handed to the API, so the reply is schema-valid by construction. This
 *    replaces `temperature: 0` as the determinism mechanism — the Messages API
 *    now rejects `temperature` outright (see SYSTEM_DESIGN.md D-024).
 *
 *  - **The rubric is a cached system prefix.** It is byte-identical across all
 *    10,000 answers to a given question, so caching it is the difference
 *    between paying for it once and paying for it 10,000 times. A 1-hour TTL
 *    comfortably outlasts the gap between two jobs for the same question, given
 *    that enqueue orders jobs by question (see queries/grading.ts).
 *
 *  - **Low effort.** Reading one short answer against an explicit rubric with
 *    worked examples is not a reasoning-heavy task, and 150,000 calls make the
 *    difference material.
 */

export interface GradingResult {
  observation: RubricObservation;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

export interface GradingProvider {
  readonly name: string;
  grade(prompt: GradingPrompt): Promise<GradingResult>;
}

/** Signals the lane to back off and retry rather than fail the job. */
export class RetryableGradingError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryableGradingError';
  }
}

export function createGradingProvider(env: Env): GradingProvider {
  switch (env.GRADING_PROVIDER) {
    case 'anthropic':
      return new AnthropicGradingProvider(env);
    case 'stub':
      return new StubGradingProvider();
    default:
      throw new Error(`unsupported grading provider: ${env.GRADING_PROVIDER}`);
  }
}

class AnthropicGradingProvider implements GradingProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(env: Env) {
    this.client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY || undefined,
      // The lane already retries with backoff and records attempts_made on the
      // job row, so the SDK's own retries would hide failures from the admin
      // view and multiply the real attempt count.
      maxRetries: 0,
      timeout: 60_000,
    });
    this.model = env.GRADING_MODEL;
  }

  async grade(prompt: GradingPrompt): Promise<GradingResult> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: [
          // Stable across every call of the entire run.
          { type: 'text', text: prompt.systemPrompt },
          // Stable across every answer to this one question — the cached part.
          {
            type: 'text',
            text: prompt.cachedPrefix,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: prompt.userContent }],
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: RUBRIC_OBSERVATION_JSON_SCHEMA },
        },
      });

      if (response.stop_reason === 'refusal') {
        // The grader declined to read this answer. That is a human's problem,
        // not a zero: fail the job so it surfaces in the admin view.
        throw new Error(
          `grader refused: ${response.stop_details?.category ?? 'unknown'}`,
        );
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (!text.trim()) {
        throw new RetryableGradingError('model returned an empty reply');
      }

      // Validated again on our side: the API guarantees the schema, and this
      // guarantees the types the scorer is about to rely on.
      const observation = parseObservation(text);

      return {
        observation,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (error) {
      throw translateError(error);
    }
  }
}

/**
 * Distinguishes "try again in a moment" from "this will never work". Getting
 * this wrong in either direction is costly: treating a 429 as fatal fails
 * thousands of jobs during a rate-limit blip, and treating a 400 as retryable
 * burns three attempts on a request that cannot succeed.
 */
function translateError(error: unknown): Error {
  if (error instanceof RetryableGradingError) return error;

  if (error instanceof Anthropic.RateLimitError) {
    const header = error.headers?.get?.('retry-after');
    const retryAfterMs = header ? Number(header) * 1000 : undefined;
    return new RetryableGradingError('rate limited', retryAfterMs);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new RetryableGradingError('connection error');
  }
  if (error instanceof Anthropic.APIError && error.status && error.status >= 500) {
    return new RetryableGradingError(`provider ${error.status}`);
  }
  if (error instanceof Anthropic.APIError) {
    // 400/401/404: the request itself is wrong. Retrying cannot help.
    return new Error(`provider rejected request (${error.status}): ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Used by the tests and by a dry run against the real database. It exercises
 * every path through the lane without spending money or needing a key.
 */
export class StubGradingProvider implements GradingProvider {
  readonly name = 'stub';

  async grade(prompt: GradingPrompt): Promise<GradingResult> {
    const answer = prompt.userContent;
    const blank = answer.includes('(blank)');
    return {
      observation: {
        approach_correct: !blank && answer.length > 100,
        approach_reason: 'stub provider',
        setup_correct: !blank && answer.length > 200,
        calculation_correct: !blank && answer.length > 300,
        calculation_error: null,
        final_answer_correct: !blank && answer.length > 400,
        units_present: answer.includes('m/s'),
        confidence: blank ? 'low' : 'high',
        off_topic_or_blank: blank,
      },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}
