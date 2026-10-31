'use client';

import { useEffect, useRef, useState } from 'react';
import { DIAGNOSTIC } from '@jee/shared/config';

/**
 * The three conditions of the offer, thrown across the screen one at a time.
 *
 * The section holds one horizontal row of three cards, and the row is empty
 * when it arrives: each card is tossed in from the left on an arc as the
 * student scrolls, spinning as it flies, and settles onto its place in the
 * row. Three cards, three tosses, one section. Scrolling is the throwing
 * hand.
 *
 * It says the three things a student has to know before they pay, in the order
 * they matter: the paper is only for students under
 * {@link DIAGNOSTIC.entryCeilingMarks}; the report after it maps
 * {@link DIAGNOSTIC.liftMarks} more marks; and a
 * {@link DIAGNOSTIC.webinarHost} takes the paper apart on a live webinar.
 * Every number comes from @jee/shared/config, so a card cannot promise
 * something the system does not do.
 *
 * It runs in one of three modes, decided after mount and re-decided on every
 * resize, because this page is a static export and has to be readable before
 * any of this arrives:
 *
 *  - `plain` — the server's own markup, and what a visitor gets with no
 *    JavaScript or with `prefers-reduced-motion`. Every card sits at rest:
 *    `--k` is registered with an initial value of 1 (app/landing.css), so the
 *    cards are whole and in place until something says otherwise. Nothing
 *    here is load-bearing.
 *  - `pinned` — a viewport with the room for the row. The section is given
 *    real height, the stage inside it sticks to the window, and this component
 *    reads the scroll offset and writes each card's `--k`. It never hijacks
 *    the scroll: the page scrolls normally and we only measure it, so the
 *    keyboard, the scrollbar, find-in-page and a trackpad fling all behave.
 *  - `enter` — a phone, where three cards side by side would be three
 *    unreadable columns. The row becomes a stack and each card is tossed in
 *    by an IntersectionObserver as it reaches the viewport instead of being
 *    driven by the scroll offset.
 *
 * Both moving modes drive the same single custom property, `--k` (0 = still
 * off-stage left, 1 = landed), so the stylesheet describes the toss exactly
 * once and neither mode carries a flight of its own.
 */

/** Viewports of scroll each card is given while the stage is pinned. */
const UNIT = 0.62;

/** The share of a card's window spent in the air; the rest it sits still. */
const FLIGHT = 0.7;

/**
 * Viewports of scroll held after the last card lands, so the row is not
 * released by the window the instant it is complete.
 */
const TAIL = 0.45;

/**
 * How long a toss takes in `enter` mode, where there is no scroll offset to
 * read and the flight is a transition. Handed to the stylesheet as
 * `--slice-toss` so the duration is stated once, here.
 */
const TOSS_MS = 780;

/** Below either of these the row is stacked and the pinning is dropped. */
const MIN_WIDTH = 760;
const MIN_HEIGHT = 560;

type Mode = 'plain' | 'pinned' | 'enter';

/**
 * The three cards. `stat` is what the eye lands on first, so it is kept to a
 * word or a number; the title is the claim and the text is the proof.
 */
const CARDS = [
  {
    kicker: 'Who it is for',
    stat: 'Struggling',
    title: `Students still under ${DIAGNOSTIC.entryCeilingMarks} marks`,
    text: `If you have still not covered ${DIAGNOSTIC.syllabusCeilingPercent}% of the `
      + `syllabus, and you are not scoring more than ${DIAGNOSTIC.entryCeilingMarks} marks, `
      + 'this test is a life saver for you.',
  },
  {
    kicker: 'The benefit',
    stat: `+${DIAGNOSTIC.liftMarks}`,
    title: `A personalised report that adds ${DIAGNOSTIC.liftMarks} marks to your `
      + 'January attempt',
    text: 'Every loophole in your preparation, named one by one — the chapters quietly '
      + 'bleeding marks, the mistakes you repeat, the minutes you burn.',
  },
  {
    kicker: 'Who turns up',
    stat: DIAGNOSTIC.webinarHost,
    title: 'Workshops to implement the strategy and be consistent',
    text: 'Live, on the paper you just sat: the exact analysis an IITian runs after every '
      + 'mock. Copy that one habit and your score stops swinging.',
  },
] as const;

export function SliceCards() {
  const [mode, setMode] = useState<Mode>('plain');

  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLLIElement | null>>([]);

  /*
   * Which mode to run in. Re-decided on resize, so rotating a phone or
   * dragging a window narrow moves between the stacked toss and the pinned row
   * rather than leaving a row too cramped to read.
   */
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => {
      if (motion.matches) {
        // Cards flying in from off-screen are exactly what this setting asks
        // us not to do.
        setMode('plain');
        return;
      }
      setMode(
        window.innerWidth >= MIN_WIDTH && window.innerHeight >= MIN_HEIGHT ? 'pinned' : 'enter',
      );
    };

    decide();
    motion.addEventListener('change', decide);
    window.addEventListener('resize', decide);
    return () => {
      motion.removeEventListener('change', decide);
      window.removeEventListener('resize', decide);
    };
  }, []);

  /** Puts every card back at rest, so a change of mode starts from nothing. */
  const clearCards = () => {
    for (const card of cardRefs.current) {
      if (!card) continue;
      card.style.removeProperty('--k');
    }
  };

  /* `pinned`: the scroll offset drives the toss. */
  useEffect(() => {
    if (mode !== 'pinned') return undefined;
    const track = trackRef.current;
    const stage = stageRef.current;
    if (!track || !stage) return undefined;

    let frame = 0;

    const draw = () => {
      frame = 0;
      /*
       * The stage's own height — whatever 100vh resolved to — rather than
       * window.innerHeight, so the scroll a card is given and the space it is
       * drawn in are the same number even where the two disagree, which on a
       * phone browser with a retracting toolbar they do.
       */
      const room = stage.clientHeight;
      if (room <= 0) return;

      /** Where the scroll says we are, measured in cards. */
      const progress = Math.max(0, -track.getBoundingClientRect().top) / (room * UNIT);

      cardRefs.current.forEach((card, index) => {
        if (!card) return;
        const k = Math.min(1, Math.max(0, (progress - index) / FLIGHT));
        card.style.setProperty('--k', k.toFixed(4));
      });
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    draw();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      clearCards();
    };
  }, [mode]);

  /* `enter`: one toss per card, as it reaches the viewport. */
  useEffect(() => {
    if (mode !== 'enter') return undefined;
    const cards = cardRefs.current.filter((card): card is HTMLLIElement => card !== null);
    if (cards.length === 0) return undefined;

    if (typeof IntersectionObserver === 'undefined') return undefined;

    // Armed from JavaScript, never from the server markup: a card hidden in
    // the HTML would stay hidden for a visitor whose JS never arrives.
    for (const card of cards) card.style.setProperty('--k', '0');

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const card = entry.target as HTMLLIElement;
          card.style.setProperty('--k', '1');
          observer.unobserve(card);
        }
      },
      { rootMargin: '0px 0px -14% 0px', threshold: 0.2 },
    );

    for (const card of cards) observer.observe(card);
    return () => {
      observer.disconnect();
      clearCards();
    };
  }, [mode]);

  return (
    <div
      ref={trackRef}
      className={`slice__track slice__track--${mode}`}
      style={{
        // The height the pinning needs: one window for the stage itself, plus
        // the scroll the tosses are spread over. Only read in `pinned` mode.
        '--slice-run': CARDS.length * UNIT + TAIL,
        '--slice-toss': `${TOSS_MS}ms`,
      } as React.CSSProperties}
    >
      <div ref={stageRef} className="slice__stage">
        <div className="wrap">
          <h2 className="band__title slice__title">
            Now read this carefully
          </h2>

          <ul className="slice__row">
            {CARDS.map((card, index) => (
              <li
                key={card.kicker}
                ref={(node) => {
                  cardRefs.current[index] = node;
                }}
                className="slice-card"
              >
                {/* The cell above never moves; everything below it flies. */}
                <div className="slice-card__fly">
                  {/* The layer that never stops floating, separate from the one
                      that flies because a single element cannot carry both
                      transforms — they would fight over the property. */}
                  <div className="slice-card__bob">
                    {/*
                      The card's surface: one layer behind the words rather than
                      a box around them, so the panel keeps its own shadow and
                      rounding while the text above it inherits neither.
                    */}
                    <span className="slice-card__face" aria-hidden="true" />

                    <div className="slice-card__body">
                      <p className="slice-card__kicker">{card.kicker}</p>
                      <p className="slice-card__stat tnum">{card.stat}</p>
                      <h3 className="slice-card__title">{card.title}</h3>
                      <p className="slice-card__text">{card.text}</p>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
