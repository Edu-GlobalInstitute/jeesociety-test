import { describe, expect, it, vi } from 'vitest';
import { CLIENT_TIMING } from '@jee/shared';
import { ApiError } from '../lib/api.js';
import {
  submitDelayMs,
  submitWithBackoff,
  syncHealth,
  syncOnce,
  type SyncDeps,
} from '../lib/sync.js';

const deps = (over: Partial<SyncDeps> = {}): SyncDeps => ({
  getSnapshot: () => ({ attemptId: 'a', revision: 5, answers: { q1: 'A' } }),
  getSyncedRevision: () => 0,
  send: vi.fn().mockResolvedValue({ ok: true, revision: 5, stale: false }),
  onResult: vi.fn(),
  now: () => 1_000,
  ...over,
});

describe('syncOnce', () => {
  it('sends full state and reports the acknowledged revision', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, revision: 5, stale: false });
    const outcome = await syncOnce(deps({ send }));

    expect(outcome).toMatchObject({ status: 'sent', revision: 5, stale: false });
    // Full state, never a diff: the whole answer map on every sync.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 5, answers: { q1: 'A' } }),
    );
  });

  it('skips the request entirely when nothing has changed', async () => {
    const send = vi.fn();
    // This is where 30-40% of the event's traffic disappears: students who are
    // reading a question are not generating state to save.
    const outcome = await syncOnce(deps({ send, getSyncedRevision: () => 5 }));

    expect(outcome.status).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('skips when the server is somehow ahead of us', async () => {
    const send = vi.fn();
    const outcome = await syncOnce(deps({ send, getSyncedRevision: () => 9 }));
    expect(outcome.status).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('treats a stale response as success, not failure', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, revision: 9, stale: true });
    const outcome = await syncOnce(deps({ send }));

    // Anything else here produces a retry storm from 10,000 clients whose only
    // problem is a reordered packet.
    expect(outcome.status).toBe('sent');
    expect(outcome.stale).toBe(true);
  });

  it('reports a network failure without throwing', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const outcome = await syncOnce(deps({ send }));
    expect(outcome).toMatchObject({ status: 'failed', error: 'offline' });
    expect(outcome.stop).toBeFalsy();
  });

  it('stops the loop once the window has closed', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ApiError(403, 'window_closed', 'The test window has closed.'));
    const outcome = await syncOnce(deps({ send }));
    // Auto-submit owns the attempt from here; retrying would be noise.
    expect(outcome.stop).toBe(true);
  });
});

describe('syncHealth', () => {
  it('is fresh just after a sync', () => {
    expect(syncHealth(1_000, 1_000 + 60_000)).toBe('fresh');
  });

  it('turns stale after four minutes', () => {
    expect(syncHealth(0, CLIENT_TIMING.staleSyncWarnMs + 1)).toBe('stale');
  });

  it('reports never when nothing has reached the server yet', () => {
    expect(syncHealth(null, 10_000)).toBe('never');
  });
});

describe('submitWithBackoff', () => {
  it('returns the receipt on the first success', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: 'JEE-1-20261025-123456', alreadySubmitted: false });
    const result = await submitWithBackoff({ send, onAttempt: vi.fn(), sleep: async () => {} });

    expect(result!.receipt).toBe('JEE-1-20261025-123456');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retries on the documented 1/2/4/8/16 schedule', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ receipt: 'JEE-1-20261025-000001', alreadySubmitted: false });
    const waits: number[] = [];

    const result = await submitWithBackoff({
      send,
      onAttempt: vi.fn(),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(result).not.toBeNull();
    expect(waits).toEqual([1_000, 2_000]);
  });

  it('gives up after the schedule, leaving auto-submit to finish', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await submitWithBackoff({ send, onAttempt: vi.fn(), sleep: async () => {} });

    expect(result).toBeNull();
    expect(send).toHaveBeenCalledTimes(CLIENT_TIMING.submitBackoffMs.length + 1);
  });

  it('stops immediately once the window has closed', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ApiError(403, 'window_closed', 'closed'));
    const result = await submitWithBackoff({ send, onAttempt: vi.fn(), sleep: async () => {} });

    expect(result).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports a double-submit as success with the original receipt', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: 'JEE-1-20261025-777777', alreadySubmitted: true });
    const result = await submitWithBackoff({ send, onAttempt: vi.fn(), sleep: async () => {} });
    expect(result).toMatchObject({ alreadySubmitted: true });
  });
});

describe('submitDelayMs', () => {
  it('stays inside the jitter window', () => {
    expect(submitDelayMs(() => 0)).toBe(0);
    expect(submitDelayMs(() => 0.999999)).toBeLessThan(CLIENT_TIMING.submitJitterMs);
  });

  it('spreads a cohort across the window rather than bunching it', () => {
    const delays = Array.from({ length: 2_000 }, () => submitDelayMs());
    const buckets = new Set(delays.map((ms) => Math.floor(ms / 5_000)));
    // 45s of jitter across 9 five-second buckets: all of them should see traffic.
    expect(buckets.size).toBe(9);
  });
});
