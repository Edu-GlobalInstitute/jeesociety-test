'use client';

import { Suspense, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { GrowthChart, type GrowthPoint } from '../../../../components/GrowthChart';

/**
 * Everything a reviewer needs on one screen: the answer text, the flags with
 * their evidence, the growth curve for the flagged question, and the score.
 *
 * The point of this page is that a decision made here is defensible. When a
 * parent calls to contest a zero, the reviewer can say "this answer went from 0
 * to 800 characters between 11:42 and 11:43" — not "the system thought it
 * looked suspicious."
 */

interface AttemptDetail {
  attemptId: string;
  status: string;
  receipt: string | null;
  answers: Record<string, string>;
  telemetry: Record<string, { keystrokes: number; pastes: number; pastedChars: number }>;
  flags: { code: string; questionId: string | null; evidence: Record<string, unknown>; at: string }[];
  needsReview: boolean;
  scores: { mcq: number | null; subjective: number | null; total: number | null };
  growth: { revision: number; at: string; lengths: Record<string, number> }[];
  grading: {
    questionId: string;
    status: string;
    rawScore: number | null;
    score: number | null;
    confidence: string | null;
    feedback: string | null;
    observation: Record<string, unknown> | null;
  }[];
}

const BURST_THRESHOLD = 400;
const AWARD_CAP = 3;

function AttemptReview() {
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
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

  async function override(questionId: string) {
    if (!attemptId) return;
    const value = Number(overrides[questionId]);
    if (!Number.isFinite(value) || value < 0 || value > AWARD_CAP) {
      setMessage(`A score must be between 0 and ${AWARD_CAP}.`);
      return;
    }
    if (reason.trim().length < 3) {
      setMessage('Write a reason. It is recorded against your name.');
      return;
    }
    try {
      await api('/admin/override-score', {
        method: 'POST',
        body: JSON.stringify({ attemptId, questionId, score: value, reason }),
      });
      setMessage(`${questionId} set to ${value}.`);
      await load(attemptId);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not save that score.');
    }
  }

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

  // The questions worth looking at: anything flagged, plus anything graded.
  const flaggedQuestions = [
    ...new Set(detail.flags.map((flag) => flag.questionId).filter(Boolean)),
  ] as string[];

  const seriesFor = (questionId: string): GrowthPoint[] =>
    detail.growth.map((snapshot) => ({
      revision: snapshot.revision,
      at: snapshot.at,
      length: snapshot.lengths[questionId] ?? 0,
    }));

  return (
    <main className="wrap" style={{ paddingTop: 40, paddingBottom: 64 }}>
      <h1 style={{ fontSize: '1.4rem', margin: '0 0 4px' }}>
        {detail.receipt ?? detail.attemptId.slice(0, 8)}
      </h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {detail.status.replace(/_/g, ' ')} ·{' '}
        {detail.scores.total === null ? 'not scored yet' : `${detail.scores.total} marks`} ·{' '}
        <a href="/admin/review">back to the queue</a>
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
      </section>

      {flaggedQuestions.map((questionId) => {
        const job = detail.grading.find((candidate) => candidate.questionId === questionId);
        const telemetry = detail.telemetry[questionId];
        const answer = detail.answers[questionId] ?? '';

        return (
          <section className="panel" key={questionId}>
            <h2 style={{ fontSize: '1rem', marginTop: 0 }}>{questionId}</h2>

            <GrowthChart
              points={seriesFor(questionId)}
              burstThreshold={BURST_THRESHOLD}
              questionId={questionId}
            />

            <p className="muted" style={{ marginTop: 10 }}>
              {answer.length} characters
              {telemetry
                ? ` · ${telemetry.keystrokes} keystrokes · ${telemetry.pastes} pastes (${telemetry.pastedChars} characters)`
                : ' · no telemetry recorded'}
            </p>

            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.9rem' }}>
                The answer as submitted
              </summary>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'Charter, Georgia, serif',
                  fontSize: '0.95rem',
                  background: 'var(--paper)',
                  padding: 14,
                  borderRadius: 3,
                  marginTop: 10,
                }}
              >
                {answer || '(blank)'}
              </pre>
            </details>

            {job ? (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
                <p className="muted" style={{ marginTop: 0 }}>
                  Graded {job.score ?? '—'} of {AWARD_CAP} (raw {job.rawScore ?? '—'}), confidence{' '}
                  {job.confidence ?? '—'}. {job.feedback}
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <label htmlFor={`score-${questionId}`} style={{ fontSize: '0.85rem' }}>
                    Set score
                  </label>
                  <input
                    id={`score-${questionId}`}
                    type="number"
                    min={0}
                    max={AWARD_CAP}
                    step={1}
                    value={overrides[questionId] ?? ''}
                    onChange={(event) =>
                      setOverrides({ ...overrides, [questionId]: event.target.value })
                    }
                    style={{
                      width: 70,
                      padding: '7px 9px',
                      border: '1px solid var(--rule-strong)',
                      borderRadius: 3,
                      font: 'inherit',
                    }}
                  />
                  <button className="btn btn--ghost" onClick={() => void override(questionId)}>
                    Save
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Your decision</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Recorded against your name, with the before and after score. Write what you concluded
          and why, as you would want it read back to you a year from now.
        </p>
        <div className="field">
          <label htmlFor="reason">Reason</label>
          <input
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reviewed the growth curve; the answer was written across four syncs."
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
