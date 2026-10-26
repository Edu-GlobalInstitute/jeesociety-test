'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Fades and lifts its children in when they first reach the viewport.
 *
 * The hidden state is applied from JavaScript rather than from the server
 * markup, which is the part that matters: this app is a static export, so if
 * the hidden class were in the HTML, a visitor whose JavaScript never arrives
 * would be left with a blank page instead of a landing page. The element is
 * therefore visible by default and is only armed once this component mounts —
 * which also means a browser without IntersectionObserver simply shows
 * everything.
 *
 * Anything already on screen is revealed on the observer's first callback, so
 * the first fold does not animate in from nothing.
 */
export function Reveal({
  children,
  className = '',
  delay = 0,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  /** Milliseconds of stagger, for siblings that should arrive in sequence. */
  delay?: number;
  /**
   * The element to render. A wrapper div inside a <ul> or an <ol> would be
   * invalid markup, so rows pass `as="li"` and the reveal lands on the row
   * itself rather than on a div around it.
   */
  as?: 'div' | 'li';
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (
      typeof IntersectionObserver === 'undefined'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setShown(true);
      return;
    }

    setArmed(true);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      // A little into the viewport, so the motion reads as arriving rather
      // than as something that was already there.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const classes = ['reveal', armed ? 'is-armed' : '', shown ? 'is-in' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag
      // One ref type for two tags: both are HTMLElement, which is all the
      // observer needs.
      ref={ref as React.RefObject<HTMLDivElement & HTMLLIElement>}
      className={classes}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
