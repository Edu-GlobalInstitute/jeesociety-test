'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The celebration: two confetti cannons from the lower corners and a short
 * fall from above, in the brand's gold, orange and cream.
 *
 * It fires when it mounts, and it is mounted by the taster once a student
 * scores well (components/TryQuestions) — not on page load. Confetti for
 * arriving is noise; confetti for sixteen out of twenty is a reward.
 *
 * Three rules this has to keep, because a landing page is not a toy:
 *  - It never runs forever. The loop stops once the last piece leaves the
 *    viewport, or at HARD_STOP_MS whichever comes first, and the canvas is
 *    then removed from the DOM entirely.
 *  - It never eats a click. The canvas is pointer-events: none and
 *    aria-hidden, so it is invisible to both the mouse and a screen reader.
 *  - It does not run at all for a visitor who asked for less motion. That
 *    check happens here in JS, because the CSS `prefers-reduced-motion` rule
 *    cannot reach a canvas being painted frame by frame.
 */

/* The sunrise palette: gold, orange, cream, and the one teal. */
const COLORS = ['#ffc93c', '#ff8c42', '#fff4e0', '#ffffff', '#2ec4b6', '#ffb067'];
const HARD_STOP_MS = 7000;
const GRAVITY = 0.22;
const DRAG = 0.994;

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vrot: number;
  wobble: number;
  vwobble: number;
  color: string;
  round: boolean;
}

function piece(x: number, y: number, angle: number, power: number): Piece {
  const spread = (Math.random() - 0.5) * 0.9;
  const a = angle + spread;
  const speed = power * (0.55 + Math.random() * 0.75);
  return {
    x,
    y,
    vx: Math.cos(a) * speed,
    vy: Math.sin(a) * speed,
    w: 6 + Math.random() * 7,
    h: 9 + Math.random() * 8,
    rot: Math.random() * Math.PI * 2,
    vrot: (Math.random() - 0.5) * 0.34,
    wobble: Math.random() * Math.PI * 2,
    vwobble: 0.08 + Math.random() * 0.1,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    round: Math.random() < 0.22,
  };
}

export function Celebration() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches) {
      setDone(true);
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setDone(true);
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = window.innerWidth;
    let H = window.innerHeight;
    const size = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener('resize', size);

    const pieces: Piece[] = [];
    const cannon = (fromLeft: boolean, count: number, power: number) => {
      const x = fromLeft ? -10 : W + 10;
      const y = H * 0.92;
      const angle = fromLeft ? -Math.PI / 3.1 : -Math.PI + Math.PI / 3.1;
      for (let i = 0; i < count; i += 1) pieces.push(piece(x, y, angle, power));
    };
    const shower = (count: number) => {
      for (let i = 0; i < count; i += 1) {
        const p = piece(Math.random() * W, -20 - Math.random() * 120, Math.PI / 2, 2);
        p.vx = (Math.random() - 0.5) * 2.4;
        p.vy = 1 + Math.random() * 2.2;
        pieces.push(p);
      }
    };

    // One sequence, layered: both cannons, a second lighter pair, then a fall.
    cannon(true, 90, 17);
    cannon(false, 90, 17);
    const t2 = window.setTimeout(() => {
      cannon(true, 45, 14);
      cannon(false, 45, 14);
    }, 420);
    const t3 = window.setTimeout(() => shower(70), 760);

    const started = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      ctx.clearRect(0, 0, W, H);
      for (let i = pieces.length - 1; i >= 0; i -= 1) {
        const p = pieces[i]!;
        p.vy += GRAVITY;
        p.vx *= DRAG;
        p.vy *= DRAG;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vrot;
        p.wobble += p.vwobble;

        if (p.y > H + 60 || p.x < -120 || p.x > W + 120) {
          pieces.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        // Squashing X by the wobble reads as a flat piece tumbling in 3D.
        ctx.scale(Math.cos(p.wobble), 1);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
      }

      const expired = now - started > HARD_STOP_MS;
      if (pieces.length === 0 || expired) {
        ctx.clearRect(0, 0, W, H);
        setDone(true);
        return;
      }
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.removeEventListener('resize', size);
    };
  }, []);

  if (done) return null;
  return <canvas ref={canvasRef} className="celebrate" aria-hidden="true" />;
}
