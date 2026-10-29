'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';

/**
 * The test designer: the list of tests, and the button that creates one.
 *
 * Editing a paper happens at /admin/designer/[testId], which is a separate
 * screen because it is a different job — this one is "which test", that one is
 * "what is in it".
 */

interface TestRow {
  id: number;
  name: string;
  kind: string;
  requiresPayment: boolean;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
  lobbyOpensAt: string;
  paperPublished: boolean;
  status: string;
  bank: {
    total: number;
    complete: number;
    bySubject: { subject: string; scq: number; integer: number; incomplete: number }[];
  };
}

interface Shape {
  subjects: readonly string[];
  scqPerSubject: number;
  integerPerSubject: number;
  totalCount: number;
  maxMarks: number;
}

export default function DesignerPage() {
  const [tests, setTests] = useState<TestRow[]>([]);
  const [shape, setShape] = useState<Shape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api<{ tests: TestRow[]; paperShape: Shape }>('/admin/tests')
      .then((next) => {
        setTests(next.tests);
        setShape(next.paperShape);
        setError(null);
      })
      .catch(() => setError('Could not load tests. Admin access is required.'));
  }, []);

  useEffect(load, [load]);

  return (
    <main className="ap">
      <div className="ap__head">
        <div>
          <h1>Test designer</h1>
          <p className="ap__sub">
            Mock tests are free and open to every signed-in student. The scholarship test is the
            paid one.
          </p>
        </div>
        <button type="button" className="btn btn--go" onClick={() => setCreating(true)}>
          New test
        </button>
      </div>

      {error ? <p className="msg msg--bad">{error}</p> : null}

      {creating ? (
        <CreateTest
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            load();
          }}
        />
      ) : null}

      {tests.length === 0 ? (
        <p className="empty">No tests yet. Create one to start writing questions.</p>
      ) : (
        <div className="grid grid--2">
          {tests.map((test) => (
            <TestCard key={test.id} test={test} shape={shape} />
          ))}
        </div>
      )}
    </main>
  );
}

function TestCard({ test, shape }: { test: TestRow; shape: Shape | null }) {
  // A scholarship paper must be the full advertised shape; a mock can be any
  // size, so its progress is measured against what has been written rather
  // than against 75.
  const target = test.kind === 'scholarship' && shape ? shape.totalCount : test.bank.total;
  const ready = test.bank.complete;
  const share = target > 0 ? Math.min(100, (ready / target) * 100) : 0;

  return (
    <section className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <strong style={{ fontSize: '0.98rem' }}>{test.name}</strong>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            <span className={test.kind === 'scholarship' ? 'chip chip--warn' : 'chip chip--unpaid'}>
              {test.kind}
            </span>
            <span className={statusChip(test.status)}>{test.status}</span>
            {test.requiresPayment ? <span className="chip chip--unpaid">paid entry</span> : (
              <span className="chip chip--paid">free</span>
            )}
          </div>
        </div>
        <a className="btn btn--sm" href={`/admin/designer/paper?testId=${test.id}`}>
          Edit paper
        </a>
      </div>

      <dl className="dl" style={{ marginBottom: 10 }}>
        <dt>Opens</dt>
        <dd className="tnum">{new Date(test.startsAt).toLocaleString('en-IN')}</dd>
        <dt>Duration</dt>
        <dd className="tnum">{test.durationMinutes} min</dd>
        <dt>Questions</dt>
        <dd className="tnum">
          {test.bank.complete} ready
          {test.bank.total !== test.bank.complete
            ? ` · ${test.bank.total - test.bank.complete} unfinished`
            : ''}
          {target > 0 ? ` of ${target}` : ''}
        </dd>
      </dl>

      <div className="progress">
        <div
          className={share >= 100 ? 'progress__fill' : 'progress__fill progress__fill--part'}
          style={{ width: `${Math.max(1, share)}%` }}
        />
      </div>
      <p className="ap__sub" style={{ marginTop: 6 }}>
        {test.paperPublished ? 'Paper published.' : 'No paper published yet.'}
      </p>
    </section>
  );
}

function statusChip(status: string): string {
  if (status === 'live') return 'chip chip--live';
  if (status === 'scheduled') return 'chip chip--warn';
  return 'chip chip--draft';
}

/**
 * The create form.
 *
 * Both timings default to something sensible — a mock next Sunday morning — so
 * the common case is naming it and pressing create. The lobby defaults to
 * fifteen minutes before the start, which is the window the exam app's lobby
 * was written around.
 */
function CreateTest({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const nextSunday = (() => {
    const date = new Date();
    date.setDate(date.getDate() + ((7 - date.getDay()) % 7 || 7));
    return date.toISOString().slice(0, 10);
  })();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'mock' | 'scholarship'>('mock');
  const [day, setDay] = useState(nextSunday);
  const [startTime, setStartTime] = useState('09:00');
  const [duration, setDuration] = useState(180);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Built in IST explicitly. Without the offset these would be read as the
      // admin's local time, and a paper would open at the wrong hour for every
      // student in the country.
      const startsAt = new Date(`${day}T${startTime}:00+05:30`);
      const endsAt = new Date(startsAt.getTime() + duration * 60_000);
      const lobbyOpensAt = new Date(startsAt.getTime() - 15 * 60_000);

      await api('/admin/tests', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          kind,
          durationMinutes: duration,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          lobbyOpensAt: lobbyOpensAt.toISOString(),
        }),
      });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the test.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>New test</h2>
      {error ? <p className="msg msg--bad">{error}</p> : null}
      <div className="grid grid--2">
        <label className="field">
          <span>Name</span>
          <input
            className="inp"
            placeholder="JEE Main Mock 1 — Full Syllabus"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Kind</span>
          <select className="sel" value={kind} onChange={(event) => setKind(event.target.value as 'mock')}>
            <option value="mock">Mock — free, every student</option>
            <option value="scholarship">Scholarship — paid entry only</option>
          </select>
        </label>
        <label className="field">
          <span>Date (IST)</span>
          <input className="inp" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
        </label>
        <label className="field">
          <span>Start time (IST)</span>
          <input
            className="inp"
            type="time"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Duration (minutes)</span>
          <input
            className="inp tnum"
            type="number"
            min={5}
            max={600}
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
          />
        </label>
      </div>
      <p className="ap__sub">
        The lobby opens fifteen minutes before the start. The test is created as a draft — nothing
        is visible to students until you launch it.
      </p>
      <div className="row">
        <button type="button" className="btn btn--go" disabled={busy || name.trim().length < 3} onClick={submit}>
          Create test
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}
