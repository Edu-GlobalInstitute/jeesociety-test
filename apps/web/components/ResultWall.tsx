'use client';

import { useEffect, useRef, useState } from 'react';
import { TOPPERS, type Topper } from '../lib/toppers';
import { youtubeId } from '../lib/youtube';

/**
 * The result wall.
 *
 * The page is called Results, so every card is built as a result slip: the
 * student's face on top, then the perforation, then the score in the place a
 * scorecard puts it. That is the whole idea of the page — instead of a table
 * of marks, the result list is four slips you can press play on, and the score
 * on each one is attached to a person explaining how it actually happened.
 *
 * Nothing of YouTube's loads until a card is clicked: each slip is a picture
 * and a button, and only the one that was pressed becomes an iframe. Four
 * embeds up front would have cost a student on a phone connection the better
 * part of a megabyte before they read a word.
 */

/** How long the score takes to run up to its real value. */
const COUNT_MS = 1150;

/** Decimals to hold while counting, so 99.5 never flickers as 99.50. */
function decimalsOf(value: number): number {
  const fraction = String(value).split('.')[1];
  return fraction ? fraction.length : 0;
}

/**
 * Whether the slip has been seen yet, and whether it is allowed to hide
 * itself first.
 *
 * `armed` is the important half, and it is the same bargain components/Reveal
 * strikes: the hidden state is only ever applied once this has mounted, so a
 * visitor whose JavaScript never arrives — this app is a static export — is
 * left with four readable slips rather than four blank spaces. Anyone who has
 * asked for less motion, or whose browser has no observer, is never armed at
 * all and gets the finished card immediately.
 */
function useSeen<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [armed, setArmed] = useState(false);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (
      typeof IntersectionObserver === 'undefined'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setSeen(true);
      return;
    }

    setArmed(true);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setSeen(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.2 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, armed, seen };
}

/**
 * The score, running up to its real value the first time the slip is on
 * screen. It starts at 90 rather than at 0 because the last tenth of a
 * percentile is the whole story on this page: a number sweeping 0 → 99.66
 * reads as a loading bar, where 90 → 99.66 reads as a rank being climbed.
 *
 * The final value is also written into the markup as plain text for screen
 * readers, so the animation is decoration over a number that is simply there.
 */
function Score({ value, run }: { value: number; run: boolean }) {
  const places = decimalsOf(value);
  const [shown, setShown] = useState(value);

  useEffect(() => {
    if (!run) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }

    const from = Math.max(0, value - 9.5);
    const started = performance.now();
    let frame = 0;

    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / COUNT_MS);
      /* Ease out, so it decelerates onto the real number instead of stopping
         dead on it. */
      const eased = 1 - (1 - t) ** 3;
      setShown(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, value]);

  return (
    <span className="slip__score">
      <span className="slip__num tnum" aria-hidden="true">
        {shown.toFixed(places)}
      </span>
      <span className="slip__unit">
        <span className="slip__sr">{value.toFixed(places)} </span>
        %ile
      </span>
    </span>
  );
}

/** The play triangle, and the ring that pulses around it until it is used. */
function PlayMark() {
  return (
    <span className="slip__play" aria-hidden="true">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5.2v13.6L19.5 12 8 5.2Z" fill="currentColor" />
      </svg>
    </span>
  );
}

function Slip({ topper, index }: { topper: Topper; index: number }) {
  const id = youtubeId(topper.link);
  const [playing, setPlaying] = useState(false);
  /* maxresdefault is missing on some uploads; hqdefault always exists. */
  const [thumb, setThumb] = useState('maxresdefault');
  const { ref, armed, seen } = useSeen<HTMLElement>();

  return (
    <article
      ref={ref}
      className={`slip${armed ? ' is-armed' : ''}${seen ? ' is-in' : ''}`}
      /* The stagger is a custom property rather than a transition-delay so one
         declaration drives both the arrival and the hover lift. */
      style={{ '--slip-delay': `${index * 90}ms` } as React.CSSProperties}
    >
      {/* The slip's own serial line, where a scorecard carries the roll
          number. It counts position on this wall and nothing else — the
          channel's own episode numbers are not what this list is ordered by,
          so claiming them here would be inventing a fact. */}
      <p className="slip__serial">
        <span>No. {String(index + 1).padStart(2, '0')}</span>
        <span className="slip__serial-tag">JEEsociety podcast</span>
      </p>

      <div className="slip__stage">
        {playing && id ? (
          <iframe
            className="slip__frame"
            /* nocookie, and autoplay only because the student just clicked. */
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`}
            title={topper.title}
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            className="slip__poster"
            onClick={() => id && setPlaying(true)}
            disabled={!id}
            aria-label={id ? `Play: ${topper.title}` : 'Video link not added yet'}
          >
            {id ? (
              <>
                <img
                  className="slip__thumb"
                  src={`https://i.ytimg.com/vi/${id}/${thumb}.jpg`}
                  onError={() => setThumb('hqdefault')}
                  /* Decorative: the title and the name beside it already say
                     what this is, so a description here would only repeat
                     them to a screen reader. */
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                />
                <PlayMark />
                <span className="slip__watch" aria-hidden="true">Watch</span>
              </>
            ) : (
              <span className="slip__missing">Link not added yet</span>
            )}
          </button>
        )}
      </div>

      {/* The perforation. Two notches bitten out of the edges and a dashed
          rule between them, which is the one detail that makes the card read
          as a slip that was torn off rather than a tile. */}
      <div className="slip__tear" aria-hidden="true" />

      <div className="slip__body">
        <div className="slip__who">
          <h3 className="slip__name">{topper.name}</h3>
          <p className="slip__badge">{topper.badge}</p>
        </div>

        {topper.percentile !== null ? (
          <Score value={topper.percentile} run={seen} />
        ) : (
          /* No percentile was ever published for this one, so the slot holds
             the seat instead. Same weight on the page, no invented number. */
          <span className="slip__score slip__score--seat">
            <span className="slip__seat">{topper.seat}</span>
            <span className="slip__unit">the seat he took</span>
          </span>
        )}
      </div>

      <p className="slip__title">{topper.title}</p>
      <p className="slip__hook">{topper.hook}</p>
    </article>
  );
}

export function ResultWall() {
  return (
    <div className="wall">
      {TOPPERS.map((topper, index) => (
        <Slip key={topper.link} topper={topper} index={index} />
      ))}
    </div>
  );
}
