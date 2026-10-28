import {
  CLIENT_TIMING,
  MCQ_MARKS,
  PAPER,
  REWARD_BANDS,
  TEST_FEE_PAISE,
} from '@jee/shared/config';
import './landing.css';
import { Countdown } from '../components/Countdown';
import { HeroStars } from '../components/HeroStars';
import { ArrowIcon, Seal, Sparkle } from '../components/PosterMarks';
import { PrizeDevices } from '../components/PrizeDevices';
import { RescueLadder } from '../components/RescueLadder';
import { Reveal } from '../components/Reveal';
import { Sunrise } from '../components/Sunrise';
import { TryQuestions } from '../components/TryQuestions';
import { TASTER_QUESTIONS, TASTER_SOURCE } from '../lib/tasterQuestions';
import { TEST_DATE_SHORT, TEST_TIME_LABEL, TEST_WEEKDAY } from '../lib/testDate';

/**
 * The landing page.
 *
 * Written for a seventeen-year-old deciding whether ₹300 is worth it on a
 * Tuesday night, so it is built as one argument in six moves:
 *
 *   1. the night sky and the sun coming up — the brand's whole idea, which is
 *      that hope only reads as hope against something dark;
 *   2. five real questions they can answer before paying, marked +4 / −1, so
 *      the claim "JEE level" is something they felt rather than read;
 *   3. what the top of the rank list takes home;
 *   4. what the paper actually is;
 *   5. what happens when their connection dies at minute 170 — the question
 *      every student in India actually asks;
 *   6. the four steps and the price again.
 *
 * Every number on this page comes from @jee/shared/config, the same module the
 * payment route and the scoring code read, so the page cannot promise
 * something the system does not do. The date comes from TEST_STARTS_AT via
 * lib/testDate, so moving the event does not leave a stale poster behind.
 */

const RUPEES = TEST_FEE_PAISE / 100;
const SYNC_SECONDS = CLIENT_TIMING.syncIntervalMs / 1000;
const LOBBY_MINUTES = CLIENT_TIMING.lobbyLeadMs / 60_000;

/** The prose for each band. The numbers live in @jee/shared; the voice here. */
const BAND_NOTE: Record<number, string> = {
  99: 'Your pick of the two, once the final rank list is published.',
  98: 'A full mentorship seat at JEE Society, paid for by us.',
  97: 'The same seat at JEE Society, for half the price.',
};

/** Reads 99 as "99.0 and up", and the closed bands as "98.0 – 98.9". */
function bandRange(floor: number, index: number) {
  return index === 0 ? `${floor}.0 and up` : `${floor}.0 – ${floor}.9`;
}

export default function Home() {
  return (
    <main className="landing">
      {/* ── 1. Night, and the sun coming up ─────────────────────────────── */}
      <section className="hero">
        <HeroStars />
        <Sunrise />

        <div className="wrap hero__inner">
          <div className="hero__copy">
            <p className="hero__pills">
              <span className="pill pill--live">
                <span className="pill__dot" aria-hidden="true" />
                Registration open
              </span>
              <span className="pill">Online · All India</span>
              <span className="pill pill--date">
                {TEST_WEEKDAY}, {TEST_DATE_SHORT} · {TEST_TIME_LABEL}
              </span>
            </p>

            {/* Two elements per line on purpose: the outer one carries the slow
                float that never stops, the inner one the entrance it arrives on.
                One element cannot do both — they would fight over `transform`. */}
            <h1 className="hero__title">
              <span className="hero__line"><span>Three hours.</span></span>
              <span className="hero__line"><span>One all-India rank.</span></span>
              <span className="hero__line hero__line--lit"><span>Top 1% wins an iPad.</span></span>
            </h1>

            <p className="hero__sub">
              One full-length paper, sat on the same morning by students all over the country.{' '}
              {PAPER.totalCount} questions in three hours for {PAPER.maxMarks} marks, every one of
              them marked <b>+{MCQ_MARKS.correct} / {MCQ_MARKS.wrong}</b> — the JEE Main pattern,
              end to end. ₹{RUPEES} to enter, once.
            </p>

            <div className="hero__actions">
              <a className="btn-sun btn-sun--big" href="/signup">
                Register for ₹{RUPEES}
                <span className="btn-sun__arrow" aria-hidden="true"><ArrowIcon /></span>
              </a>
              <a className="btn-dusk" href="#try">
                First, try {TASTER_QUESTIONS.length} real questions
              </a>
            </div>

            <Countdown />

            <ul className="hero__facts">
              <li><b className="tnum">₹{RUPEES}</b><span>once, nothing after</span></li>
              <li><b className="tnum">{PAPER.totalCount}</b><span>questions</span></li>
              <li><b className="tnum">3h</b><span>one sitting</span></li>
              <li><b className="tnum">6 days</b><span>to your all-India rank</span></li>
            </ul>
          </div>

          {/* The reward ladder, acted out: climb, stall, and a hand up. */}
          <div className="hero__art">
            <RescueLadder />
          </div>

          <span className="hero__sparkle" aria-hidden="true"><Sparkle /></span>
        </div>
      </section>

      {/* ── 2. The level, felt rather than claimed ──────────────────────── */}
      <section className="band band--dawn" id="try">
        <div className="wrap">
          <Reveal>
            <p className="band__eyebrow">Before you pay a rupee</p>
            <h2 className="band__title">
              Do not take our word for the level. <em>Take five questions.</em>
            </h2>
            <p className="band__lede">
              These are real questions from <b>{TASTER_SOURCE}</b> — a paper that is already
              public — and they are marked here exactly the way our paper is marked:{' '}
              +{MCQ_MARKS.correct} for a correct answer, {MCQ_MARKS.wrong} for a wrong one. Forty
              seconds, no account, no card.
            </p>
          </Reveal>

          <Reveal delay={80}>
            <TryQuestions />
          </Reveal>

          <Reveal delay={120}>
            <p className="band__footnote">
              Two of the five were integer-answer questions in the original paper; we wrote the
              options so you can answer in one tap. Your paper in November is new questions set at
              this level — nobody has seen it, and its answer key never leaves our server, not in
              the page, not in an API response.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── 3. What the top of the list takes home ──────────────────────── */}
      <section className="band band--night">
        <div className="wrap">
          <Reveal className="ladder__head">
            <div>
              <p className="band__eyebrow">The reward ladder</p>
              <h2 className="band__title">What the top of the rank list takes home</h2>
              <p className="band__lede">
                ₹{RUPEES} to sit the paper. Where you land in this test&rsquo;s own rank list
                decides what you walk away with.
              </p>
            </div>
            <div className="ladder__art"><PrizeDevices /></div>
          </Reveal>

          <ul className="ladder">
            {REWARD_BANDS.map((band, index) => (
              <Reveal
                as="li"
                key={band.floor}
                delay={120 + index * 110}
                className={`rung${index === 0 ? ' rung--top' : ''}`}
              >
                <div className="rung__pc tnum">
                  {band.floor}
                  <small>{bandRange(band.floor, index)} percentile</small>
                </div>
                <div className="rung__prize">
                  <strong>{band.label}</strong>
                  <span>{BAND_NOTE[band.floor]}</span>
                </div>
                <div className="rung__share">{band.share}</div>
              </Reveal>
            ))}
          </ul>

          <Reveal delay={460}>
            <div className="ladder__rules">
              <p>
                <b>Your percentile is your position in this test&rsquo;s own list</b> — out of
                everyone who sat the same paper on the same day. It is not a prediction of your
                JEE percentile, and nothing you do after the test changes it.
              </p>
              <ul>
                <li>
                  <b>The bands do not overlap.</b> At 99.2 you are in the first band, and the
                  first band only.
                </li>
                <li>
                  <b>You need a paper that was sat and marked.</b> One we auto-submitted for you
                  still counts; one never started does not.
                </li>
                <li>
                  <b>A person reads anything our checks flag</b> before a reward is confirmed, and
                  we write to you if that is yours. Nothing is ever auto-zeroed.
                </li>
                <li>
                  <b>We publish the full rank list</b>, so every band is checkable against it.
                  Rewards go to the registered student, one per student, not exchangeable for
                  cash.
                </li>
              </ul>
            </div>
          </Reveal>

          <Reveal delay={520}>
            <div className="ladder__cta">
              <a className="btn-sun" href="/signup">
                Register for ₹{RUPEES}
                <span className="btn-sun__arrow" aria-hidden="true"><ArrowIcon /></span>
              </a>
              <p>
                Registration closes <b>the moment the paper opens</b>. There is no late entry, and
                there is no second sitting.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 4. What the paper is ────────────────────────────────────────── */}
      <section className="band band--day">
        <div className="wrap">
          <Reveal>
            <p className="band__eyebrow">The paper</p>
            <h2 className="band__title">{PAPER.totalCount} questions, three hours, one clock</h2>
            <p className="band__lede">
              Physics, chemistry and mathematics, in one sitting — the length and the pressure of
              the real thing, which is the part no chapter test can give you.
            </p>
          </Reveal>

          <div className="halves">
            <Reveal delay={80}>
              <div className="half">
                <span className="half__count tnum">{PAPER.scqPerSubject}</span>
                <h3>single-correct, per subject</h3>
                <p>
                  Four options, one right answer. Marked the way JEE marks them:{' '}
                  +{MCQ_MARKS.correct} for a correct answer, {MCQ_MARKS.wrong} for a wrong one,{' '}
                  {MCQ_MARKS.unattempted} for one you leave alone. The key sits on our server and
                  is applied after the paper closes — never sent to your browser.
                </p>
              </div>
            </Reveal>
            <Reveal delay={180}>
              <div className="half half--written">
                <span className="half__count tnum">{PAPER.integerPerSubject}</span>
                <h3>integer answers, per subject</h3>
                <p>
                  No options to work backwards from: you solve it and type the number. Marked on
                  the same scale as the rest, +{MCQ_MARKS.correct} / {MCQ_MARKS.wrong}, so there
                  is nowhere to guess from. {PAPER.perSubject} questions a subject,{' '}
                  {PAPER.totalCount} in all.
                </p>
              </div>
            </Reveal>
          </div>

          <Reveal delay={240}>
            <ul className="strip">
              <li><b>Same paper</b><span>for every student, same morning</span></li>
              <li><b>Server clock</b><span>your timer is not your laptop&rsquo;s</span></li>
              <li><b>Your marks</b><span>the next morning</span></li>
              <li><b>Final ranks</b><span>the same week</span></li>
            </ul>
          </Reveal>
        </div>
      </section>

      {/* ── 5. The question every student actually asks ─────────────────── */}
      <section className="band band--day band--quiet">
        <div className="wrap">
          <Reveal>
            <p className="band__eyebrow">If something goes wrong</p>
            <h2 className="band__title">Your three hours cannot be taken from you</h2>
            <p className="band__lede">
              This is the fear that stops people registering for an online test, so here is
              exactly what happens, in the order it happens.
            </p>
          </Reveal>

          <div className="cards">
            <Reveal delay={80}>
              <div className="card">
                <h3>Your internet drops</h3>
                <p>
                  <b>Keep working.</b> Every answer is written to your own device as you type and
                  sent to us every {SYNC_SECONDS} seconds. The moment the connection returns,
                  everything you wrote in the meantime goes up.
                </p>
              </div>
            </Reveal>
            <Reveal delay={160}>
              <div className="card">
                <h3>Your laptop dies and never comes back</h3>
                <p>
                  Your paper is still completed and still marked, using everything we had already
                  received. The most a dead machine can cost you is the last{' '}
                  {SYNC_SECONDS} seconds of typing.
                </p>
              </div>
            </Reveal>
            <Reveal delay={240}>
              <div className="card">
                <h3>You cannot press submit</h3>
                <p>
                  Fine. We finalise every unsubmitted paper automatically once the window closes.
                  The submit button is a convenience, not a requirement.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 6. Four steps and the price again ───────────────────────────── */}
      <section className="band band--day">
        <div className="wrap">
          <Reveal>
            <p className="band__eyebrow">How to take part</p>
            <h2 className="band__title">Four steps, and the first one takes two minutes</h2>
          </Reveal>

          <ol className="steps">
            <Reveal as="li" delay={80}>
              <strong>Register and pay ₹{RUPEES}.</strong> Do it well before the day —
              registration closes the moment the paper opens.
            </Reveal>
            <Reveal as="li" delay={160}>
              <strong>Arrive in the waiting room.</strong> It opens {LOBBY_MINUTES} minutes before
              the start and checks that your browser can save and send your answers.
            </Reveal>
            <Reveal as="li" delay={240}>
              <strong>Sit the paper.</strong> It opens by itself when the clock reaches zero, and
              your timer runs on our clock.
            </Reveal>
            <Reveal as="li" delay={320}>
              <strong>Keep your receipt.</strong> You get one when you submit. Quote it if you
              ever need to ask us anything about this test.
            </Reveal>
          </ol>
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
            <p className="finale__price tnum">₹{RUPEES}</p>
            <p className="finale__line">
              One paper. One all-India rank. One shot at the top band — and nothing more to pay,
              ever.
            </p>
            <a className="btn-sun btn-sun--big" href="/signup">
              Register for ₹{RUPEES}
              <span className="btn-sun__arrow" aria-hidden="true"><ArrowIcon /></span>
            </a>
            <p className="finale__small">
              Marks the next morning · final ranks the same week · rewards to the
              top three percentile bands
            </p>
          </Reveal>
        </div>
      </section>
    </main>
  );
}
