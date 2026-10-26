import { SPARKLE_PATH } from './PosterMarks';

/**
 * A field of small blinking stars behind the poster headline.
 *
 * Three things constrain how this is built:
 *
 *  - **Positions must be deterministic.** The site is a static export, so this
 *    markup is generated at build time and then hydrated in the browser.
 *    Math.random() would produce different coordinates in each and React would
 *    throw a hydration mismatch, so the field comes from a seeded PRNG.
 *  - **It is the poster's own mark, smaller.** The star is the same four-point
 *    sparkle that sits beside the headline, so the background reads as part of
 *    the poster rather than as a second decorative idea.
 *  - **It is decoration.** It carries no meaning, so it is aria-hidden and
 *    takes no pointer events, and the reduced-motion rule holds it still
 *    rather than hiding it.
 */

const STAR_COUNT = 28;
const SEED = 0x5eed1e;

/** mulberry32 — small, fast, and identical on the server and in the browser. */
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
  peak: number;
}

const STARS: Star[] = (() => {
  const random = prng(SEED);
  return Array.from({ length: STAR_COUNT }, () => {
    const x = random() * 100;
    const y = random() * 100;
    return {
      x,
      y,
      size: 7 + random() * 11,
      // Spread across the cycle so they blink independently, never in unison.
      delay: random() * 7,
      duration: 3.2 + random() * 3.6,
      // The headline sits across the middle of the stage. Stars behind it are
      // dimmed rather than moved, which keeps the field even while leaving the
      // type the most legible thing on the poster.
      peak: (y > 28 && y < 72 ? 0.1 : 0.26) + random() * 0.12,
    };
  });
})();

export function HeroStars() {
  return (
    <div className="hero-stars" aria-hidden="true">
      {STARS.map((star, index) => (
        <svg
          key={index}
          className="hero-star"
          viewBox="0 0 100 100"
          style={{
            left: `${star.x.toFixed(3)}%`,
            top: `${star.y.toFixed(3)}%`,
            width: `${star.size.toFixed(2)}px`,
            height: `${star.size.toFixed(2)}px`,
            // Only the timing varies per star; the animation itself is in CSS.
            ['--star-delay' as string]: `${star.delay.toFixed(2)}s`,
            ['--star-duration' as string]: `${star.duration.toFixed(2)}s`,
            ['--star-peak' as string]: star.peak.toFixed(2),
          }}
        >
          <path d={SPARKLE_PATH} fill="currentColor" />
        </svg>
      ))}
    </div>
  );
}

export const starCount = STAR_COUNT;
