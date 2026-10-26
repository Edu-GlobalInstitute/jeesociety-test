import { describe, expect, it } from 'vitest';
import { FLAG_SEVERITY } from '../config.js';
import { answerLengths, flagSeverity, ipChangeFlags, mergeFlags } from '../flags.js';

/**
 * What is tested here is as much what the module no longer does as what it
 * does. The behavioural signals are gone with the written paper, so the one
 * test that matters most is the last: a flag must never carry answer text into
 * the evidence a reviewer reads.
 */

describe('ipChangeFlags', () => {
  it('does not flag a stable address', () => {
    expect(
      ipChangeFlags([
        { ip: '1.2.3.4', at: new Date() },
        { ip: '1.2.3.4', at: new Date() },
      ]),
    ).toHaveLength(0);
  });

  it('does not flag a single sync', () => {
    expect(ipChangeFlags([{ ip: '1.2.3.4', at: new Date() }])).toHaveLength(0);
  });

  it('does not flag an attempt that never synced', () => {
    expect(ipChangeFlags([])).toHaveLength(0);
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

  it('carries the addresses as evidence, so a human can read them back', () => {
    const flags = ipChangeFlags([
      { ip: '1.2.3.4', at: '2026-11-23T09:12:00.000Z' },
      { ip: '5.6.7.8', at: '2026-11-23T10:40:00.000Z' },
    ]);
    expect(flags[0]!.evidence.ips).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(flags[0]!.evidence.first).toBe('2026-11-23T09:12:00.000Z');
  });

  it('attaches to the attempt rather than to a question', () => {
    // An address change is not a property of any one answer.
    const flags = ipChangeFlags([
      { ip: '1.1.1.1', at: new Date() },
      { ip: '2.2.2.2', at: new Date() },
    ]);
    expect(flags[0]!.questionId).toBeNull();
  });
});

describe('mergeFlags', () => {
  const ip = (at: string) =>
    ipChangeFlags(
      [
        { ip: '1.1.1.1', at },
        { ip: '2.2.2.2', at },
      ],
      new Date(at),
    );

  it('is idempotent across re-runs of the flag job', () => {
    const first = ip('2026-11-23T09:00:00.000Z');
    expect(mergeFlags(first, first)).toHaveLength(1);
    expect(mergeFlags(mergeFlags(first, first), first)).toHaveLength(1);
  });

  it('lets a re-run replace the evidence rather than appending to it', () => {
    const merged = mergeFlags(ip('2026-11-23T09:00:00.000Z'), ip('2026-11-23T11:00:00.000Z'));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.at).toBe('2026-11-23T11:00:00.000Z');
  });

  it('keeps an existing flag when nothing new is found', () => {
    const existing = ip('2026-11-23T09:00:00.000Z');
    expect(mergeFlags(existing, [])).toHaveLength(1);
  });
});

describe('flagSeverity', () => {
  it('sums the configured weights', () => {
    const flags = ipChangeFlags([
      { ip: '1.1.1.1', at: new Date() },
      { ip: '2.2.2.2', at: new Date() },
    ]);
    expect(flagSeverity(flags)).toBe(FLAG_SEVERITY.ip_change);
  });

  it('is zero for an unflagged attempt', () => {
    expect(flagSeverity([])).toBe(0);
  });
});

describe('answerLengths', () => {
  it('records lengths, never the text', () => {
    const lengths = answerLengths({ q1: 'B', q21: '12', q22: '' });
    expect(lengths).toEqual({ q1: 1, q21: 2, q22: 0 });
    expect(JSON.stringify(lengths)).not.toContain('B');
  });
});
