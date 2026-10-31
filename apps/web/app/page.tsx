import { DIAGNOSTIC, MENTORSHIP } from '@jee/shared/config';
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
            {/* The morning itself, before the promise: a student scanning the
                page decides first whether they are free that day. One span,
                not three text nodes — loose text inside a flex container
                becomes separate items that cannot wrap into each other. */}
            <p className="hero__when">
              <span className="hero__when-dot" aria-hidden="true" />
              <span>
                <b>{TEST_WEEKDAY}, {TEST_DATE_SHORT}</b> · {TEST_TIME_LABEL}
              </span>
            </p>

            {/* One sentence, broken over three beats, with the number lit in
                the middle of it — the headline says the thing the student is
                actually buying: marks on the attempt that counts. Two elements
                per line on purpose: the outer one carries the slow float that
                never stops, the inner one the entrance it arrives on. One
                element cannot do both — they would fight over `transform`. */}
            <h1 className="hero__title">
              <span className="hero__line"><span>A chance to add</span></span>
              <span className="hero__line hero__line--lit">
                <span>+{DIAGNOSTIC.liftMarks} marks</span>
              </span>
              <span className="hero__line"><span>to your January attempt.</span></span>
            </h1>

            <p className="hero__sub">
              The right test if you are scoring under{' '}
              <b>{DIAGNOSTIC.entryCeilingMarks}</b>, or have not finished more than{' '}
              <b>{DIAGNOSTIC.syllabusCeilingPercent}%</b> of the syllabus. You get a
              detailed report on where you are actually losing marks, and workshops
              where <b>an {DIAGNOSTIC.webinarHost}</b> turns it into{' '}
              <b>+{DIAGNOSTIC.liftMarks} marks</b> in your January attempt.
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
          </Reveal>
        </div>
      </section>
    </main>
  );
}
