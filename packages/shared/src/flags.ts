import { FLAG_SEVERITY, type FlagCode } from './config.js';
import type { AttemptFlag, LengthMap, QuestionId } from './types.js';

/**
 * Review signal computation. Every function here returns evidence. None of them
 * returns a score, a penalty or a verdict — the system gathers evidence and a
 * human decides.
 *
 * On an all-objective paper there is one signal worth computing. The two
 * behavioural ones this module used to hold — keystroke-to-character ratio and
 * burst appearance — read the growth curve of typed prose, and a one-character
 * answer has no growth curve. They were removed rather than left dormant: a
 * check that can never fire is worse than no check, because the dashboard still
 * reports zero and everyone reads that as "nothing found".
 */

function flag(
  code: FlagCode,
  questionId: QuestionId | null,
  evidence: Record<string, unknown>,
  at: Date,
): AttemptFlag {
  return { code, questionId, evidence, at: at.toISOString() };
}

/**
 * IP change mid-attempt. Weak on its own — mobile networks rotate addresses
 * constantly, and a student who tethers after a power cut will trip it — so it
 * is evidence to read beside a receipt and a submission time, never a finding.
 */
export function ipChangeFlags(
  observedIps: { ip: string; at: Date | string }[],
  at: Date = new Date(),
): AttemptFlag[] {
  const distinct = [...new Set(observedIps.map((o) => o.ip))];
  if (distinct.length <= 1) return [];
  return [
    flag(
      'ip_change',
      null,
      { distinctIps: distinct.length, ips: distinct, first: observedIps[0]?.at },
      at,
    ),
  ];
}

/** Dedupes by (code, questionId) so a re-run of the flag job is idempotent. */
export function mergeFlags(existing: AttemptFlag[], incoming: AttemptFlag[]): AttemptFlag[] {
  const seen = new Map<string, AttemptFlag>();
  for (const f of [...existing, ...incoming]) {
    seen.set(`${f.code}:${f.questionId ?? ''}`, f);
  }
  return [...seen.values()];
}

/** Review-queue ordering. Strongest evidence first; never a measure of guilt. */
export function flagSeverity(flags: AttemptFlag[]): number {
  return flags.reduce((sum, f) => sum + (FLAG_SEVERITY[f.code] ?? 0), 0);
}

/**
 * Character lengths of each answer. This — not the text — is what we persist on
 * every sync. With one-character answers it is no longer a growth curve but it
 * is still the audit trail that answers "how much of the paper did this student
 * have filled in at 11:42, and from which address".
 */
export function answerLengths(answers: Record<string, string>): LengthMap {
  const out: LengthMap = {};
  for (const [questionId, text] of Object.entries(answers)) {
    out[questionId] = typeof text === 'string' ? text.length : 0;
  }
  return out;
}
