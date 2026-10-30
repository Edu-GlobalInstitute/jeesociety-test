import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC, PAPER } from '@jee/shared/config';
import { SliceCards } from '../components/SliceCards';

/**
 * The toss is decoration; the three sentences under it are the offer. What
 * this file guards is that the server's own markup — which is what a visitor
 * with no JavaScript, a crawler and the static export itself all see — is the
 * finished section, with every card already in place and every number taken
 * from config rather than typed into the page.
 */

describe('SliceCards', () => {
  const markup = renderToStaticMarkup(<SliceCards />);

  it('renders all three cards in the server markup', () => {
    expect([...markup.matchAll(/class="slice-card"/g)]).toHaveLength(3);
  });

  it('states the entry ceiling, the lift and the host from config', () => {
    expect(markup).toContain(String(DIAGNOSTIC.entryCeilingMarks));
    expect(markup).toContain(String(PAPER.maxMarks));
    expect(markup).toContain(`+${DIAGNOSTIC.liftMarks}`);
    expect(markup).toContain(DIAGNOSTIC.webinarHost);
  });

  it('starts in the mode that moves nothing, so the section renders without JS', () => {
    // The hidden state is only ever armed after mount: a card tossed off-stage
    // in the HTML would stay off-stage for a visitor whose JS never arrives.
    expect(markup).toContain('slice__track--plain');
    expect(markup).not.toContain('--k:0');
    expect(markup).not.toContain('--k: 0');
  });

  it('keeps the words on one layer only, so nothing is read out twice', () => {
    // The cut is two copies of the card's surface, not of its text.
    // Two surface halves per card, counted by their modifier so the base
    // class on the same element is not counted twice.
    expect([...markup.matchAll(/slice-card__half--/g)]).toHaveLength(6);
    for (const card of ['Who it is for', 'What lands after', 'Who turns up']) {
      expect([...markup.matchAll(new RegExp(card, 'g'))]).toHaveLength(1);
    }
  });

  it('keeps the cut and everything it throws out of the accessibility tree', () => {
    const decoration = [...markup.matchAll(/<span class="slice-card__(seam|blade|juice)"[^>]*>/g)];
    expect(decoration).toHaveLength(9);
    for (const match of decoration) expect(match[0]).toContain('aria-hidden="true"');
  });

  it('asks for exactly as much scroll as it has cards to throw', () => {
    // --slice-run is the scroll the pinned stage is given, in viewports. Three
    // cards at 0.62 each plus a 0.45 tail; a card added without the section
    // growing would land off the bottom of its own scroll.
    const run = markup.match(/--slice-run:([\d.]+)/);
    expect(run).not.toBeNull();
    expect(Number(run?.[1])).toBeCloseTo(3 * 0.62 + 0.45, 5);
  });
});
