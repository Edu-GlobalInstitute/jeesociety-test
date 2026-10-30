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
 * The registered student's own result, at the foot of the result wall.
 *
 * Written for a student refreshing this page the morning after, so it says
 * exactly which part is ready and when the rest arrives rather than showing an
 * empty state. A visitor who is not signed in is the common case on this page
 * — most people arriving here came for the wall above — so the sign-in line is
 * an invitation rather than the error it used to be.
 */
export function YourResult() {
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
      .catch(() => setError('Sign in to see your own result.'));
  }, []);

  return (
    <section className="mine">
      <h2 className="mine__head">Your own result</h2>

      {error ? (
        <p className="mine__line">
          {error} <a href="/login">Sign in</a>
        </p>
      ) : null}

      {result ? (
        <>
          <p className="mine__line">
            {result.submittedAt
              ? `Submitted ${new Date(result.submittedAt).toLocaleString()}.`
              : 'Not submitted yet.'}
            {result.receipt ? ` Receipt ${result.receipt}.` : ''}
          </p>
          <p className="mine__line">
            {result.scores.total === null
              ? 'Every question on this paper is machine-marked, so marks are published the '
                + 'morning after the test and your all-India rank follows the same week.'
              : `${result.scores.total} marks out of ${PAPER.maxMarks}.`}
          </p>
        </>
      ) : null}
    </section>
  );
}
