'use client';

import { useState } from 'react';

/**
 * How many answers the server held at each sync, across one attempt.
 *
 * This chart has one job: show a reviewer that someone actually sat the paper.
 * A student working through 75 questions produces a staircase — 4, 11, 19, 28 —
 * spread over three hours. An attempt whose answers all appear between two
 * consecutive syncs is a different story, and it is the kind of thing worth
 * reading beside the submission time and the addresses it arrived from.
 *
 * It replaced a chart of answer length per question, which measured how typed
 * prose grew. On an all-objective paper every answer is one or two characters,
 * so that chart had nothing left to show.
 *
 * One series, so there is no legend — the title names it. Colours are
 * #3b7dc4 / #c07818, which pass all six checks of the palette validator on a
 * white surface (CVD ΔE 23.5, normal ΔE 26.8, contrast ≥ 3:1).
 */

export interface ProgressPoint {
  revision: number;
  at: string;
  /** Questions with an answer recorded at this revision. */
  answered: number;
}

export interface ProgressChartProps {
  points: ProgressPoint[];
  /** Growth above this many answers in one interval is drawn as the flagged segment. */
  jumpThreshold: number;
  /** Total questions on the paper, so the axis is the paper and not the data. */
  totalQuestions: number;
}

const LINE = '#3b7dc4';
const JUMP = '#c07818';
const W = 560;
const H = 180;
const PAD = { top: 14, right: 18, bottom: 28, left: 46 };

export function ProgressChart({ points, jumpThreshold, totalQuestions }: ProgressChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        Not enough syncs to show how this attempt was filled in.
      </p>
    );
  }

  // The axis is the whole paper, so a student who answered 12 of 75 looks like
  // a student who answered 12 of 75 rather than filling the plot.
  const maxAnswers = Math.max(totalQuestions, ...points.map((p) => p.answered));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const x = (index: number) => PAD.left + (index / (points.length - 1)) * plotW;
  const y = (answers: number) => PAD.top + plotH - (answers / maxAnswers) * plotH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(maxAnswers * fraction));

  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return {
      from: previous,
      to: point,
      fromIndex: index,
      jump: point.answered - previous.answered > jumpThreshold,
    };
  });

  const active = hover === null ? null : points[hover];

  return (
    <figure style={{ margin: 0 }}>
      <figcaption
        style={{ fontSize: '0.85rem', color: 'var(--ink-soft)', marginBottom: 6 }}
      >
        Answers recorded, by sync
      </figcaption>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Answers recorded across ${points.length} syncs, from ${points[0]!.answered} to ${points.at(-1)!.answered} of ${totalQuestions} questions`}
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
            y1={y(segment.from.answered)}
            x2={x(segment.fromIndex + 1)}
            y2={y(segment.to.answered)}
            stroke={segment.jump ? JUMP : LINE}
            strokeWidth="2"
            strokeLinecap="round"
          />
        ))}

        {points.map((point, index) => (
          <circle
            key={point.revision}
            cx={x(index)}
            cy={y(point.answered)}
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
          ? `Revision ${active.revision} · ${active.answered} answered · ${new Date(active.at).toLocaleTimeString()}`
          : segments.some((segment) => segment.jump)
            ? // Labelled, not colour-coded: status never travels by colour alone.
              `Highlighted: more than ${jumpThreshold} answers appeared in one interval.`
            : 'Hover a point to see its revision and time.'}
      </p>
    </figure>
  );
}
