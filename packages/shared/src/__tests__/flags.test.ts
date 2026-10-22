import { describe, expect, it } from 'vitest';
import {
  answerLengths,
  burstAppearanceFlags,
  flagSeverity,
  ipChangeFlags,
  keystrokeRatioFlags,
  mergeFlags,
  type Snapshot,
} from '../flags.js';
import type { TelemetryMap } from '../types.js';

const telemetry = (keystrokes: number, pastes = 0, pastedChars = 0): TelemetryMap['x'] => ({
  keystrokes,
  pastes,
  pastedChars,
});

describe('keystrokeRatioFlags', () => {
  it('ignores short answers where the ratio means nothing', () => {
    expect(keystrokeRatioFlags({ q61: 150 }, { q61: telemetry(0) })).toHaveLength(0);
  });

  it('flags a long answer typed with too few keystrokes', () => {
    const flags = keystrokeRatioFlags({ q61: 800 }, { q61: telemetry(50, 1, 780) });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.code).toBe('low_keystroke_ratio');
    expect(flags[0]!.evidence).toMatchObject({ answerLen: 800, keystrokes: 50 });
  });

  it('does not flag an answer the student actually typed', () => {
    // Typing includes backspaces, so keystrokes routinely exceed final length.
    expect(keystrokeRatioFlags({ q61: 800 }, { q61: telemetry(950) })).toHaveLength(0);
  });

  it('flags a long answer with no telemetry at all', () => {
    // Stripping the listeners is itself the signal: the text still has to arrive.
    const flags = keystrokeRatioFlags({ q61: 800 }, {});
    expect(flags).toHaveLength(1);
    expect(flags[0]!.evidence).toMatchObject({ keystrokes: 0 });
  });

  it('reports evidence a human can read, not just a verdict', () => {
    const flags = keystrokeRatioFlags({ q61: 1000 }, { q61: telemetry(100, 2, 900) });
    expect(flags[0]!.evidence).toEqual({
      answerLen: 1000,
      keystrokes: 100,
      pastes: 2,
      pastedChars: 900,
      ratio: 0.1,
    });
  });
});

describe('burstAppearanceFlags', () => {
  const snap = (revision: number, lengths: Record<string, number>, minute: number): Snapshot => ({
    revision,
    lengths,
    at: new Date(Date.UTC(2026, 9, 25, 11, minute)),
  });

  it('does not flag an answer that grows gradually', () => {
    const flags = burstAppearanceFlags([
      snap(1, { q61: 0 }, 40),
      snap(2, { q61: 120 }, 41),
      snap(3, { q61: 310 }, 42),
      snap(4, { q61: 480 }, 43),
    ]);
    expect(flags).toHaveLength(0);
  });

  it('flags an answer that appears in one interval', () => {
    const flags = burstAppearanceFlags([
      snap(1, { q61: 0 }, 42),
      snap(2, { q61: 800 }, 43),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.code).toBe('burst_appearance');
    expect(flags[0]!.evidence).toMatchObject({ from: 0, to: 800, delta: 800 });
  });

  it('carries both timestamps so the growth can be quoted back', () => {
    const flags = burstAppearanceFlags([
      snap(1, { q61: 0 }, 42),
      snap(2, { q61: 800 }, 43),
    ]);
    expect(flags[0]!.evidence.fromAt).toBe('2026-10-25T11:42:00.000Z');
    expect(flags[0]!.evidence.toAt).toBe('2026-10-25T11:43:00.000Z');
  });

  it('sorts by revision, so out-of-order syncs do not fabricate a burst', () => {
    const flags = burstAppearanceFlags([
      snap(3, { q61: 310 }, 42),
      snap(1, { q61: 0 }, 40),
      snap(2, { q61: 120 }, 41),
    ]);
    expect(flags).toHaveLength(0);
  });

  it('treats a question absent from the earlier snapshot as length zero', () => {
    const flags = burstAppearanceFlags([snap(1, {}, 42), snap(2, { q62: 900 }, 43)]);
    expect(flags[0]!.evidence).toMatchObject({ from: 0, to: 900 });
  });

  it('does not flag an answer being deleted', () => {
    expect(burstAppearanceFlags([snap(1, { q61: 900 }, 42), snap(2, { q61: 0 }, 43)])).toHaveLength(0);
  });

  it('reports each bursting question separately', () => {
    const flags = burstAppearanceFlags([
      snap(1, { q61: 0, q62: 0 }, 42),
      snap(2, { q61: 900, q62: 950 }, 43),
    ]);
    expect(flags.map((f) => f.questionId).sort()).toEqual(['q61', 'q62']);
  });
});

describe('ipChangeFlags', () => {
  it('does not flag a stable address', () => {
    expect(
      ipChangeFlags([
        { ip: '1.2.3.4', at: new Date() },
        { ip: '1.2.3.4', at: new Date() },
      ]),
    ).toHaveLength(0);
  });

  it('flags once, not per change, when the address rotates', () => {
    const flags = ipChangeFlags([
      { ip: '1.2.3.4', at: new Date() },
      { ip: '5.6.7.8', at: new Date() },
      { ip: '9.9.9.9', at: new Date() },
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.evidence).toMatchObject({ distinctIps: 3 });
  });
});

describe('mergeFlags', () => {
  it('is idempotent across re-runs of the flag job', () => {
    const first = burstAppearanceFlags([
      { revision: 1, lengths: { q61: 0 }, at: new Date() },
      { revision: 2, lengths: { q61: 800 }, at: new Date() },
    ]);
    expect(mergeFlags(first, first)).toHaveLength(1);
    expect(mergeFlags(mergeFlags(first, first), first)).toHaveLength(1);
  });

  it('keeps distinct codes and distinct questions apart', () => {
    const merged = mergeFlags(
      keystrokeRatioFlags({ q61: 800 }, {}),
      keystrokeRatioFlags({ q62: 800 }, {}),
    );
    expect(merged).toHaveLength(2);
  });
});

describe('flagSeverity', () => {
  it('ranks a burst above an IP change', () => {
    const burst = burstAppearanceFlags([
      { revision: 1, lengths: { q61: 0 }, at: new Date() },
      { revision: 2, lengths: { q61: 800 }, at: new Date() },
    ]);
    const ip = ipChangeFlags([
      { ip: '1.1.1.1', at: new Date() },
      { ip: '2.2.2.2', at: new Date() },
    ]);
    expect(flagSeverity(burst)).toBeGreaterThan(flagSeverity(ip));
  });
});

describe('answerLengths', () => {
  it('records lengths, never the text', () => {
    const lengths = answerLengths({ q61: 'hello', q62: '' });
    expect(lengths).toEqual({ q61: 5, q62: 0 });
    expect(JSON.stringify(lengths)).not.toContain('hello');
  });
});
