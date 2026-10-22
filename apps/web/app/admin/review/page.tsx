'use client';

import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';

/**
 * The review queue, severity-ordered. Expect 300-500 rows at 10,000 students;
 * read in this order, that is reviewable inside the grading window.
 */

interface QueueRow {
  attemptId: string;
  email: string;
  status: string;
  receipt: string | null;
  flags: { code: string; questionId: string | null }[];
  flagCount: number;
  severity: number;
  totalScore: number | null;
}

const FLAG_LABEL: Record<string, string> = {
  burst_appearance: 'appeared in one sync',
  low_keystroke_ratio: 'few keystrokes for its length',
  ip_change: 'address changed',
  grader_low_confidence: 'grader unsure',
  off_topic_or_blank: 'off topic or blank',
};

export default function ReviewQueue() {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ attempts: QueueRow[] }>('/admin/review-queue')
      .then((data) => setRows(data.attempts))
      .catch(() => setError('Admin access is required.'));
  }, []);

  if (error) {
    return (
      <main className="wrap" style={{ paddingTop: 48 }}>
        <div className="notice">{error}</div>
      </main>
    );
  }

  return (
    <main className="wrap" style={{ paddingTop: 40, paddingBottom: 64 }}>
      <h1 style={{ fontSize: '1.5rem', margin: '0 0 4px' }}>Review queue</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Strongest evidence first. A flag is a reason to look, never a finding —{' '}
        <a href="/admin">back to the dashboard</a>
      </p>

      {rows && rows.length === 0 ? (
        <section className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Nothing is flagged. Run the flag job after the test if you expected otherwise.
          </p>
        </section>
      ) : null}

      {rows?.map((row) => (
        <section className="panel" key={row.attemptId}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <strong>{row.email}</strong>
              <div className="muted">
                {row.receipt ?? 'no receipt'} · {row.status.replace(/_/g, ' ')}
                {row.totalScore === null ? '' : ` · ${row.totalScore} marks`}
              </div>
            </div>
            <a className="btn btn--ghost" href={`/admin/review/attempt?id=${row.attemptId}`}>
              Open
            </a>
          </div>
          <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: '0.9rem' }}>
            {row.flags.map((flag, index) => (
              <li key={`${flag.code}-${index}`}>
                {FLAG_LABEL[flag.code] ?? flag.code}
                {flag.questionId ? ` — ${flag.questionId}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
