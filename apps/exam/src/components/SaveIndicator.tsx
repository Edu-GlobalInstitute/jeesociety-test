import { syncHealth } from '../lib/sync.js';

/**
 * A quiet, honest statement of when work last reached the server.
 *
 * Nothing here may imply the student's work is at risk, because it is not: the
 * answers are in IndexedDB, and server-side auto-submit finalises the attempt
 * from the last sync regardless of what this client manages to do. The
 * strongest wording in this file is "still saving".
 */

export interface SaveIndicatorProps {
  lastSyncedAt: number | null;
  now: number;
}

function relative(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

export function SaveIndicator({ lastSyncedAt, now }: SaveIndicatorProps) {
  const health = syncHealth(lastSyncedAt, now);

  const text =
    health === 'never'
      ? 'Saved on this device'
      : health === 'stale'
        ? `Still saving — last reached us ${relative(lastSyncedAt!, now)}`
        : `Saved ${relative(lastSyncedAt!, now)}`;

  return (
    <span className={`save save--${health}`} role="status" aria-live="polite">
      <span className="save__dot" aria-hidden="true" />
      {text}
    </span>
  );
}
