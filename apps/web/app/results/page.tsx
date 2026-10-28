'use client';

import { useEffect, useState } from 'react';
import { PAPER } from '@jee/shared/config';
import { api } from '../../lib/api';

interface Result {
  receipt: string | null;
  status: string;
  submittedAt: string | null;
  scores: { mcq: number | null; total: number | null };
}

/**
 * Results. Written for a student refreshing this page the morning after, so it
 * says exactly which part is ready and when the rest arrives rather than
 * showing an empty state.
 */
export default function Results() {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ receipt: string | null; status: string; submittedAt: string | null }>('/attempt/state')
      .then((state) =>
        setResult({
          receipt: state.receipt,
          status: state.status,
          submittedAt: state.submittedAt,
          scores: { mcq: null, total: null },
        }),
      )
      .catch(() => setError('Sign in to see your result.'));
  }, []);

  return (
    <main className="wrap" style={{ paddingTop: 48, paddingBottom: 64 }}>
      <h1 style={{ fontSize: '1.8rem', margin: '0 0 8px' }}>Your result</h1>

      {error ? (
        <div className="notice">
          {error} <a href="/login">Sign in</a>
        </div>
      ) : null}

      {result ? (
        <>
          <section className="panel">
            <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Your test</h2>
            <p className="prose" style={{ marginBottom: 0 }}>
              {result.submittedAt
                ? `Submitted ${new Date(result.submittedAt).toLocaleString()}.`
                : 'Not submitted yet.'}
              {result.receipt ? ` Receipt ${result.receipt}.` : ''}
            </p>
          </section>

          <section className="panel">
            <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Marks</h2>
            <p className="prose" style={{ marginBottom: 0 }}>
              {result.scores.total === null
                ? 'Every question on this paper is machine-marked, so marks are published the '
                  + 'morning after the test and your all-India rank follows the same week.'
                : `${result.scores.total} marks out of ${PAPER.maxMarks}.`}
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}
