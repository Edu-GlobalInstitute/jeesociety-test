import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PAPER } from '@jee/shared/config';
import { ProgressChart, type ProgressPoint } from '../components/ProgressChart';

/**
 * The progress chart is evidence a reviewer acts on, so its geometry is checked
 * rather than eyeballed: marks inside the plot area, the flagged segment drawn
 * in the flagged colour, and the flag also stated in words.
 */

const LINE = '#3b7dc4';
const JUMP = '#c07818';
const TOTAL = PAPER.totalCount;

const points = (answered: number[]): ProgressPoint[] =>
  answered.map((count, index) => ({
    revision: index + 1,
    at: new Date(Date.UTC(2026, 10, 23, 9, 40 + index)).toISOString(),
    answered: count,
  }));

const render = (answered: number[]) =>
  renderToStaticMarkup(
    <ProgressChart points={points(answered)} jumpThreshold={15} totalQuestions={TOTAL} />,
  );

function segmentStrokes(markup: string): string[] {
  return [...markup.matchAll(/<line[^>]*stroke="(#[0-9a-f]{6})"[^>]*stroke-width="2"/g)].map(
    (match) => match[1]!,
  );
}

describe('ProgressChart', () => {
  it('draws a steady working-through entirely in the ordinary colour', () => {
    const strokes = segmentStrokes(render([4, 11, 19, 28]));
    expect(strokes).toHaveLength(3);
    expect(strokes.every((stroke) => stroke === LINE)).toBe(true);
  });

  it('draws the segment where a block of answers appeared in the flagged colour', () => {
    const strokes = segmentStrokes(render([2, 60, 62]));
    expect(strokes[0]).toBe(JUMP);
    expect(strokes[1]).toBe(LINE);
  });

  it('states the flag in words, so status is never colour alone', () => {
    expect(render([0, 60])).toContain('more than 15 answers appeared in one interval');
  });

  it('says nothing about a jump when there is none', () => {
    expect(render([4, 11, 19])).not.toContain('answers appeared in one interval');
  });

  it('keeps every mark inside the plot area', () => {
    const markup = render([0, 11, 30, 52, TOTAL]);
    const circles = [...markup.matchAll(/<circle[^>]*cx="([\d.]+)"[^>]*cy="([\d.]+)"/g)];
    expect(circles.length).toBe(5);

    for (const circle of circles) {
      const cx = Number(circle[1]);
      const cy = Number(circle[2]);
      // Plot box: left 46, right 560-18, top 14, bottom 180-28.
      expect(cx).toBeGreaterThanOrEqual(46);
      expect(cx).toBeLessThanOrEqual(542);
      expect(cy).toBeGreaterThanOrEqual(14);
      expect(cy).toBeLessThanOrEqual(152);
    }
  });

  it('scales to the whole paper, not to the data', () => {
    // A student who answered 12 of 75 must not fill the plot: the axis is the
    // paper, so two attempts can be compared by glancing at their shapes.
    const markup = render([0, 12]);
    const circles = [...markup.matchAll(/<circle[^>]*cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(circles[0]).toBeCloseTo(152, 0);
    expect(circles[1]).toBeGreaterThan(100);
  });

  it('puts a full paper at the top of the plot and zero on the baseline', () => {
    const markup = render([0, TOTAL]);
    const circles = [...markup.matchAll(/<circle[^>]*cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(circles[0]).toBeCloseTo(152, 0);
    expect(circles[1]).toBeCloseTo(14, 0);
  });

  it('carries a text description for a screen reader', () => {
    const markup = render([0, 60]);
    expect(markup).toContain('role="img"');
    expect(markup).toMatch(
      new RegExp(`aria-label="Answers recorded[^"]*from 0 to 60 of ${TOTAL} questions"`),
    );
  });

  it('says so plainly when there is not enough data to draw', () => {
    const markup = renderToStaticMarkup(
      <ProgressChart points={points([4])} jumpThreshold={15} totalQuestions={TOTAL} />,
    );
    expect(markup).toContain('Not enough syncs');
    expect(markup).not.toContain('<svg');
  });
});
