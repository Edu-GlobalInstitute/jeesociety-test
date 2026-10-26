'use client';

import { useEffect, useState } from 'react';
import { TEST_STARTS_AT } from '@jee/shared/config';

/**
 * Time left until the paper opens.
 *
 * The first render deliberately shows placeholders rather than a real figure.
 * This page is a static export, so anything computed during the build would be
 * baked into the HTML and served stale — and rendering "now" on the server
 * would not match what the browser computes a moment later, which React treats
 * as a hydration error. So the server renders dashes and the clock starts in
 * the effect, where the browser's own time is available.
 */

const TARGET = Date.parse(TEST_STARTS_AT);

const CELLS = [
  { key: 'days', label: 'days' },
  { key: 'hrs', label: 'hrs' },
  { key: 'mins', label: 'mins' },
  { key: 'secs', label: 'secs' },
] as const;

function split(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: String(Math.floor(total / 86400)),
    hrs: String(Math.floor((total % 86400) / 3600)).padStart(2, '0'),
    mins: String(Math.floor((total % 3600) / 60)).padStart(2, '0'),
    secs: String(total % 60).padStart(2, '0'),
  };
}

export function Countdown() {
  const [left, setLeft] = useState<ReturnType<typeof split> | null>(null);

  useEffect(() => {
    const tick = () => setLeft(split(TARGET - Date.now()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="countdown">
      {CELLS.map((cell) => (
        <div className="countdown__cell" key={cell.key}>
          <span className="countdown__num tnum">{left ? left[cell.key] : '--'}</span>
          <span className="countdown__label">{cell.label}</span>
        </div>
      ))}
    </div>
  );
}
