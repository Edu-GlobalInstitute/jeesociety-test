'use client';

import {
  Children,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/**
 * The stacked break: the sections handed to this component do not scroll past
 * one another the way a normal page does. One section is pinned to the
 * viewport, and scrolling breaks it into shards that fall away, uncovering the
 * next section already sitting in the same place. The last one stays whole and
 * the page returns to ordinary scrolling under it.
 *
 * Three things this has to keep, because the landing page has to work for
 * everyone who opens it:
 *  - It is an enhancement, not the page. The server renders the sections in
 *    plain document order; the pinning only switches on after mount, and only
 *    on a viewport with the room for it. Nothing here is load-bearing.
 *  - It never hijacks the scroll. The wrapper is genuinely tall and the
 *    browser scrolls it normally — we only read the offset. Keyboard, scroll
 *    bar, find-in-page and a trackpad fling all behave as the visitor expects.
 *  - It stays off for `prefers-reduced-motion`. Sections that break apart are
 *    exactly what that setting is asking us not to do.
 *
 * The shards are real copies of the section, clipped to a polygon, not a
 * screenshot — so the text in a falling shard is the text that was there, and
 * no canvas rasterising is involved. The copies are aria-hidden and inert; the
 * accessible copy is the unclipped one underneath them.
 */

/** An inline style that also carries custom properties. */
type Vars = CSSProperties & Record<`--${string}`, string | number>;

/**
 * How much scroll a section is given, in viewports. More than one, so the
 * break plays out over a long enough stretch that it reads as breaking rather
 * than as a cut.
 */
const UNIT = 1.4;

/** How much of a section's scroll is spent reading it before it breaks. */
const HOLD = 0.3;

/**
 * How closely the break follows the wheel, as a time constant in milliseconds.
 * The break is driven by an eased value that chases the scroll position
 * instead of being read straight off it: a flick of the wheel can cross a
 * whole section in two or three frames, and a section that comes apart in
 * three frames just disappears. This lets it finish coming apart after the
 * scroll has stopped, and costs a slow scroll nothing it can see.
 */
const CHASE = 200;

/** The shard lattice. 4x3 reads as broken glass without 24 copies of a section. */
const COLS = 4;
const ROWS = 3;

/*
 * Room left around a section on top of its own padding, in the section's own
 * pixels. The panel clips what leaves it, and the prize photographs sit
 * outside the box they are measured in — the cut-out phone overlaps the frame
 * it is pinned to — so the measurement alone would crop them.
 */
const CLEARANCE = 48;

/** Below this the pinning is dropped: a section has to fit the viewport. */
const MIN_WIDTH = 760;
const MIN_HEIGHT = 600;

interface Shard {
  /** The polygon this copy of the section is clipped to, in percentages. */
  clip: string;
  /** Its centroid, used as the rotation origin so each piece spins in place. */
  ox: number;
  oy: number;
  /** Where it travels: out from the impact point, then down under gravity. */
  dx: number;
  dy: number;
  fall: number;
  rot: number;
  /** Its share of the break it waits out, so the crack spreads outward. */
  delay: number;
  /** 1 / (1 - delay), so the stylesheet multiplies rather than divides. */
  span: number;
}

/** Seeded, so a re-render never reshuffles a break that is halfway through. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds one section's shards from a jittered lattice. The vertices on the
 * section's edge stay put and the interior ones move, so the pieces tile the
 * section exactly — no gaps while it is still whole, and no straight seams
 * once it is not.
 */
function shardsFor(seed: number): Shard[] {
  const rnd = mulberry32(seed);
  const cellW = 100 / COLS;
  const cellH = 100 / ROWS;

  const vertX: number[][] = [];
  const vertY: number[][] = [];
  for (let row = 0; row <= ROWS; row += 1) {
    vertX[row] = [];
    vertY[row] = [];
    for (let col = 0; col <= COLS; col += 1) {
      const onEdgeX = col === 0 || col === COLS;
      const onEdgeY = row === 0 || row === ROWS;
      // Jitter stays inside half a cell, which keeps every quad simple.
      vertX[row][col] = col * cellW + (onEdgeX ? 0 : (rnd() - 0.5) * cellW * 0.68);
      vertY[row][col] = row * cellH + (onEdgeY ? 0 : (rnd() - 0.5) * cellH * 0.68);
    }
  }

  // Where the section is struck. Everything flies away from here.
  const hitX = 22 + rnd() * 56;
  const hitY = 20 + rnd() * 54;

  const shards: Shard[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const points: Array<[number, number]> = [
        [vertX[row][col], vertY[row][col]],
        [vertX[row][col + 1], vertY[row][col + 1]],
        [vertX[row + 1][col + 1], vertY[row + 1][col + 1]],
        [vertX[row + 1][col], vertY[row + 1][col]],
      ];
      const ox = points.reduce((sum, p) => sum + p[0], 0) / points.length;
      const oy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
      const spread = Math.hypot(ox - hitX, oy - hitY) / 100;

      const delay = Math.min(0.4, spread * 0.5);
      shards.push({
        clip: `polygon(${points.map(([x, y]) => `${x.toFixed(2)}% ${y.toFixed(2)}%`).join(', ')})`,
        ox,
        oy,
        dx: (ox - hitX) * 0.85 + (rnd() - 0.5) * 16,
        dy: (oy - hitY) * 0.3 - 5 - rnd() * 9,
        fall: 75 + rnd() * 75,
        rot: ((ox - hitX) / 50) * 20 + (rnd() - 0.5) * 20,
        delay,
        span: 1 / (1 - delay),
      });
    }
  }
  return shards;
}

export function ShatterStack({ children }: { children: ReactNode }) {
  const sections = Children.toArray(children);
  const count = sections.length;
  const shardSets = useMemo(
    () => Array.from({ length: count }, (_, index) => shardsFor(index * 7919 + 13)),
    [count],
  );

  const [enhanced, setEnhanced] = useState(false);
  /** Which section is pinned. Only this one and the one under it hold shards. */
  const [active, setActive] = useState(0);

  const stackRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panelRefs = useRef<Array<HTMLDivElement | null>>([]);
  const innerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const activeRef = useRef(0);
  const drawRef = useRef<(() => void) | null>(null);

  // Whether to pin at all. Re-checked on resize, so rotating a tablet or
  // opening the dev tools drops to plain scrolling rather than clipping text.
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const decide = () => {
      setEnhanced(
        !motion.matches
        && window.innerWidth >= MIN_WIDTH
        && window.innerHeight >= MIN_HEIGHT,
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

  useEffect(() => {
    if (!enhanced) return undefined;
    const stack = stackRef.current;
    const viewport = viewportRef.current;
    if (!stack || !viewport) return undefined;

    /**
     * The pinned element's own height — that is, whatever 100vh resolved to —
     * rather than window.innerHeight, so the scroll a section is given and the
     * space it is drawn in are the same number even where the two disagree.
     */
    const roomFor = () => viewport.clientHeight;

    /**
     * A section taller than the viewport is scaled down to fit rather than
     * clipped: the inner box is laid out at viewport / fit and drawn at fit,
     * so the text reflows at a larger logical size instead of being cut off.
     */
    const measure = () => {
      const room = roomFor();
      panelRefs.current.forEach((panel, index) => {
        const inner = innerRefs.current[index];
        if (!panel || !inner) return;
        const hidden = panel.style.display;
        panel.style.display = '';
        panel.style.setProperty('--fit', '1');
        inner.classList.add('stack__inner--measure');
        const needs = inner.offsetHeight + CLEARANCE;
        inner.classList.remove('stack__inner--measure');
        panel.style.setProperty('--fit', String(Math.min(1, room / Math.max(needs, 1))));
        panel.style.display = hidden;
      });
    };

    /** Where the scroll position says we are, in sections. */
    const target = () => {
      const scrolled = -stack.getBoundingClientRect().top;
      return Math.min(count - 0.0001, Math.max(0, scrolled / (roomFor() * UNIT)));
    };

    const draw = (progress: number) => {
      const index = Math.floor(progress);
      const within = progress - index;
      // The last section never breaks — there is nothing behind it, and the
      // page carries on underneath once its hold is over.
      const broken = index === count - 1
        ? 0
        : Math.min(1, Math.max(0, (within - HOLD) / (1 - HOLD)));

      panelRefs.current.forEach((panel, panelIndex) => {
        if (!panel) return;
        const near = panelIndex === index || panelIndex === index + 1;
        panel.style.display = near ? '' : 'none';
        panel.inert = panelIndex !== index;
        if (!near) {
          panel.classList.remove('is-breaking');
          panel.style.setProperty('--k', '0');
          panel.style.setProperty('--enter', '1');
          return;
        }
        if (panelIndex === index) {
          panel.style.setProperty('--k', String(broken));
          panel.style.setProperty('--enter', '1');
          // Landing in the middle of a break — scrolling back up, or a
          // restored scroll position — reaches it before React has mounted
          // its pieces. Showing the break then would hide the whole copy with
          // nothing in its place, so that frame stays unbroken; the effect
          // below draws it again once the pieces are there.
          const pieces = panel.querySelector('.stack__shards') !== null;
          panel.classList.toggle('is-breaking', broken > 0 && pieces);
        } else {
          // The one underneath: it is already in place, and rises the last
          // few percent as the one above it comes apart.
          panel.style.setProperty('--k', '0');
          panel.style.setProperty('--enter', String(broken));
          panel.classList.remove('is-breaking');
        }
      });

      if (index !== activeRef.current) {
        activeRef.current = index;
        setActive(index);
      }
    };

    /*
     * The eased value the break is actually drawn from, and the loop that
     * walks it towards the scroll position. The loop runs only while there is
     * a gap to close — once it has caught up it stops, and the next scroll
     * starts it again.
     */
    let shown = target();
    let frame = 0;
    let previous = 0;

    const step = (now: number) => {
      const wanted = target();
      const elapsed = previous ? Math.min(100, now - previous) : 16;
      previous = now;
      const gap = wanted - shown;
      if (Math.abs(gap) < 0.0004) {
        shown = wanted;
        frame = 0;
        previous = 0;
        draw(shown);
        return;
      }
      shown += gap * (1 - Math.exp(-elapsed / CHASE));
      draw(shown);
      frame = requestAnimationFrame(step);
    };

    const onScroll = () => {
      if (frame) return;
      previous = 0;
      frame = requestAnimationFrame(step);
    };

    drawRef.current = () => draw(shown);

    const onResize = () => {
      measure();
      // A resize moves the ground under the break; it is not something to
      // animate towards.
      shown = target();
      draw(shown);
    };

    measure();
    draw(shown);

    /*
     * The first measurement runs on markup whose photographs have no size yet
     * and whose type is still the fallback face, and both of those make a
     * section shorter than it will end up — so it is taken again once they
     * have landed. Without this the tallest section is scaled as if its
     * photographs were not there, and its top is cut off.
     */
    let stopped = false;
    const settle = () => {
      if (stopped) return;
      measure();
      shown = target();
      draw(shown);
    };
    if (document.readyState !== 'complete') window.addEventListener('load', settle);
    document.fonts?.ready.then(settle);

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      stopped = true;
      drawRef.current = null;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('load', settle);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      panelRefs.current.forEach((panel) => {
        if (!panel) return;
        panel.classList.remove('is-breaking');
        panel.removeAttribute('style');
        panel.inert = false;
      });
    };
  }, [enhanced, count]);

  // The pinned section's pieces mount a render after it becomes the pinned
  // one, so the frame that mounted them is drawn again with them in place.
  useEffect(() => {
    drawRef.current?.();
  }, [active]);

  if (!enhanced) {
    // Server render, no-JS, reduced motion, or a viewport with no room: the
    // sections are just sections.
    return <div className="stack">{sections}</div>;
  }

  return (
    <div
      className="stack stack--pinned"
      ref={stackRef}
      style={{ height: `${count * UNIT * 100}vh` }}
    >
      <div className="stack__viewport" ref={viewportRef}>
        {sections.map((section, index) => (
          <div
            key={index}
            className="stack__panel"
            ref={(node) => { panelRefs.current[index] = node; }}
            // The first section is the top of the pile, so it breaks first.
            style={{ zIndex: count - index }}
          >
            <div
              className="stack__inner stack__plain"
              ref={(node) => { innerRefs.current[index] = node; }}
            >
              {section}
            </div>

            {/* Mounted one section ahead of the break so the copies are laid
                out before the frame that first paints them. */}
            {(index === active || index === active + 1) && (
              <div
                className="stack__shards"
                aria-hidden="true"
                // The copies repeat the section's own links, so they are kept
                // out of the tab order and off the pointer. React 18 has no
                // `inert` prop, hence the ref.
                ref={(node) => { if (node) node.inert = true; }}
              >
                {shardSets[index].map((shard, shardIndex) => (
                  <div
                    key={shardIndex}
                    className="stack__shard"
                    style={{
                      transformOrigin: `${shard.ox}% ${shard.oy}%`,
                      '--dx': shard.dx.toFixed(2),
                      '--dy': shard.dy.toFixed(2),
                      '--fall': shard.fall.toFixed(2),
                      '--rot': shard.rot.toFixed(2),
                      '--d': shard.delay.toFixed(3),
                      '--span': shard.span.toFixed(4),
                    } as Vars}
                  >
                    {/* The clip sits on a child of the piece that is moved
                        and shadowed: a filter is applied before the clip, so
                        a shadow set here would be cast by the whole rectangle
                        and then cut away with it. */}
                    <div className="stack__shard__edge" style={{ clipPath: shard.clip }}>
                      <div className="stack__inner">{section}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Which one of the pile you are on. Inside the pinned viewport, so it
            stays put while the sections come and go behind it. */}
        <div className="stack__dots" aria-hidden="true">
          {sections.map((_, index) => (
            <span
              key={index}
              className={index === active ? 'stack__dot stack__dot--on' : 'stack__dot'}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
