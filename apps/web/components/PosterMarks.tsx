import { TEST_DATE_SHORT } from '../lib/testDate';

/**
 * The decorative marks around the poster headline: a four-point sparkle and a
 * scalloped seal. Both are inline SVG so they take the palette from CSS
 * `currentColor` and stay sharp at any size.
 */

/**
 * A scalloped circle, built as `bumps` outward arcs around radius `r`. Each
 * arc's own radius is the half-chord between two adjacent points on the
 * circle, which is what makes the bumps meet cleanly instead of overlapping.
 */
function scallopPath(cx: number, cy: number, r: number, bumps: number) {
  const step = (Math.PI * 2) / bumps;
  const arc = r * Math.sin(Math.PI / bumps);
  let d = '';
  for (let i = 0; i < bumps; i += 1) {
    const a0 = i * step;
    const a1 = (i + 1) * step;
    const x0 = cx + Math.cos(a0) * r;
    const y0 = cy + Math.sin(a0) * r;
    const x1 = cx + Math.cos(a1) * r;
    const y1 = cy + Math.sin(a1) * r;
    d += i === 0 ? `M ${x0.toFixed(2)} ${y0.toFixed(2)} ` : '';
    d += `A ${arc.toFixed(2)} ${arc.toFixed(2)} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} `;
  }
  return `${d}Z`;
}

const SEAL = scallopPath(60, 60, 52, 22);

/**
 * The four-point sparkle, in a 0-100 box. Exported because the hero's star
 * field draws the same mark at a much smaller size — one star shape on the
 * page, not two that nearly match.
 */
export const SPARKLE_PATH =
  'M50 0 C53 35 65 47 100 50 C65 53 53 65 50 100 C47 65 35 53 0 50 C35 47 47 35 50 0 Z';

export function Sparkle() {
  return (
    <svg className="sparkle" viewBox="0 0 100 100" aria-hidden="true">
      <path d={SPARKLE_PATH} fill="currentColor" />
    </svg>
  );
}

export function Seal() {
  return (
    <svg className="seal" viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <path
          id="seal-arc"
          d="M60,60 m-38,0 a38,38 0 1,1 76,0 a38,38 0 1,1 -76,0"
          fill="none"
        />
      </defs>
      <path className="seal__disc" d={SEAL} fill="currentColor" />
      <text className="seal__text">
        {/* textLength is the arc's circumference (2π × 38, less a hair), so the
            legend fits the ring exactly however long the date reads. */}
        <textPath
          href="#seal-arc"
          startOffset="0"
          textLength="236"
          lengthAdjust="spacingAndGlyphs"
        >
          {`JEESOCIETY · ALL-INDIA MOCK · ${TEST_DATE_SHORT.toUpperCase()} · `}
        </textPath>
      </text>
      <circle cx="60" cy="60" r="21" className="seal__hub" />
      <path
        d="M60 50 L60 69 M52 61.5 L60 70 L68 61.5"
        className="seal__arrow"
        fill="none"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The arrow that sits in the rounded square on every poster-style button. */
export function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12h13M12 5.5 18.5 12 12 18.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
