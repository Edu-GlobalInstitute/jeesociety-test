'use client';

import { Suspense, useEffect, useState } from 'react';
import { PAPER } from '@jee/shared/config';
import { api } from '../../../../lib/api';
import { ProgressChart, type ProgressPoint } from '../../../../components/ProgressChart';

/**
 * Everything a reviewer needs on one screen: the flags with their evidence, how
 * the attempt filled in across its syncs, and the answers as submitted.
 *
 * The point of this page is that a decision made here is defensible. When a
 * parent calls, the reviewer can say "the server held 4 answers at 09:12 and 71
 * at 11:58, from two addresses" — not "the system thought it looked
 * suspicious."
 *
 * There is no score to change here. On an all-objective paper a disputed mark
 * is a wrong entry in the answer key, which is fixed once for the whole cohort
 * by correcting the key and re-running `mcq_score` from the dashboard — not
 * student by student.
 */

interface AttemptDetail {
  attemptId: string;
  status: string;
  receipt: string | null;
  answers: Record<string, string>;
  flags: { code: string; questionId: string | null; evidence: Record<string, unknown>; at: string }[];
  needsReview: boolean;
  scores: { mcq: number | null; total: number | null };
  growth: { revision: number; at: string; lengths: Record<string, number> }[];
}

/**
 * More than this many answers appearing between two syncs is highlighted. The
 * client syncs every 90 seconds, so this is roughly a question every six
 * seconds sustained across the interval — quick, but not impossible for someone
 * transcribing from paper at the end, which is why it is highlighted and not
 * called a finding.
 */
const JUMP_THRESHOLD = 15;

function AttemptReview() {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAttemptId(new URLSearchParams(window.location.search).get('id'));
  }, []);

  const load = (id: string) =>
    api<AttemptDetail>(`/admin/attempt/${id}`)
      .then(setDetail)
      .catch(() => setError('Could not load that attempt.'));

  useEffect(() => {
    if (attemptId) void load(attemptId);
  }, [attemptId]);

  async function resolve() {
    if (!attemptId) return;
    if (reason.trim().length < 3) {
      setMessage('Write a reason before closing this review.');
      return;
    }
    await api('/admin/resolve-review', {
      method: 'POST',
      body: JSON.stringify({ attemptId, reason }),
    });
    setMessage('Marked as reviewed.');
    await load(attemptId);
  }

  if (error) {
    return (
      <main className="wrap" style={{ paddingTop: 48 }}>
        <div className="notice">{error}</div>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="wrap" style={{ paddingTop: 48 }}>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  // A recorded answer is one with a non-blank value. The snapshot stores
  // lengths, so a length above zero is exactly that.
  const points: ProgressPoint[] = detail.growth.map((snapshot) => ({
    revision: snapshot.revision,
    at: snapshot.at,
    answered: Object.values(snapshot.lengths).filter((length) => length > 0).length,
  }));

  const answered = Object.entries(detail.answers)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

  return (
    <main className="wrap" style={{ paddingTop: 40, paddingBottom: 64 }}>
      <h1 style={{ fontSize: '1.4rem', margin: '0 0 4px' }}>
        {detail.receipt ?? detail.attemptId.slice(0, 8)}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {detail.status.replace(/_/g, ' ')} ·{' '}
        {detail.scores.total === null
          ? 'not scored yet'
          : `${detail.scores.total} of ${PAPER.maxMarks} marks`}{' '}
        · <a href="/admin/review">back to the queue</a>
      </p>

      {message ? <div className="notice">{message}</div> : null}

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>What was flagged</h2>
        {detail.flags.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.9rem' }}>
            {detail.flags.map((flag, index) => (
              <li key={index} style={{ marginBottom: 6 }}>
                <strong>{flag.code.replace(/_/g, ' ')}</strong>
                {flag.questionId ? ` on ${flag.questionId}` : ''} —{' '}
                <span className="muted">
                  {Object.entries(flag.evidence)
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(', ')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ marginBottom: 0, marginTop: 10 }}>
          A change of address mid-attempt is the only signal this paper produces, and mobile
          networks produce it constantly. On its own it is not evidence of anything.
        </p>
      </section>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>How it filled in</h2>
        <ProgressChart
          points={points}
          jumpThreshold={JUMP_THRESHOLD}
          totalQuestions={PAPER.totalCount}
        />
      </section>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>
          Answers as submitted ({answered.length} of {PAPER.totalCount})
        </h2>
        {answered.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing was recorded for this attempt.</p>
        ) : (
          <ul
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))',
              gap: 6,
              margin: 0,
              padding: 0,
              listStyle: 'none',
              fontSize: '0.85rem',
            }}
          >
            {answered.map(([questionId, value]) => (
              <li
                key={questionId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 6,
                  padding: '5px 8px',
                  background: 'var(--paper)',
                  borderRadius: 3,
                }}
              >
                <span className="muted">{questionId}</span>
                <b className="tnum">{value}</b>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Your decision</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Recorded against your name. Write what you concluded and why, as you would want it read
          back to you a year from now.
        </p>
        <div className="field">
          <label htmlFor="reason">Reason</label>
          <input
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Answers appeared steadily across the whole window; the second address is a mobile network."
          />
        </div>
        <button className="btn" onClick={() => void resolve()} disabled={!detail.needsReview}>
          {detail.needsReview ? 'Mark as reviewed' : 'Already reviewed'}
        </button>
      </section>
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AttemptReview />
    </Suspense>
  );
}
