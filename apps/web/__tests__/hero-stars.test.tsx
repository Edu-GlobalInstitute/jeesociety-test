import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeroStars, starCount } from '../components/HeroStars';
import { SPARKLE_PATH } from '../components/PosterMarks';

/**
 * The star field is decoration, but two of its properties are not cosmetic:
 * the markup must be byte-identical between the build and the browser, or
 * React throws a hydration mismatch on the landing page; and it must stay out
 * of the accessibility tree, because it means nothing.
 */

describe('HeroStars', () => {
  it('renders the requested number of stars', () => {
    const markup = renderToStaticMarkup(<HeroStars />);
    expect([...markup.matchAll(/class="hero-star"/g)]).toHaveLength(starCount);
  });

  it('is byte-identical across renders, so hydration cannot mismatch', () => {
    // The site is a static export: this markup is produced at build time and
    // again in the browser. Math.random() here would break the page.
    const first = renderToStaticMarkup(<HeroStars />);
    const second = renderToStaticMarkup(<HeroStars />);
    expect(first).toBe(second);
  });

  it('draws the poster\'s own sparkle, not a second star shape', () => {
    expect(renderToStaticMarkup(<HeroStars />)).toContain(SPARKLE_PATH);
  });

  it('stays out of the accessibility tree', () => {
    const markup = renderToStaticMarkup(<HeroStars />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="img"');
    expect(markup).not.toContain('aria-label');
  });

  it('keeps every star inside the hero box', () => {
    const markup = renderToStaticMarkup(<HeroStars />);
    const positions = [...markup.matchAll(/left:([\d.]+)%;top:([\d.]+)%/g)];
    expect(positions).toHaveLength(starCount);

    for (const position of positions) {
      expect(Number(position[1])).toBeGreaterThanOrEqual(0);
      expect(Number(position[1])).toBeLessThanOrEqual(100);
      expect(Number(position[2])).toBeGreaterThanOrEqual(0);
      expect(Number(position[2])).toBeLessThanOrEqual(100);
    }
  });

  it('gives every star its own phase, so they never blink in unison', () => {
    const markup = renderToStaticMarkup(<HeroStars />);
    const delays = [...markup.matchAll(/--star-delay:([\d.]+)s/g)].map((m) => m[1]);
    expect(new Set(delays).size).toBeGreaterThan(starCount / 2);
  });

  it('dims the stars that fall behind the headline', () => {
    const markup = renderToStaticMarkup(<HeroStars />);
    const stars = [...markup.matchAll(/top:([\d.]+)%;[^"]*--star-peak:([\d.]+)/g)].map((m) => ({
      top: Number(m[1]),
      peak: Number(m[2]),
    }));

    const behindTitle = stars.filter((star) => star.top > 28 && star.top < 72);
    const elsewhere = stars.filter((star) => star.top <= 28 || star.top >= 72);
    expect(behindTitle.length).toBeGreaterThan(0);
    expect(elsewhere.length).toBeGreaterThan(0);
    // The type stays the most legible thing on the poster.
    expect(Math.max(...behindTitle.map((s) => s.peak))).toBeLessThan(
      Math.min(...elsewhere.map((s) => s.peak)),
    );
  });

  it('never reaches an opacity that would compete with the type', () => {
    // The ceiling is 0.7, not the 0.4 it was while the hero was a night sky:
    // these are motes of light on pale cream now, and a mote at 0.4 on cream
    // is not visible at all. What the test is really guarding is the gap
    // between them and the type, which the previous case checks directly.
    const markup = renderToStaticMarkup(<HeroStars />);
    const peaks = [...markup.matchAll(/--star-peak:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...peaks)).toBeLessThanOrEqual(0.7);
  });
});
