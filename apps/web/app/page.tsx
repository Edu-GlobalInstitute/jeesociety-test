import { DIAGNOSTIC, MENTORSHIP, PAPER } from '@jee/shared/config';
import './landing.css';
import { HeroStars } from '../components/HeroStars';
import { MentorNote } from '../components/MentorNote';
import { ArrowIcon, Seal, Sparkle } from '../components/PosterMarks';
import { RescueLadder } from '../components/RescueLadder';
import { Reveal } from '../components/Reveal';
import { SliceCards } from '../components/SliceCards';
import { LIST_PRICE } from '../lib/pricing';
import { Sunrise } from '../components/Sunrise';
import { TEST_DATE_SHORT, TEST_TIME_LABEL, TEST_WEEKDAY } from '../lib/testDate';

/**
 * The landing page.
 *
 * Written for a seventeen-year-old deciding whether the fee is worth it on a
 * Tuesday night, so it is built as one argument in four moves:
 *
 *   1. the morning, with the sun already up — who the paper is for before
 *      anything is promised to them, then the three steps it buys (the paper,
 *      the report, the webinar) acted out on a ladder beside the price;
 *   2. the same three conditions as the ladder, but one at a time and in
 *      words — thrown across the screen as the student scrolls, so the gate,
 *      the report and the webinar each get a beat of their own before the
 *      page asks for anything;
 *   3. a mentor, on video, saying it in his own voice — the one thing on the
 *      page that is a person rather than a pitch, which is why it comes
 *      before any of the detail;
 *   4. the price once more, on the sun fully up, with nothing else on screen
 *      to weigh against it.
 *
 * Every number on this page comes from @jee/shared/config, the same module the
 * payment route and the scoring code read, so the page cannot promise
 * something the system does not do. The date comes from TEST_STARTS_AT via
 * lib/testDate, so moving the event does not leave a stale poster behind.
 *
 * The two buttons say "Register" and nothing else, and both go to /checkout:
 * the price and the coupon are that page's argument to make, not the poster's.
 * The fee shown in the copy is lib/pricing's list price, the same number the
 * checkout box opens on, so the poster and the box cannot disagree.
 */

export default function Home() {
  return (
    <main className="landing">
      {/* ── 1. The morning, and what the paper is for ──────────────────── */}
      <section className="hero">
        <HeroStars />
        <Sunrise />

        <div className="wrap hero__inner">
          <div className="hero__copy">
            {/* Who it is for, before anything is promised. A student over the
                ceiling should stop reading; a student under it has just been
                told the page is about them. */}
            <p className="hero__gate">
              <span className="hero__gate-dot" aria-hidden="true" />
              {/* One span, not three text nodes: loose text inside a flex
                  container becomes separate items that cannot wrap into each
                  other, and this sentence is wider than a phone. */}
              <span>
                Only for students under{' '}
                <b>{DIAGNOSTIC.entryCeilingMarks}</b> of {PAPER.maxMarks}
              </span>
            </p>

            {/* Three beats, in the order the ladder beside them climbs: the
                paper, the report, the mentor — and the number they are all
                for. Two elements per line on purpose: the outer one carries
                the slow float that never stops, the inner one the entrance it
                arrives on. One element cannot do both — they would fight over
                `transform`. */}
            <h1 className="hero__title">
              <span className="hero__line"><span>One test.</span></span>
              <span className="hero__line"><span>One report. One IITian.</span></span>
              <span className="hero__line hero__line--lit">
                <span>+{DIAGNOSTIC.liftMarks} marks.</span>
              </span>
            </h1>

            <p className="hero__sub">
              One full JEE Main paper, a report showing exactly where your{' '}
              <b>{DIAGNOSTIC.liftMarks} marks</b> are hiding, and a live webinar where{' '}
              <b>an {DIAGNOSTIC.webinarHost}</b> shows you how to take them. ₹{LIST_PRICE}, once.
            </p>

            <div className="hero__actions">
              <a className="btn-sun btn-sun--big" href="/checkout">
                Register
                <span className="btn-sun__arrow" aria-hidden="true"><ArrowIcon /></span>
              </a>
            </div>
          </div>

          {/* The three steps, acted out: climb, stall, and a hand up. */}
          <div className="hero__art">
            <RescueLadder />
          </div>

          <span className="hero__sparkle" aria-hidden="true"><Sparkle /></span>
        </div>
      </section>

      {/* ── 2. The three conditions, one throw at a time ────────────────── */}
      <section className="band band--slice">
        <SliceCards />
      </section>

      {/* ── 3. The mentor, in his own voice ─────────────────────────────── */}
      <section className="band band--note">
        <div className="wrap note__wrap">
          <Reveal>
            <p className="band__eyebrow">Straight from the other side</p>
            <h2 className="band__title band__title--note">
              A note from your <em>IITian mentor</em>
            </h2>
          </Reveal>

          <Reveal delay={140}>
            <MentorNote />
          </Reveal>
        </div>
      </section>

      {/* ── The sun, fully up ───────────────────────────────────────────── */}
      <section className="finale">
        <span className="finale__seal" aria-hidden="true"><Seal /></span>
        <div className="wrap">
          <Reveal>
            <p className="finale__kicker">
              {TEST_WEEKDAY}, {TEST_DATE_SHORT} · {TEST_TIME_LABEL}
            </p>
            <p className="finale__price tnum">₹{LIST_PRICE}</p>
            <p className="finale__line">
              One paper. One all-India rank. One shot at {MENTORSHIP.months} free months with{' '}
              {MENTORSHIP.mentors} — and nothing more to pay, ever.
            </p>
            <a className="btn-sun btn-sun--big" href="/checkout">
              Register
              <span className="btn-sun__arrow" aria-hidden="true"><ArrowIcon /></span>
            </a>
            <p className="finale__small">
              Marks the next morning · final ranks the same week · {MENTORSHIP.months} free
              months with {MENTORSHIP.mentors} for the top 1%
            </p>
          </Reveal>
        </div>
      </section>
    </main>
  );
}
