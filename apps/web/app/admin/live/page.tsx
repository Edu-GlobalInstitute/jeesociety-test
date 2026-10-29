'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

/**
 * The during-test dashboard, the live event console.
 *
 * Moved here from /admin when the business dashboard took that path. The two
 * are read on completely different schedules: this one matters for three hours
 * on one morning, and /admin is opened every day.
 *
 * One number on this page matters more than the rest: **stale syncs**. It
 * answers "is sync working across the whole cohort" with a count rather than a
 * guess, and it is the signal that something is wrong while there is still time
 * to act on it.
 */

interface Dashboard {
  testId: number;
  test: { name: string; status: string; paperPublished: boolean } | null;
  stats: {
    registered: number;
    inProgress: number;
    submitted: number;
    autoSubmitted: number;
    syncsLastMinute: number;
    syncsLast5Minutes: number;
    staleOver4Minutes: number;
    flagged: number;
  };
  jobs: { job: string; status: string; run_after: string; error: string | null }[];
  serverTime: number;
}

const JOBS = ['auto_submit', 'mcq_score', 'compute_flags'];

export default function AdminDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () =>
    api<Dashboard>('/admin/dashboard')
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch(() => setError('Admin access is required.'));

  useEffect(() => {
    void load();
    // Ten seconds: frequent enough to watch a cohort, infrequent enough that
    // the dashboard itself is not load during the event.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * The go-live switch. A typed reason is required because it is written to
   * admin_audit, and the confirmation names the consequence rather than asking
   * "are you sure" — this is the control that decides whether 10,000 students
   * can get in.
   */
  async function setTestStatus(next: 'scheduled' | 'live') {
    setMessage(null);
    const reason = window.prompt(
      next === 'live'
        ? 'Going live opens the lobby, the paper key and sync for every paid student. Why?'
        : 'Locking puts every student back on the coming-soon screen. Why?',
    );
    if (!reason || reason.trim().length < 3) {
      setMessage('A reason of at least three characters is required. Nothing was changed.');
      return;
    }
    try {
      await api('/admin/test-status', {
        method: 'POST',
        body: JSON.stringify({ status: next, reason: reason.trim() }),
      });
      setMessage(next === 'live' ? 'The test is live.' : 'The test is locked.');
      void load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not change the status.');
    }
  }

  async function runJob(job: string) {
    setMessage(null);
    try {
      await api('/admin/run-job', { method: 'POST', body: JSON.stringify({ job }) });
      setMessage(`${job} is queued. The worker picks it up within a few seconds.`);
      void load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not queue that job.');
    }
  }

  if (error) {
    return (
      <main className="wrap" style={{ paddingTop: 48 }}>
        <div className="notice">{error}</div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="wrap" style={{ paddingTop: 48 }}>
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const { stats } = data;
  // Shown as a share, because 40 stale out of 60 sitting is a crisis and 40 out
  // of 9,000 is a normal afternoon.
  const stalePercent = stats.inProgress
    ? Math.round((stats.staleOver4Minutes / stats.inProgress) * 100)
    : 0;

  return (
    <main className="wrap" style={{ paddingTop: 40, paddingBottom: 64 }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 4px' }}>Test {data.testId}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Updated {new Date(data.serverTime).toLocaleTimeString()} · refreshes every 10 seconds ·{' '}
        <a href="/admin/review">review queue ({stats.flagged})</a>
      </p>

      {message ? (
        <p className="muted" style={{ marginTop: 0 }}>
          {message}
        </p>
      ) : null}

      {stats.inProgress > 0 && stalePercent >= 1 ? (
        <div className="notice">
          {stats.staleOver4Minutes} of {stats.inProgress} students in progress ({stalePercent}%)
          have not synced in over four minutes. Check the API error rate and database
          connections before changing anything.
        </div>
      ) : null}

      <div className="spec" style={{ marginBottom: 16 }}>
        <div className="spec__cell">
          <span className="spec__value tnum">{stats.inProgress}</span>
          <span className="spec__label">in progress</span>
        </div>
        <div className="spec__cell">
          <span className="spec__value tnum">{stats.staleOver4Minutes}</span>
          <span className="spec__label">stale over 4 min</span>
        </div>
        <div className="spec__cell">
          <span className="spec__value tnum">{stats.syncsLastMinute}</span>
          <span className="spec__label">syncs last minute</span>
        </div>
        <div className="spec__cell">
          <span className="spec__value tnum">{stats.submitted + stats.autoSubmitted}</span>
          <span className="spec__label">submitted</span>
        </div>
      </div>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Access</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {data.test?.status === 'live'
            ? 'The test is live. Paid students can enter the lobby, open the paper and sync.'
            : data.test?.status === 'scheduled'
              ? 'The test is on sale and locked. Registration and payment work; every student '
                + 'sees the coming-soon screen instead of a lobby.'
              : `The test is ${data.test?.status ?? 'unknown'}. The worker owns this status; it `
                + 'cannot be switched from here.'}
        </p>
        {data.test?.status === 'scheduled' && !data.test.paperPublished ? (
          <div className="notice">
            No paper is published for this test, so it cannot go live. Upload it with
            tools/build-paper first.
          </div>
        ) : null}
        {data.test?.status === 'scheduled' ? (
          <button
            className="btn"
            disabled={!data.test.paperPublished}
            onClick={() => void setTestStatus('live')}
          >
            Go live
          </button>
        ) : data.test?.status === 'live' ? (
          <button className="btn btn--ghost" onClick={() => void setTestStatus('scheduled')}>
            Lock the test again
          </button>
        ) : null}
      </section>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Cohort</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <tbody>
            {[
              ['Registered', stats.registered],
              ['In progress', stats.inProgress],
              ['Submitted by the student', stats.submitted],
              ['Finalised automatically', stats.autoSubmitted],
              ['Synced in the last 5 minutes', stats.syncsLast5Minutes],
              ['Flagged for review', stats.flagged],
            ].map(([label, value]) => (
              <tr key={label as string} style={{ borderBottom: '1px solid var(--rule)' }}>
                <td style={{ padding: '7px 0' }}>{label}</td>
                <td className="tnum" style={{ textAlign: 'right' }}>
                  {value as number}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Jobs</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Queuing a job writes a row. The worker claims it on its next poll — nothing runs
          inside this request.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <tbody>
            {JOBS.map((job) => {
              const run = data.jobs.find((candidate) => candidate.job === job);
              return (
                <tr key={job} style={{ borderBottom: '1px solid var(--rule)' }}>
                  <td style={{ padding: '8px 0' }}>{job.replace(/_/g, ' ')}</td>
                  <td className="muted">{run?.status ?? 'not scheduled'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn--ghost" onClick={() => void runJob(job)}>
                      Queue
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </main>
  );
}
