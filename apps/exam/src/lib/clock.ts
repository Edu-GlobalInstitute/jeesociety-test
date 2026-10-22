import { CLIENT_TIMING } from '@jee/shared';

/**
 * Every timer in this app reads from here, never from Date.now() directly.
 *
 * Student machine clocks are routinely minutes off, and a few are wrong by
 * hours. If the countdown ran on the local clock, some students would get
 * 2h50m and others 3h10m — on the same paper, ranked against each other.
 */

export interface ServerClock {
  /** Server time in ms, corrected for this machine's offset. */
  now: () => number;
  /** How far this machine's clock is from the server's, in ms. */
  offsetMs: number;
  /** Round-trip time of the measurement that produced the offset. */
  rttMs: number;
}

export interface ClockSample {
  serverTime: number;
  requestedAt: number;
  receivedAt: number;
}

/**
 * Halves the round trip when estimating the offset: the server's timestamp was
 * taken somewhere in the middle of the exchange, so the midpoint of the local
 * request and response is the fairest local instant to compare it against.
 */
export function offsetFromSample(sample: ClockSample): { offsetMs: number; rttMs: number } {
  const rttMs = sample.receivedAt - sample.requestedAt;
  const localMidpoint = sample.requestedAt + rttMs / 2;
  return { offsetMs: sample.serverTime - localMidpoint, rttMs };
}

/**
 * Takes several samples and keeps the one with the lowest round trip. A single
 * sample on a congested connection can be off by seconds; the fastest of a few
 * is close to the truth.
 */
export function bestSample(samples: ClockSample[]): ClockSample {
  return samples.reduce((best, sample) =>
    sample.receivedAt - sample.requestedAt < best.receivedAt - best.requestedAt ? sample : best,
  );
}

export function createClock(samples: ClockSample[]): ServerClock {
  const { offsetMs, rttMs } = offsetFromSample(bestSample(samples));
  return { now: () => Date.now() + offsetMs, offsetMs, rttMs };
}

export interface Countdown {
  totalMs: number;
  hours: number;
  minutes: number;
  seconds: number;
  expired: boolean;
}

export function countdown(toMs: number, nowMs: number): Countdown {
  const totalMs = Math.max(0, toMs - nowMs);
  const totalSeconds = Math.floor(totalMs / 1000);
  return {
    totalMs,
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: totalMs <= 0,
  };
}

export function formatCountdown(value: Countdown): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(value.hours)}:${pad(value.minutes)}:${pad(value.seconds)}`;
}

export const clockResyncMs = CLIENT_TIMING.clockResyncMs;
