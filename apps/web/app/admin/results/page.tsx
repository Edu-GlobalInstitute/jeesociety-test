'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminErrorMessage, api } from '../../../lib/api';

/**
 * Results: score the cohort, then launch.
 *
 * Two buttons, deliberately in that order and deliberately separate. Scoring is
 * repeatable and invisible to students; launching is the announcement. Putting
 * them on one button would mean the only way to score is to publish.
 *
 * The screen shows what is standing in the way rather than only refusing when
 * the button is pressed — a release blocked by four unscored attempts is
 * something to fix, and the fix is on this page.
 */

interface Stats {
  registered: number;
  submitted: number;
  autoSubmitted: number;
  scored: number;
  ranked: number;
  needsReview: number;
}

interface Status {
  testId: number;
  testName: string;
  testStatus: string;
  released: boolean;
  releasedAt: string | null;
  stats: Stats;
  unscored: number;
  blockers: string[];
}

interface TestRow {
  id: number;
  name: string;
  kind: string;
  status: string;
  startsAt: string;
}

export default function ResultsPage() {
  const [tests, setTests] = useState<TestRow[]>([]);
  const [testId, setTestId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ tests: TestRow[] }>('/admin/tests')
      .then((next) => {
        setTests(next.tests);
        // The scholarship test is the one results are launched for; default to
        // it rather than making someone choose on every visit.
        const scholarship = next.tests.find((test) => test.kind === 'scholarship');
        setTestId(scholarship?.id ?? next.tests[0]?.id ?? null);
      })
      .catch((caught) => setError(adminErrorMessage(caught, 'the test list')));
  }, []);

  const load = useCallback(() => {
    if (testId === null) return;
    api<Status>(`/admin/results/${testId}/status`)
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((caught) => setError(adminErrorMessage(caught, 'the results status')));
  }, [testId]);

  useEffect(load, [load]);

  async function score() {
    if (testId === null) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/admin/results/${testId}/score`, { method: 'POST', body: '{}' });
      setMessage(
        'Scoring has been queued. It runs in the worker and may take a few minutes for a '
        + 'large cohort — this page updates as attempts are scored.',
      );
      load();
    } catch (caught) {
      setError(adminErrorMessage(caught, 'scoring'));
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    if (testId === null || !status) return;
    const sat = status.stats.submitted + status.stats.autoSubmitted;
    if (
      !window.confirm(
        `Publish results to all ${sat} students who sat ${status.testName}?\n\n`
        + 'Every one of them will be able to see their marks, rank and percentile '
        + 'immediately. You can withdraw them again, but students who have already '
        + 'looked will have seen them.',
      )
    ) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ ranked: number; topScore: number | null }>(
        `/admin/results/${testId}/release`,
        { method: 'POST', body: JSON.stringify({ reason: 'launched from the results screen' }) },
      );
      setMessage(`Results are live. ${result.ranked} students ranked.`);
      load();
    } catch (caught) {
      setError(adminErrorMessage(caught, 'the release'));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (testId === null) return;
    const reason = window.prompt(
      'Why are these results being withdrawn? Students who have already seen them will '
      + 'have seen them.',
    );
    if (!reason || reason.trim().length < 3) return;

    setBusy(true);
    try {
      await api(`/admin/results/${testId}/withdraw`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setMessage('Results withdrawn. Scores and ranks are kept; students can no longer see them.');
      load();
    } catch (caught) {
      setError(adminErrorMessage(caught, 'the withdrawal'));
    } finally {
      setBusy(false);
    }
  }

  const sat = status ? status.stats.submitted + status.stats.autoSubmitted : 0;

  return (
    <main className="ap">
      <div className="ap__head">
        <div>
          <h1>Results</h1>
          <p className="ap__sub">
            Score the cohort, then launch. Students see nothing until you launch.
          </p>
        </div>
        {tests.length > 1 ? (
          <select
            className="sel"
            style={{ width: 'auto' }}
            value={testId ?? ''}
            onChange={(event) => setTestId(Number(event.target.value))}
          >
            {tests.map((test) => (
              <option key={test.id} value={test.id}>
                {test.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {error ? <p className="msg msg--bad">{error}</p> : null}
      {message ? <p className="msg msg--ok">{message}</p> : null}

      {!status ? (
        <p className="empty">Loading…</p>
      ) : (
        <>
          <div className="grid grid--kpi" style={{ marginBottom: 16 }}>
            <Tile label="Sat the paper" value={sat} />
            <Tile label="Scored" value={status.stats.scored} of={sat} />
            <Tile label="Ranked" value={status.stats.ranked} of={sat} />
            <div className="card">
              <p className="kpi__label">Published</p>
              <div className="kpi__value" style={{ fontSize: '1.3rem' }}>
                {status.released ? 'Live' : 'Held'}
              </div>
              <p className="kpi__foot">
                {status.releasedAt
                  ? new Date(status.releasedAt).toLocaleString('en-IN')
                  : 'Students cannot see any marks'}
              </p>
            </div>
          </div>

          {status.blockers.length > 0 && !status.released ? (
            <div className="msg msg--warn">
              <strong>Before results can be launched:</strong>
              <ul>
                {status.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <section className="card" style={{ marginBottom: 16 }}>
            <h2>1 · Score</h2>
            <p className="ap__sub">
              Marks every submitted paper against the answer key. Students see nothing — this
              only fills in the numbers. Safe to run again: scoring is deterministic, so
              correcting the answer key and re-running gives the whole cohort the same
              treatment.
            </p>
            <div className="row">
              <button type="button" className="btn" disabled={busy} onClick={score}>
                {busy ? 'Working…' : 'Run scoring'}
              </button>
              {status.unscored > 0 ? (
                <span className="ap__sub">
                  {status.unscored} attempt{status.unscored === 1 ? '' : 's'} still unscored.
                </span>
              ) : sat > 0 ? (
                <span className="ap__sub">Every submitted paper is scored.</span>
              ) : null}
            </div>
          </section>

          <section className="card">
            <h2>2 · Launch</h2>
            {status.released ? (
              <>
                <p className="ap__sub">
                  Results went live on{' '}
                  {status.releasedAt
                    ? new Date(status.releasedAt).toLocaleString('en-IN')
                    : 'an unknown date'}
                  . Every student who sat the paper can see their marks, rank and percentile.
                </p>
                <button type="button" className="btn btn--danger" disabled={busy} onClick={withdraw}>
                  Withdraw results
                </button>
              </>
            ) : (
              <>
                <p className="ap__sub">
                  Computes the rank list and makes every scorecard visible at once. Ranks are
                  worked out now rather than during scoring, so the list is final the moment it
                  is published.
                </p>
                <button
                  type="button"
                  className="btn btn--go"
                  disabled={busy || status.blockers.length > 0}
                  onClick={release}
                >
                  {busy ? 'Working…' : 'Launch result'}
                </button>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Tile({ label, value, of }: { label: string; value: number; of?: number }) {
  return (
    <div className="card">
      <p className="kpi__label">{label}</p>
      <div className="kpi__value">
        {value.toLocaleString('en-IN')}
        {of !== undefined && of > 0 ? (
          <span style={{ color: 'var(--admin-faint)', fontSize: '1.1rem' }}> / {of}</span>
        ) : null}
      </div>
    </div>
  );
}
