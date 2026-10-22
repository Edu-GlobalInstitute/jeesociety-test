'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

interface Result {
  receipt: string | null;
  status: string;
  submittedAt: string | null;
  scores: { mcq: number | null; subjective: number | null; total: number | null };
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
          scores: { mcq: null, subjective: null, total: null },
        }),
      )
      .catch(() => setError('Sign in to see your result.'));
  }, []);

  return (
    <main className="wrap" style={{ paddingTop: 48, paddingBottom: 64 }}>
      <h1 style={{ fontSize: '1.8rem', margin: '0 0 8px' }}>Your result</h1>

      {error ? (
        <div className="notice">
          {error} <a href="/register">Sign in</a>
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
              {result.scores.mcq === null
                ? 'Objective marks are published the morning after the test. Written answers are '
                  + 'read against the rubric over the following days, and your all-India rank '
                  + 'follows within six days of the test.'
                : `Objective ${result.scores.mcq}, written ${result.scores.subjective ?? '—'}, `
                  + `total ${result.scores.total ?? '—'}.`}
            </p>
          </section>
        </>
      ) : null}
    </main>
  );
}
