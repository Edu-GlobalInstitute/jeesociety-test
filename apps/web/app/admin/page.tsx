'use client';

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

/**
 * The during-test dashboard.
 *
 * One number on this page matters more than the rest: **stale syncs**. It
 * answers "is sync working across the whole cohort" with a count rather than a
 * guess, and it is the signal that something is wrong while there is still time
 * to act on it.
 */

interface Dashboard {
  testId: number;
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
  grading: { pending: number; processing: number; done: number; failed: number; total: number };
  jobs: { job: string; status: string; run_after: string; error: string | null }[];
  serverTime: number;
}

const JOBS = ['auto_submit', 'mcq_score', 'enqueue_grading', 'compute_flags', 'finalise_scores'];

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
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Grading</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {data.grading.total === 0
            ? 'Nothing enqueued yet.'
            : `${data.grading.done} of ${data.grading.total} done · ${data.grading.pending} pending · ${data.grading.processing} in flight · ${data.grading.failed} failed`}
        </p>
        {data.grading.failed > 0 ? (
          <div className="notice">
            {data.grading.failed} grading jobs have failed permanently. Each one is a student
            with a missing mark — read them before publishing ranks.
          </div>
        ) : null}
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
        {message ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
