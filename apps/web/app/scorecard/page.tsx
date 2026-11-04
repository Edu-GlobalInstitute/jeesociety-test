'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ApiError, api } from '../../lib/api';
import '../auth.css';
import './scorecard.css';

/**
 * The student's scorecard.
 *
 * Two states, and the first matters as much as the second. Before results are
 * launched this is a receipt: submitted, when, and that marks are coming. It
 * shows no score, no answer key and no count of correct answers, because
 * results are announced for everyone at once and anything a mark can be
 * inferred from is an early release by another name.
 *
 * After the launch it is the scorecard a student expects from a national test:
 * subject by subject, then the total, the rank and the percentile.
 */

interface SubjectRow {
  correct: number;
  wrong: number;
  unattempted: number;
  marks: number;
}

interface Scorecard {
  testId: number;
  testName: string;
  status: string;
  receipt: string | null;
  submittedAt: string | null;
  submitted: boolean;
  released: boolean;
  message?: string;
  releasedAt?: string | null;
  score?: number | null;
  rank?: number | null;
  percentile?: number | null;
  cohortSize?: number;
  subjects?: Record<string, SubjectRow>;
  rewardBand?: { label: string; share: string } | null;
}

function Card() {
  const params = useSearchParams();
  const [data, setData] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const testId = params.get('testId');
    if (!testId) {
      setError('No test was named in the link.');
      return;
    }
    api<Scorecard>(`/results/${testId}`)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((caught) => {
        if (caught instanceof ApiError && caught.status === 401) {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
          return;
        }
        setError(
          caught instanceof ApiError && caught.status === 404
            ? 'We have no record of you sitting this test.'
            : caught instanceof Error
              ? caught.message
              : 'Could not load your result.',
        );
      });
  }, [params]);

  if (error) {
    return (
      <main className="auth">
        <div className="auth__card">
          <p className="msg msg--bad">{error}</p>
          <p className="auth__alt">
            <a href="/register">Back to your registration</a>
          </p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="auth">
        <div className="auth__card">
          <p className="auth__sub">Loading…</p>
        </div>
      </main>
    );
  }

  /* ── Before the launch: a receipt, and nothing to infer a score from ──── */
  if (!data.released) {
    return (
      <main className="auth">
        <div className="auth__card">
          <p className="auth__eyebrow">{data.testName}</p>
          <h1 className="auth__title">
            {data.submitted ? 'Your paper is submitted' : 'No paper submitted'}
          </h1>
          <p className="auth__sub">{data.message}</p>

          {data.submitted ? (
            <dl className="sc__receipt">
              <dt>Receipt</dt>
              <dd className="tnum">{data.receipt ?? '—'}</dd>
              <dt>Submitted</dt>
              <dd className="tnum">
                {data.submittedAt
                  ? new Date(data.submittedAt).toLocaleString('en-IN', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })
                  : '—'}
              </dd>
            </dl>
          ) : null}

          <p className="auth__fine">
            Keep your receipt number. Quote it if you write to us about this paper.
          </p>
        </div>
      </main>
    );
  }

  /* ── After the launch: the scorecard ──────────────────────────────────── */
  const subjects = Object.entries(data.subjects ?? {});
  const totals = subjects.reduce(
    (sum, [, row]) => ({
      correct: sum.correct + row.correct,
      wrong: sum.wrong + row.wrong,
      unattempted: sum.unattempted + row.unattempted,
    }),
    { correct: 0, wrong: 0, unattempted: 0 },
  );

  return (
    <main className="sc">
      <div className="sc__sheet">
        <header className="sc__head">
          <p className="sc__eyebrow">{data.testName}</p>
          <h1 className="sc__title">Scorecard</h1>
          <p className="sc__receipt-line">
            Receipt <span className="tnum">{data.receipt ?? '—'}</span>
          </p>
        </header>

        {/* The two numbers a student looks for first. */}
        <div className="sc__headline">
          <div className="sc__big">
            <span className="sc__big-label">All India Rank</span>
            <span className="sc__big-value tnum">
              {data.rank?.toLocaleString('en-IN') ?? '—'}
              {data.cohortSize ? (
                <span className="sc__big-of"> / {data.cohortSize.toLocaleString('en-IN')}</span>
              ) : null}
            </span>
          </div>
          <div className="sc__big">
            <span className="sc__big-label">Percentile</span>
            <span className="sc__big-value tnum">
              {data.percentile === null || data.percentile === undefined
                ? '—'
                : data.percentile.toFixed(2)}
            </span>
          </div>
        </div>

        <table className="sc__table">
          <thead>
            <tr>
              <th>Subject</th>
              <th className="sc__num">Correct</th>
              <th className="sc__num">Wrong</th>
              <th className="sc__num">Unattempted</th>
              <th className="sc__num">Marks</th>
            </tr>
          </thead>
          <tbody>
            {subjects.map(([subject, row]) => (
              <tr key={subject}>
                <td className="sc__subject">{subject}</td>
                <td className="sc__num tnum">{row.correct}</td>
                <td className="sc__num tnum">{row.wrong}</td>
                <td className="sc__num tnum">{row.unattempted}</td>
                <td className="sc__num tnum sc__marks">{row.marks}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="sc__subject">Total</td>
              <td className="sc__num tnum">{totals.correct}</td>
              <td className="sc__num tnum">{totals.wrong}</td>
              <td className="sc__num tnum">{totals.unattempted}</td>
              <td className="sc__num tnum sc__total">{data.score ?? '—'}</td>
            </tr>
          </tfoot>
        </table>

        {data.rewardBand ? (
          <div className="sc__band">
            <strong>{data.rewardBand.label}</strong>
            <span> — you finished in {data.rewardBand.share}.</span>
          </div>
        ) : null}

        <p className="sc__fine">
          Marking: +4 for a correct answer, −1 for a wrong one, 0 for an unattempted one.
          Percentile is the share of students who scored below you.
        </p>
      </div>
    </main>
  );
}

export default function ScorecardPage() {
  return (
    <Suspense fallback={null}>
      <Card />
    </Suspense>
  );
}
