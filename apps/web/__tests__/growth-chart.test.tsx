import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GrowthChart, type GrowthPoint } from '../components/GrowthChart';

/**
 * The growth chart is evidence a reviewer acts on, so its geometry is checked
 * rather than eyeballed: marks inside the plot area, the flagged segment drawn
 * in the flagged colour, and the flag also stated in words.
 */

const LINE = '#3b7dc4';
const BURST = '#c07818';

const points = (lengths: number[]): GrowthPoint[] =>
  lengths.map((length, index) => ({
    revision: index + 1,
    at: new Date(Date.UTC(2026, 9, 25, 11, 40 + index)).toISOString(),
    length,
  }));

const render = (lengths: number[]) =>
  renderToStaticMarkup(
    <GrowthChart points={points(lengths)} burstThreshold={400} questionId="q61" />,
  );

function segmentStrokes(markup: string): string[] {
  return [...markup.matchAll(/<line[^>]*stroke="(#[0-9a-f]{6})"[^>]*stroke-width="2"/g)].map(
    (match) => match[1]!,
  );
}

describe('GrowthChart', () => {
  it('draws gradual growth entirely in the ordinary colour', () => {
    const strokes = segmentStrokes(render([0, 120, 310, 480]));
    expect(strokes).toHaveLength(3);
    expect(strokes.every((stroke) => stroke === LINE)).toBe(true);
  });

  it('draws the segment where an answer appeared in the flagged colour', () => {
    const strokes = segmentStrokes(render([0, 800, 820]));
    expect(strokes[0]).toBe(BURST);
    expect(strokes[1]).toBe(LINE);
  });

  it('states the flag in words, so status is never colour alone', () => {
    const markup = render([0, 800]);
    expect(markup).toContain('grew more than 400 characters in one interval');
  });

  it('says nothing about a burst when there is none', () => {
    expect(render([0, 120, 310])).not.toContain('grew more than');
  });

  it('keeps every mark inside the plot area', () => {
    const markup = render([0, 120, 310, 480, 1200]);
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

  it('puts the largest value at the top of the plot and zero on the baseline', () => {
    const markup = render([0, 1000]);
    const circles = [...markup.matchAll(/<circle[^>]*cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(circles[0]).toBeCloseTo(152, 0);
    expect(circles[1]).toBeCloseTo(14, 0);
  });

  it('carries a text description for a screen reader', () => {
    const markup = render([0, 800]);
    expect(markup).toContain('role="img"');
    expect(markup).toMatch(/aria-label="Answer length for q61[^"]*from 0 to 800 characters"/);
  });

  it('says so plainly when there is not enough data to draw', () => {
    const markup = renderToStaticMarkup(
      <GrowthChart points={points([0])} burstThreshold={400} questionId="q61" />,
    );
    expect(markup).toContain('Not enough syncs');
    expect(markup).not.toContain('<svg');
  });
});
