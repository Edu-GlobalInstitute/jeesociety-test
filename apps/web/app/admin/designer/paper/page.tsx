'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/api';
import { BulkUpload } from './BulkUpload';
import { QuestionEditor } from './QuestionEditor';
import type { Question, Shape, TestSummary } from './types';

/**
 * The paper editor: the question bank for one test, and the launch button.
 *
 * Reached as /admin/designer/paper?testId=1 rather than as a dynamic segment,
 * because this app is a static export (next.config.mjs, output: 'export') and a
 * [testId] route would need every id known at build time.
 *
 * The screen is arranged around one question: can this be launched? The
 * problems list is always visible when it is not empty, and the launch button
 * is disabled until it is — so an admin learns what is missing while writing,
 * rather than by being refused at the end.
 */

interface PaperResponse {
  test: TestSummary;
  questions: Question[];
  summary: {
    total: number;
    complete: number;
    bySubject: { subject: string; scq: number; integer: number; incomplete: number }[];
  };
  problems: string[];
  paperShape: Shape;
}

function PaperEditor() {
  const [testId, setTestId] = useState<number | null>(null);
  const [data, setData] = useState<PaperResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [tab, setTab] = useState<'questions' | 'bulk'>('questions');
  const [subject, setSubject] = useState<string>('');
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('testId'));
    if (Number.isFinite(id) && id > 0) setTestId(id);
    else setError('No test was named in the link.');
  }, []);

  const load = useCallback(() => {
    if (testId === null) return;
    api<PaperResponse>(`/admin/tests/${testId}/questions`)
      .then((next) => {
        setData(next);
        setError(null);
      })
      .catch((caught) =>
        setError(caught instanceof Error ? caught.message : 'Could not load this paper.'),
      );
  }, [testId]);

  useEffect(load, [load]);

  /**
   * Launch.
   *
   * Two steps, both deliberate. The confirmation names the consequence rather
   * than asking "are you sure", and going straight to `live` is a separate
   * choice from publishing — a paper is normally published as `scheduled` (on
   * sale, inside locked) days before anyone sits it.
   */
  async function launch(status: 'scheduled' | 'live') {
    if (!data) return;
    const confirmed = window.confirm(
      status === 'live'
        ? `This publishes the paper AND opens it immediately. ${data.questions.length} questions, `
          + `${data.test.requiresPayment ? 'paid students' : 'every signed-in student'} can enter now. Continue?`
        : `Publish ${data.questions.length} questions and put this test on sale? `
          + 'Students will see it listed, but the paper stays locked until you go live.',
    );
    if (!confirmed) return;

    setLaunching(true);
    setMessage(null);
    try {
      const result = await api<{ questions: number; maxMarks: number }>(
        `/admin/tests/${testId}/launch`,
        { method: 'POST', body: JSON.stringify({ status, reason: `launched as ${status}` }) },
      );
      setMessage(
        `Published: ${result.questions} questions, ${result.maxMarks} marks. `
        + (status === 'live' ? 'The test is open now.' : 'The test is on sale and locked.'),
      );
      load();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Could not publish the paper.');
    } finally {
      setLaunching(false);
    }
  }

  if (error) {
    return (
      <main className="ap">
        <p className="msg msg--bad">{error}</p>
        <a className="btn" href="/admin/designer">
          ← All tests
        </a>
      </main>
    );
  }
  if (!data || testId === null) {
    return (
      <main className="ap">
        <p className="empty">Loading…</p>
      </main>
    );
  }

  const shown = subject
    ? data.questions.filter((question) => question.subject === subject)
    : data.questions;
  const canLaunch = data.problems.length === 0 && data.questions.length > 0;
  const locked = data.test.status === 'live';

  return (
    <main className="ap">
      <div className="ap__head">
        <div>
          <p className="ap__sub" style={{ marginBottom: 2 }}>
            <a href="/admin/designer">← All tests</a>
          </p>
          <h1>{data.test.name}</h1>
          <p className="ap__sub">
            <span className={data.test.kind === 'scholarship' ? 'chip chip--warn' : 'chip chip--unpaid'}>
              {data.test.kind}
            </span>{' '}
            <span className="chip chip--draft">{data.test.status}</span> ·{' '}
            {data.summary.complete} of {data.summary.total} questions ready ·{' '}
            opens {new Date(data.test.startsAt).toLocaleString('en-IN')}
          </p>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={!canLaunch || launching || locked}
            onClick={() => launch('scheduled')}
          >
            Publish &amp; put on sale
          </button>
          <button
            type="button"
            className="btn btn--go"
            disabled={!canLaunch || launching || locked}
            onClick={() => launch('live')}
          >
            {launching ? 'Publishing…' : 'Publish & go live'}
          </button>
        </div>
      </div>

      {message ? <p className="msg msg--ok">{message}</p> : null}

      {locked ? (
        <p className="msg msg--warn">
          This test is <strong>live</strong>. Its questions cannot be edited: students hold a paper
          encrypted with the current key, so republishing would leave them with one that no longer
          opens.
        </p>
      ) : null}

      {data.problems.length > 0 ? (
        <div className="msg msg--bad">
          <strong>
            {data.problems.length} thing{data.problems.length === 1 ? '' : 's'} to fix before this
            paper can be published:
          </strong>
          <ul>
            {data.problems.slice(0, 25).map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
            {data.problems.length > 25 ? <li>…and {data.problems.length - 25} more.</li> : null}
          </ul>
        </div>
      ) : data.questions.length > 0 ? (
        <p className="msg msg--ok">
          This paper validates: {data.questions.length} questions, every one with an answer.
        </p>
      ) : null}

      <div className="row" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className={tab === 'questions' ? 'btn btn--sm btn--go' : 'btn btn--sm'}
          onClick={() => setTab('questions')}
        >
          Questions ({data.questions.length})
        </button>
        <button
          type="button"
          className={tab === 'bulk' ? 'btn btn--sm btn--go' : 'btn btn--sm'}
          onClick={() => setTab('bulk')}
        >
          Bulk upload
        </button>
        {tab === 'questions' ? (
          <select
            className="sel sel--sm"
            style={{ width: 'auto', marginLeft: 'auto' }}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          >
            <option value="">All subjects</option>
            {data.paperShape.subjects.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {tab === 'bulk' ? (
        <BulkUpload testId={testId} shape={data.paperShape} onUploaded={load} />
      ) : (
        <>
          <div className="grid grid--kpi" style={{ marginBottom: 14 }}>
            {data.paperShape.subjects.map((name) => {
              const row = data.summary.bySubject.find((entry) => entry.subject === name);
              const have = (row?.scq ?? 0) + (row?.integer ?? 0);
              const want =
                data.test.kind === 'scholarship'
                  ? data.paperShape.scqPerSubject + data.paperShape.integerPerSubject
                  : have;
              return (
                <div className="card" key={name}>
                  <p className="kpi__label">{name}</p>
                  <div className="kpi__value" style={{ fontSize: '1.4rem' }}>
                    {have}
                    {want > 0 ? <span style={{ color: 'var(--admin-faint)' }}> / {want}</span> : null}
                  </div>
                  <p className="kpi__foot">
                    {row?.scq ?? 0} single-correct · {row?.integer ?? 0} integer
                    {row?.incomplete ? ` · ${row.incomplete} unfinished` : ''}
                  </p>
                </div>
              );
            })}
          </div>

          {shown.length === 0 ? (
            <p className="empty">
              No questions yet. Use <strong>Bulk upload</strong> to paste a whole paper in, or add
              them one at a time.
            </p>
          ) : (
            shown.map((question) => (
              <QuestionEditor
                key={question.id}
                testId={testId}
                question={question}
                shape={data.paperShape}
                readOnly={locked}
                onSaved={load}
              />
            ))
          )}

          {!locked ? (
            <NewQuestion
              testId={testId}
              shape={data.paperShape}
              existing={data.questions}
              onSaved={load}
            />
          ) : null}
        </>
      )}
    </main>
  );
}

/**
 * Adds one question.
 *
 * The next ref and position are suggested from what is already there, because
 * the common case is writing a paper in order and typing "q38" by hand is how
 * duplicates happen.
 */
function NewQuestion({
  testId,
  shape,
  existing,
  onSaved,
}: {
  testId: number;
  shape: Shape;
  existing: Question[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        + Add a question
      </button>
    );
  }

  const highest = existing
    .map((question) => Number(question.questionRef.replace(/\D/g, '')))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);

  const blank: Question = {
    id: 0,
    questionRef: `q${highest + 1}`,
    subject: shape.subjects[0]!,
    kind: 'scq',
    position: existing.filter((q) => q.subject === shape.subjects[0]).length + 1,
    body: '',
    options: [
      { key: 'A', body: '' },
      { key: 'B', body: '' },
      { key: 'C', body: '' },
      { key: 'D', body: '' },
    ],
    correctAnswer: null,
    imageUrl: null,
    solutionText: null,
    solutionImageUrl: null,
    unit: null,
    marksCorrect: 4,
    marksWrong: -1,
    updatedAt: null,
  };

  return (
    <QuestionEditor
      testId={testId}
      question={blank}
      shape={shape}
      readOnly={false}
      startOpen
      onSaved={() => {
        setOpen(false);
        onSaved();
      }}
      onCancel={() => setOpen(false)}
    />
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PaperEditor />
    </Suspense>
  );
}
