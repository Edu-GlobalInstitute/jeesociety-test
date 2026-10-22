import { FLAGS, FLAG_SEVERITY, type FlagCode } from './config.js';
import type { AttemptFlag, LengthMap, QuestionId, TelemetryMap } from './types.js';

/**
 * Anti-cheat signal computation. Every function here returns evidence. None of
 * them returns a score, a penalty or a verdict — the system gathers evidence and
 * a human decides. There is deliberately no AI-text detection on answer content:
 * it is unreliable and biased against non-native English writers writing formal
 * technical prose, which describes this entire cohort.
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
 * Signal 1 — keystroke ratio. Client-reported, so forgeable, but forging it
 * takes both counters at once: removing the paste listener still leaves the
 * keystroke count short of the answer's length.
 */
export function keystrokeRatioFlags(
  answerLengths: LengthMap,
  telemetry: TelemetryMap,
  at: Date = new Date(),
): AttemptFlag[] {
  const out: AttemptFlag[] = [];
  for (const [questionId, answerLen] of Object.entries(answerLengths)) {
    if (answerLen <= FLAGS.keystrokeMinAnswerLen) continue;
    const t = telemetry[questionId];
    // No telemetry at all for a long answer is itself worth a look: the client
    // either never ran the listeners or dropped them.
    const keystrokes = t?.keystrokes ?? 0;
    if (keystrokes < answerLen * FLAGS.keystrokeRatio) {
      out.push(
        flag(
          'low_keystroke_ratio',
          questionId,
          {
            answerLen,
            keystrokes,
            pastes: t?.pastes ?? 0,
            pastedChars: t?.pastedChars ?? 0,
            ratio: Number((keystrokes / answerLen).toFixed(3)),
          },
          at,
        ),
      );
    }
  }
  return out;
}

export interface Snapshot {
  revision: number;
  lengths: LengthMap;
  at: Date | string;
}

/**
 * Signal 2 — burst appearance. The strong one, because it depends on no
 * client-side JavaScript at all. A browser can lie in its telemetry, but it must
 * send the actual answer text, and the server watches how that text grew.
 *
 * A genuine answer grows across syncs: 0 -> 120 -> 310 -> 480. A pasted one
 * appears as 0 -> 800 inside one interval.
 */
export function burstAppearanceFlags(
  snapshots: Snapshot[],
  at: Date = new Date(),
): AttemptFlag[] {
  const ordered = [...snapshots].sort((a, b) => a.revision - b.revision);
  const out: AttemptFlag[] = [];

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const curr = ordered[i]!;
    for (const [questionId, currentLen] of Object.entries(curr.lengths)) {
      const previousLen = prev.lengths[questionId] ?? 0;
      const delta = currentLen - previousLen;
      if (delta > FLAGS.burstDeltaChars) {
        out.push(
          flag(
            'burst_appearance',
            questionId,
            {
              from: previousLen,
              to: currentLen,
              delta,
              fromRevision: prev.revision,
              toRevision: curr.revision,
              // The two timestamps are what you read back to a parent on the
              // phone: "this answer went from 0 to 800 characters between
              // 11:42 and 11:43".
              fromAt: new Date(prev.at).toISOString(),
              toAt: new Date(curr.at).toISOString(),
            },
            at,
          ),
        );
      }
    }
  }
  return out;
}

/**
 * Signal 3 — IP change mid-attempt. Weak on its own: mobile networks rotate
 * addresses constantly. Useful only alongside another flag, which is why the
 * review queue sorts by severity and count rather than showing this one alone.
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

/** Character lengths of each answer. This — not the text — is what we persist. */
export function answerLengths(answers: Record<string, string>): LengthMap {
  const out: LengthMap = {};
  for (const [questionId, text] of Object.entries(answers)) {
    out[questionId] = typeof text === 'string' ? text.length : 0;
  }
  return out;
}
