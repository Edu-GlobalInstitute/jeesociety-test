import { describe, expect, it } from 'vitest';
import { bestSample, countdown, createClock, formatCountdown, offsetFromSample } from '../lib/clock.js';

/**
 * Getting this wrong means some students get 2h50m and others 3h10m on the same
 * paper, ranked against each other — so the arithmetic is tested directly.
 */

describe('offsetFromSample', () => {
  it('corrects a machine whose clock runs five minutes slow', () => {
    const { offsetMs } = offsetFromSample({
      requestedAt: 1_000_000,
      receivedAt: 1_000_100,
      serverTime: 1_000_000 + 300_000 + 50,
    });
    expect(offsetMs).toBe(300_000);
  });

  it('halves the round trip rather than blaming it all on the clock', () => {
    const { offsetMs, rttMs } = offsetFromSample({
      requestedAt: 0,
      receivedAt: 400,
      serverTime: 200,
    });
    expect(rttMs).toBe(400);
    // The server's timestamp was taken mid-exchange, so the midpoint is the
    // fair comparison and the offset is zero, not 200.
    expect(offsetMs).toBe(0);
  });
});

describe('bestSample', () => {
  it('prefers the fastest round trip', () => {
    const chosen = bestSample([
      { requestedAt: 0, receivedAt: 900, serverTime: 450 },
      { requestedAt: 0, receivedAt: 40, serverTime: 20 },
      { requestedAt: 0, receivedAt: 300, serverTime: 150 },
    ]);
    expect(chosen.receivedAt).toBe(40);
  });
});

describe('createClock', () => {
  it('produces a now() that tracks the server, not the machine', () => {
    const skewMs = 7 * 60_000;
    const local = Date.now();
    const clock = createClock([
      { requestedAt: local, receivedAt: local + 20, serverTime: local + skewMs + 10 },
    ]);
    expect(Math.abs(clock.now() - (Date.now() + skewMs))).toBeLessThan(50);
  });
});

describe('countdown', () => {
  it('breaks a duration into hours, minutes and seconds', () => {
    const value = countdown(10_000_000, 10_000_000 - (2 * 3600 + 34 * 60 + 56) * 1000);
    expect(value).toMatchObject({ hours: 2, minutes: 34, seconds: 56, expired: false });
  });

  it('clamps at zero rather than counting negative', () => {
    const value = countdown(1_000, 9_000);
    expect(value.totalMs).toBe(0);
    expect(value.expired).toBe(true);
    expect(formatCountdown(value)).toBe('00:00:00');
  });

  it('pads to a stable width so the digits do not jump', () => {
    expect(formatCountdown(countdown(9_000, 0))).toBe('00:00:09');
    expect(formatCountdown(countdown(3_600_000, 0))).toBe('01:00:00');
  });
});
