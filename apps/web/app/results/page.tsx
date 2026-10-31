import type { Metadata } from 'next';
import { MENTORSHIP } from '@jee/shared/config';
import './results.css';
import { ArrowIcon, Seal } from '../../components/PosterMarks';
import { ResultWall } from '../../components/ResultWall';

/**
 * Results.
 *
 * Written for a seventeen-year-old who has not registered and wants to know
 * whether anyone here has actually done this — so the page is a wall of result
 * slips, four students who sat the real exam, each one a video they can press
 * play on with the score underneath, and one invitation at the foot.
 */

export const metadata: Metadata = {
  title: 'Results — four students, four scorecards, in their own words',
  description:
    'JEE Main scorecards you can press play on: Prahalad at 99.66 percentile, Shubh and '
    + 'Sanskar at 99.5, and Krish from a full syllabus of backlog to IIT Roorkee. '
    + 'Honest conversations about the backlogs, the bad mocks and the comebacks.',
};

export default function Results() {
  return (
    <main className="results">
      {/* ── The wall, and what it is ──────────────────────────────────── */}
      <section className="rhero">
        <div className="wrap rhero__inner">
          <p className="rhero__eyebrow">Straight from the other side</p>

          <h1 className="rhero__title">
            <span className="rhero__line">Students who trust</span>
            <span className="rhero__line rhero__line--lit">JEEsociety.</span>
          </h1>
        </div>
      </section>

      <div className="wrap">
        <ResultWall />
      </div>

      {/* ── The one thing to do after watching ────────────────────────── */}
      <section className="rfinale">
        <span className="rfinale__seal" aria-hidden="true"><Seal /></span>
        <div className="wrap rfinale__inner">
          <p className="rfinale__kicker">Every one of them started at a mock test</p>
          <h2 className="rfinale__title">Put your own name on this wall</h2>
          <p className="rfinale__line">
            One full-length paper, sat on the same morning across India. Finish in the
            top 1% and {MENTORSHIP.months} months of mentorship from{' '}
            {MENTORSHIP.mentors} is yours.
          </p>
          <a className="rfinale__cta" href="/signup">
            Register for the test
            <span className="rfinale__arrow" aria-hidden="true"><ArrowIcon /></span>
          </a>
        </div>
      </section>
    </main>
  );
}
