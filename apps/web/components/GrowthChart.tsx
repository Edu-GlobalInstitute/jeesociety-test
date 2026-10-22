'use client';

import { useState } from 'react';

/**
 * Answer length across sync revisions, for one question.
 *
 * This chart has one job: let a reviewer see whether an answer was written or
 * pasted. Gradual growth (0 → 120 → 310 → 480) looks like writing; a single
 * near-vertical segment (0 → 800 in one interval) does not. The flagged segment
 * is drawn in a second colour **and** labelled, because status may never be
 * carried by colour alone.
 *
 * One series, so there is no legend — the title names it. Colours are
 * #3b7dc4 / #c07818, which pass all six checks of the palette validator on a
 * white surface (CVD ΔE 23.5, normal ΔE 26.8, contrast ≥ 3:1).
 */

export interface GrowthPoint {
  revision: number;
  at: string;
  length: number;
}

export interface GrowthChartProps {
  points: GrowthPoint[];
  /** Growth above this in one interval is drawn as the flagged segment. */
  burstThreshold: number;
  questionId: string;
}

const LINE = '#3b7dc4';
const BURST = '#c07818';
const W = 560;
const H = 180;
const PAD = { top: 14, right: 18, bottom: 28, left: 46 };

export function GrowthChart({ points, burstThreshold, questionId }: GrowthChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        Not enough syncs to show how this answer grew.
      </p>
    );
  }

  const maxLength = Math.max(...points.map((p) => p.length), 10);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (index: number) => PAD.left + (index / (points.length - 1)) * plotW;
  const y = (length: number) => PAD.top + plotH - (length / maxLength) * plotH;

  // Four gridlines, recessive, with the axis labelled in characters.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(maxLength * fraction));

  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return {
      from: previous,
      to: point,
      fromIndex: index,
      burst: point.length - previous.length > burstThreshold,
    };
  });

  const active = hover === null ? null : points[hover];

  return (
    <figure style={{ margin: 0 }}>
      <figcaption
        style={{ fontSize: '0.85rem', color: 'var(--ink-soft)', marginBottom: 6 }}
      >
        Answer length for {questionId}, by sync
      </figcaption>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Answer length for ${questionId} across ${points.length} syncs, from ${points[0]!.length} to ${points.at(-1)!.length} characters`}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block', maxWidth: W }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="#e4e9ee"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="10"
              fill="#76858f"
            >
              {tick}
            </text>
          </g>
        ))}

        {segments.map((segment) => (
          <line
            key={segment.to.revision}
            x1={x(segment.fromIndex)}
            y1={y(segment.from.length)}
            x2={x(segment.fromIndex + 1)}
            y2={y(segment.to.length)}
            stroke={segment.burst ? BURST : LINE}
            strokeWidth="2"
            strokeLinecap="round"
          />
        ))}

        {points.map((point, index) => (
          <circle
            key={point.revision}
            cx={x(index)}
            cy={y(point.length)}
            r={hover === index ? 5.5 : 4}
            fill={LINE}
            stroke="#ffffff"
            strokeWidth="2"
          />
        ))}

        {/* Hit targets wider than the marks, so hovering is easy. */}
        {points.map((point, index) => (
          <rect
            key={`hit-${point.revision}`}
            x={x(index) - plotW / (points.length * 2)}
            y={PAD.top}
            width={plotW / points.length}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}

        {active ? (
          <line
            x1={x(hover!)}
            x2={x(hover!)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="#9aa8b4"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        ) : null}

        <text x={PAD.left} y={H - 8} fontSize="10" fill="#76858f">
          rev {points[0]!.revision}
        </text>
        <text x={W - PAD.right} y={H - 8} fontSize="10" fill="#76858f" textAnchor="end">
          rev {points.at(-1)!.revision}
        </text>
      </svg>

      <p className="muted" style={{ marginTop: 6, minHeight: '1.4em' }}>
        {active
          ? `Revision ${active.revision} · ${active.length} characters · ${new Date(active.at).toLocaleTimeString()}`
          : segments.some((segment) => segment.burst)
            ? // Labelled, not colour-coded: status never travels by colour alone.
              `Highlighted: grew more than ${burstThreshold} characters in one interval.`
            : 'Hover a point to see its revision and time.'}
      </p>
    </figure>
  );
}
