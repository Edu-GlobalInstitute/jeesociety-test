'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminErrorMessage, api } from '../../../lib/api';

/**
 * Everyone who sat the paper.
 *
 * Reads as an arrival list before results are launched and as a merit list
 * after, because that is the same list in two moods: the server orders by rank
 * when there is one and by submission time when there is not, so nothing here
 * has to decide.
 *
 * The details are the ones you need when a student telephones: their number,
 * their receipt, when they submitted, and — once published — what they scored.
 */

interface Attempt {
  attemptId: string;
  userId: string;
  name: string | null;
  email: string;
  phone: string | null;
  class: string | null;
  targetYear: number | null;
  city: string | null;
  state: string | null;
  status: string;
  receipt: string | null;
  submittedAt: string | null;
  score: number | null;
  rank: number | null;
  percentile: number | null;
  needsReview: boolean;
}

interface Stats {
  registered: number;
  submitted: number;
  autoSubmitted: number;
  scored: number;
  ranked: number;
  needsReview: number;
}

interface TestRow {
  id: number;
  name: string;
  kind: string;
}

const PAGE = 100;

const STATUS_LABELS: Record<string, string> = {
  registered: 'did not start',
  in_progress: 'did not submit',
  submitted: 'submitted',
  auto_submitted: 'auto-submitted',
};

export default function AttemptsPage() {
  const [tests, setTests] = useState<TestRow[]>([]);
  const [testId, setTestId] = useState<number | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ tests: TestRow[] }>('/admin/tests')
      .then((next) => {
        setTests(next.tests);
        const scholarship = next.tests.find((test) => test.kind === 'scholarship');
        setTestId(scholarship?.id ?? next.tests[0]?.id ?? null);
      })
      .catch((caught) => setError(adminErrorMessage(caught, 'the test list')));
  }, []);

  const load = useCallback(
    (nextOffset: number) => {
      if (testId === null) return;
      setBusy(true);
      const params = new URLSearchParams({
        limit: String(PAGE),
        offset: String(nextOffset),
      });
      if (search.trim()) params.set('search', search.trim());

      api<{ attempts: Attempt[]; stats: Stats }>(`/admin/attempts/${testId}?${params}`)
        .then((next) => {
          setAttempts(next.attempts);
          setStats(next.stats);
          setOffset(nextOffset);
          setError(null);
        })
        .catch((caught) => setError(adminErrorMessage(caught, 'the attempt list')))
        .finally(() => setBusy(false));
    },
    [testId, search],
  );

  // Debounced: this fires on every keystroke and each one is a scan over the
  // cohort.
  useEffect(() => {
    const timer = setTimeout(() => load(0), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const sat = stats ? stats.submitted + stats.autoSubmitted : 0;
  const released = useMemo(() => attempts.some((row) => row.rank !== null), [attempts]);

  function exportCsv() {
    const header = [
      'rank', 'name', 'phone', 'email', 'class', 'target_year', 'city', 'state',
      'status', 'receipt', 'submitted_at', 'score', 'percentile',
    ];
    const rows = attempts.map((row) =>
      [
        row.rank ?? '', row.name ?? '', row.phone ?? '', row.email, row.class ?? '',
        row.targetYear ?? '', row.city ?? '', row.state ?? '', row.status,
        row.receipt ?? '', row.submittedAt ?? '', row.score ?? '', row.percentile ?? '',
      ]
        .map((cell) => {
          const text = String(cell);
          return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    );

    // Built in the browser rather than fetched: this is the page already on
    // screen, so a round trip would only risk showing something different from
    // what was exported.
    const blob = new Blob([[header.join(','), ...rows].join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `attempts-${testId}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="ap">
      <div className="ap__head">
        <div>
          <h1>Attempts</h1>
          <p className="ap__sub">
            {sat.toLocaleString('en-IN')} student{sat === 1 ? '' : 's'} sat this paper
            {released ? ' · ordered by rank' : ' · newest first'}
          </p>
        </div>
        <div className="row">
          {tests.length > 1 ? (
            <select
              className="sel sel--sm"
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
          <button type="button" className="btn" disabled={attempts.length === 0} onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      {error ? <p className="msg msg--bad">{error}</p> : null}

      {stats ? (
        <div className="grid grid--kpi" style={{ marginBottom: 14 }}>
          <Tile label="Sat the paper" value={sat} />
          <Tile label="Auto-submitted" value={stats.autoSubmitted} />
          <Tile label="Scored" value={stats.scored} of={sat} />
          <Tile label="Flagged" value={stats.needsReview} />
        </div>
      ) : null}

      <div className="card" style={{ marginBottom: 14 }}>
        <input
          className="inp inp--sm"
          placeholder="Name, phone, email or receipt…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="tablewrap">
        <table className="t">
          <thead>
            <tr>
              {released ? <th style={{ width: 70 }}>Rank</th> : null}
              <th>Student</th>
              <th>Phone</th>
              <th>Class</th>
              <th>Status</th>
              <th>Submitted</th>
              <th>Receipt</th>
              {released ? <th style={{ textAlign: 'right' }}>Score</th> : null}
              {released ? <th style={{ textAlign: 'right' }}>%ile</th> : null}
            </tr>
          </thead>
          <tbody>
            {attempts.length === 0 && !busy ? (
              <tr>
                <td colSpan={released ? 9 : 7}>
                  <p className="empty">
                    {search ? 'Nobody matches that search.' : 'Nobody has sat this paper yet.'}
                  </p>
                </td>
              </tr>
            ) : null}
            {attempts.map((row) => (
              <tr key={row.attemptId}>
                {released ? (
                  <td className="tnum nowrap" style={{ fontWeight: 700 }}>
                    {row.rank ?? '—'}
                  </td>
                ) : null}
                <td>
                  <strong>{row.name ?? '(no name)'}</strong>
                  <div className="muted-cell" style={{ fontSize: '0.76rem' }}>
                    {row.email}
                    {row.city ? ` · ${row.city}` : ''}
                  </div>
                </td>
                <td className="nowrap tnum">
                  {row.phone ? <a href={`tel:+91${row.phone}`}>{row.phone}</a> : '—'}
                </td>
                <td className="nowrap">
                  {row.class === 'dropper' ? 'Dropper' : row.class ? `Class ${row.class}` : '—'}
                </td>
                <td className="nowrap">
                  <span
                    className={
                      row.status === 'submitted' || row.status === 'auto_submitted'
                        ? 'chip chip--paid'
                        : 'chip chip--warn'
                    }
                  >
                    {STATUS_LABELS[row.status] ?? row.status}
                  </span>
                  {row.needsReview ? (
                    <span className="chip chip--bad" style={{ marginLeft: 4 }}>
                      flagged
                    </span>
                  ) : null}
                </td>
                <td className="nowrap muted-cell tnum">
                  {row.submittedAt
                    ? new Date(row.submittedAt).toLocaleString('en-IN', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })
                    : '—'}
                </td>
                <td className="nowrap tnum muted-cell" style={{ fontSize: '0.78rem' }}>
                  {row.receipt ?? '—'}
                </td>
                {released ? (
                  <td className="tnum nowrap" style={{ textAlign: 'right', fontWeight: 700 }}>
                    {row.score ?? '—'}
                  </td>
                ) : null}
                {released ? (
                  <td className="tnum nowrap muted-cell" style={{ textAlign: 'right' }}>
                    {row.percentile === null ? '—' : row.percentile.toFixed(2)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {attempts.length === PAGE || offset > 0 ? (
        <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
          <button
            type="button"
            className="btn"
            disabled={offset === 0 || busy}
            onClick={() => load(Math.max(0, offset - PAGE))}
          >
            ← Previous
          </button>
          <span className="muted-cell tnum">
            {offset + 1}–{offset + attempts.length}
          </span>
          <button
            type="button"
            className="btn"
            disabled={attempts.length < PAGE || busy}
            onClick={() => load(offset + PAGE)}
          >
            Next →
          </button>
        </div>
      ) : null}
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
