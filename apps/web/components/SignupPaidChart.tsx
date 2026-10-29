'use client';

import { useId, useMemo, useState } from 'react';

/**
 * Signups against paid conversions, by day.
 *
 * A two-series line chart: the job is to tell two distinct series apart over
 * time, so colour is categorical. Two series is the comfortable end of the
 * ladder, and both are direct-labelled at their last point as well as being in
 * the legend — identity is never carried by colour alone.
 *
 * Hand-drawn SVG rather than a charting library, for the reason the rest of
 * this app avoids dependencies: the web app is a static export on Cloudflare
 * Pages and a 90 KB chart library for one chart would be in every student's
 * bundle too.
 *
 * Colours are slots 1 and 2 of the validated categorical palette
 * (blue #2a78d6, orange #eb6834). Checked with the dataviz validator against
 * this surface: worst-pair CVD ΔE 24.7 (protan), normal-vision ΔE 33.6,
 * both well clear of the gates. Do not substitute by eye.
 */

export interface DayPoint {
  day: string;
  signups: number;
  paid: number;
}

const SIGNUP = '#2a78d6';
const PAID = '#eb6834';

const WIDTH = 760;
const HEIGHT = 240;
const PAD = { top: 16, right: 54, bottom: 26, left: 40 };

export function SignupPaidChart({ data }: { data: DayPoint[] }) {
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const plot = useMemo(() => {
    const w = WIDTH - PAD.left - PAD.right;
    const h = HEIGHT - PAD.top - PAD.bottom;

    // The scale covers both series, because they share one axis. A second
    // y-scale for `paid` would make a flat conversion line look like a steep
    // one — the dual-axis mistake.
    const peak = Math.max(1, ...data.map((d) => Math.max(d.signups, d.paid)));
    // A round ceiling, so the gridlines land on numbers a reader recognises.
    const ceiling = niceCeiling(peak);

    const x = (index: number) =>
      PAD.left + (data.length <= 1 ? w / 2 : (index / (data.length - 1)) * w);
    const y = (value: number) => PAD.top + h - (value / ceiling) * h;

    return { w, h, ceiling, x, y };
  }, [data]);

  if (data.length === 0) {
    return <p className="empty">No data yet.</p>;
  }

  const line = (key: 'signups' | 'paid') =>
    data.map((point, index) => `${index === 0 ? 'M' : 'L'}${plot.x(index)},${plot.y(point[key])}`).join(' ');

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(plot.ceiling * fraction));
  const last = data[data.length - 1]!;
  const active = hover === null ? null : data[hover] ?? null;

  return (
    <div>
      {/* A legend is always present for two or more series. */}
      <p className="legend">
        <span className="legend__key">
          <span className="legend__swatch" style={{ background: SIGNUP }} />
          Signups
        </span>
        <span className="legend__key">
          <span className="legend__swatch" style={{ background: PAID }} />
          Paid
        </span>
        {active ? (
          <span className="legend__key" style={{ color: 'var(--admin-ink)' }}>
            {formatDay(active.day)}: {active.signups} signed up, {active.paid} paid
          </span>
        ) : null}
      </p>

      <svg
        className="chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={
          `Signups and paid conversions over ${data.length} days. `
          + `Most recent day: ${last.signups} signups, ${last.paid} paid.`
        }
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top} width={plot.w} height={plot.h} />
          </clipPath>
        </defs>

        {/* Recessive grid: present enough to read a value against, never
            competing with the data. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={plot.y(tick)}
              y2={plot.y(tick)}
              stroke="#e8ebef"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 7}
              y={plot.y(tick) + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="#8793a4"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {tick}
            </text>
          </g>
        ))}

        {/* Date labels at both ends and the middle only. A label per day would
            collide at 30 days and be unreadable at any width. */}
        {[0, Math.floor((data.length - 1) / 2), data.length - 1]
          .filter((index, position, all) => all.indexOf(index) === position)
          .map((index) => (
            <text
              key={index}
              x={plot.x(index)}
              y={HEIGHT - 8}
              textAnchor={index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle'}
              fontSize={10}
              fill="#8793a4"
            >
              {formatDay(data[index]!.day)}
            </text>
          ))}

        <g clipPath={`url(#${clipId})`}>
          {/* 2px lines, per the mark spec. */}
          <path d={line('signups')} fill="none" stroke={SIGNUP} strokeWidth={2} strokeLinejoin="round" />
          <path d={line('paid')} fill="none" stroke={PAID} strokeWidth={2} strokeLinejoin="round" />
        </g>

        {/* Crosshair and markers on hover. The 2px surface ring keeps the two
            markers legible where the series cross. */}
        {hover !== null && active ? (
          <g>
            <line
              x1={plot.x(hover)}
              x2={plot.x(hover)}
              y1={PAD.top}
              y2={PAD.top + plot.h}
              stroke="#8793a4"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle cx={plot.x(hover)} cy={plot.y(active.signups)} r={4.5} fill={SIGNUP} stroke="#fff" strokeWidth={2} />
            <circle cx={plot.x(hover)} cy={plot.y(active.paid)} r={4.5} fill={PAID} stroke="#fff" strokeWidth={2} />
          </g>
        ) : null}

        {/* Direct labels on the last point: with two series, identity should not
            depend on matching a colour to a legend. */}
        <text x={WIDTH - PAD.right + 6} y={plot.y(last.signups) + 3.5} fontSize={11} fontWeight={700} fill={SIGNUP}>
          {last.signups}
        </text>
        <text x={WIDTH - PAD.right + 6} y={plot.y(last.paid) + 3.5} fontSize={11} fontWeight={700} fill={PAID}>
          {last.paid}
        </text>

        {/* Hit targets, wider than the marks. Transparent rects rather than
            per-point handlers so the whole column is hoverable. */}
        {data.map((point, index) => (
          <rect
            key={point.day}
            x={plot.x(index) - plot.w / Math.max(1, data.length - 1) / 2}
            y={PAD.top}
            width={plot.w / Math.max(1, data.length - 1)}
            height={plot.h}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}
      </svg>
    </div>
  );
}

/** 0, 10, 25, 50, 100, 250… — a ceiling whose gridlines read as round numbers. */
function niceCeiling(peak: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= peak) return candidate;
  }
  return 10 * magnitude;
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00+05:30`);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
