'use client';

import { useState } from 'react';
import { api } from '../../../../lib/api';
import type { Question, Shape } from './types';

/**
 * The bulk uploader.
 *
 * Takes a paste from a spreadsheet (tab-separated, which is what copying cells
 * from Excel or Google Sheets actually puts on the clipboard), a CSV, or JSON.
 * Spreadsheet paste is first because that is how a paper arrives: someone types
 * it in Sheets, or a typesetter sends an xlsx.
 *
 * The parse happens in the browser and shows what it understood before anything
 * is sent. That preview is the point — a 75-row upload that silently
 * misinterprets a column is far worse than one that refuses, and "row 34: no
 * answer" is a sentence someone can act on without knowing the format.
 *
 * Images are not uploaded here. A spreadsheet has no files in it; a row can
 * carry an image URL, and the per-question editor is where a figure is attached
 * by picking a file.
 */

const COLUMNS = [
  'number', 'subject', 'type', 'question',
  'A', 'B', 'C', 'D', 'answer', 'unit', 'solution', 'image',
] as const;

const TEMPLATE = [
  COLUMNS.join('\t'),
  ['q1', 'physics', 'scq', 'A body starts from rest with uniform acceleration 2 m/s². How far does it travel in 5 s?', '10 m', '25 m', '50 m', '100 m', 'B', '', 's = ½at² = ½·2·25 = 25 m', ''].join('\t'),
  ['q2', 'physics', 'integer', 'Find the number of significant figures in 0.00430.', '', '', '', '', '3', '', 'Leading zeros do not count.', ''].join('\t'),
].join('\n');

interface ParsedRow {
  question: Partial<Question> & { questionRef: string };
  problems: string[];
}

export function BulkUpload({
  testId,
  shape,
  onUploaded,
}: {
  testId: number;
  shape: Shape;
  onUploaded: () => void;
}) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedRow[] | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function parse() {
    setError(null);
    setMessage(null);
    try {
      setParsed(text.trim().startsWith('[') ? parseJson(text, shape) : parseDelimited(text, shape));
    } catch (caught) {
      setParsed(null);
      setError(caught instanceof Error ? caught.message : 'Could not read that.');
    }
  }

  async function upload() {
    if (!parsed) return;
    const bad = parsed.filter((row) => row.problems.length > 0);
    if (bad.length > 0) {
      setError(`Fix ${bad.length} row${bad.length === 1 ? '' : 's'} first, or remove them from the paste.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api<{ saved: number; problems: string[] }>(
        `/admin/tests/${testId}/questions/bulk`,
        {
          method: 'POST',
          body: JSON.stringify({ questions: parsed.map((row) => row.question), replace }),
        },
      );
      setMessage(
        `${result.saved} question${result.saved === 1 ? '' : 's'} saved.`
        + (result.problems.length > 0
          ? ` The paper still has ${result.problems.length} problem${result.problems.length === 1 ? '' : 's'} to fix.`
          : ' This paper now validates.'),
      );
      setText('');
      setParsed(null);
      onUploaded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The upload failed. Nothing was saved.');
    } finally {
      setBusy(false);
    }
  }

  const bad = parsed?.filter((row) => row.problems.length > 0) ?? [];

  return (
    <section className="card">
      <h2>Bulk upload</h2>

      {message ? <p className="msg msg--ok">{message}</p> : null}
      {error ? <p className="msg msg--bad">{error}</p> : null}

      <details style={{ marginBottom: 12 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.84rem' }}>
          What to paste
        </summary>
        <div style={{ paddingTop: 8 }}>
          <p className="ap__sub">
            Copy the cells straight out of Excel or Google Sheets — the first row must be the
            column names. Columns may be in any order and the ones you do not need can be left
            out entirely.
          </p>
          <table className="t" style={{ marginBottom: 10 }}>
            <tbody>
              <tr><td><code>number</code></td><td>q1, q2… — unique within this paper</td></tr>
              <tr><td><code>subject</code></td><td>{shape.subjects.join(', ')}</td></tr>
              <tr><td><code>type</code></td><td><code>scq</code> for multiple choice, <code>integer</code> for a typed number</td></tr>
              <tr><td><code>question</code></td><td>the question text</td></tr>
              <tr><td><code>A</code>…<code>D</code></td><td>options, for <code>scq</code> rows</td></tr>
              <tr><td><code>answer</code></td><td>the option letter (<code>B</code>) or the number (<code>12</code>)</td></tr>
              <tr><td><code>unit</code>, <code>solution</code>, <code>image</code></td><td>optional</td></tr>
            </tbody>
          </table>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setText(TEMPLATE);
              setParsed(null);
            }}
          >
            Load a two-row example
          </button>
        </div>
      </details>

      <label className="field">
        <span>Paste here</span>
        <textarea
          className="ta"
          style={{ minHeight: 190, fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem' }}
          value={text}
          placeholder={'number\tsubject\ttype\tquestion\tA\tB\tC\tD\tanswer'}
          onChange={(event) => {
            setText(event.target.value);
            setParsed(null);
          }}
        />
      </label>

      <div className="row">
        <button type="button" className="btn" disabled={!text.trim()} onClick={parse}>
          Check it
        </button>
        <label className="row" style={{ gap: 5, fontSize: '0.82rem', fontWeight: 600 }}>
          <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
          Replace the whole paper
        </label>
        <span className="ap__sub">
          {replace
            ? 'Every existing question in this test will be deleted first.'
            : 'Rows with a number that already exists will update that question.'}
        </span>
      </div>

      {parsed ? (
        <>
          <p className={bad.length > 0 ? 'msg msg--bad' : 'msg msg--ok'} style={{ marginTop: 14 }}>
            Read {parsed.length} row{parsed.length === 1 ? '' : 's'}.
            {bad.length > 0 ? ` ${bad.length} need fixing before this can be uploaded.` : ' All of them look complete.'}
          </p>

          <div className="tablewrap" style={{ marginBottom: 12 }}>
            <table className="t">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Subject</th>
                  <th>Type</th>
                  <th>Question</th>
                  <th>Answer</th>
                  <th>Problems</th>
                </tr>
              </thead>
              <tbody>
                {parsed.map((row, index) => (
                  <tr key={`${row.question.questionRef}-${index}`}>
                    <td className="tnum nowrap">{row.question.questionRef}</td>
                    <td className="nowrap">{row.question.subject}</td>
                    <td className="nowrap">{row.question.kind}</td>
                    <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.question.body}
                    </td>
                    <td className="nowrap">
                      {row.question.correctAnswer ?? <span className="chip chip--bad">none</span>}
                    </td>
                    <td style={{ color: 'var(--admin-bad)', fontSize: '0.78rem' }}>
                      {row.problems.join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            className="btn btn--go"
            disabled={busy || bad.length > 0}
            onClick={upload}
          >
            {busy ? 'Uploading…' : `Upload ${parsed.length} question${parsed.length === 1 ? '' : 's'}`}
          </button>
        </>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Tab- or comma-separated, with a header row.
 *
 * Tabs are tried first: that is what a spreadsheet puts on the clipboard, and
 * question text routinely contains commas, so guessing comma on a tabbed paste
 * would split sentences into columns.
 */
function parseDelimited(text: string, shape: Shape): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    throw new Error('Paste the header row and at least one question.');
  }

  const delimiter = lines[0]!.includes('\t') ? '\t' : ',';
  const header = splitRow(lines[0]!, delimiter).map((cell) => cell.trim().toLowerCase());

  const index = (...names: string[]) => {
    for (const name of names) {
      const at = header.indexOf(name.toLowerCase());
      if (at >= 0) return at;
    }
    return -1;
  };

  const columns = {
    ref: index('number', 'no', 'q', 'ref', 'question_ref', 'qno'),
    subject: index('subject'),
    kind: index('type', 'kind'),
    body: index('question', 'body', 'text', 'statement'),
    a: index('a', 'option a', 'optiona', 'opt_a'),
    b: index('b', 'option b', 'optionb', 'opt_b'),
    c: index('c', 'option c', 'optionc', 'opt_c'),
    d: index('d', 'option d', 'optiond', 'opt_d'),
    answer: index('answer', 'correct', 'correct_answer', 'key'),
    unit: index('unit'),
    solution: index('solution', 'explanation'),
    image: index('image', 'image_url', 'figure'),
  };

  if (columns.body < 0) {
    throw new Error(
      `No "question" column found. The header row reads: ${header.join(' | ')}`,
    );
  }

  return lines.slice(1).map((line, position) => {
    const cells = splitRow(line, delimiter);
    const at = (column: number) => (column >= 0 ? (cells[column] ?? '').trim() : '');

    const ref = at(columns.ref) || `q${position + 1}`;
    const subject = (at(columns.subject) || shape.subjects[0]!).toLowerCase();
    const answer = at(columns.answer);

    // The type is inferred when the column is missing, which it often is:
    // options present means multiple choice.
    const declared = at(columns.kind).toLowerCase();
    const options = [
      { key: 'A', body: at(columns.a) },
      { key: 'B', body: at(columns.b) },
      { key: 'C', body: at(columns.c) },
      { key: 'D', body: at(columns.d) },
    ].filter((option) => option.body);
    const kind: 'scq' | 'integer' =
      declared.startsWith('int') || declared === 'numeric'
        ? 'integer'
        : declared.startsWith('scq') || declared.startsWith('mcq')
          ? 'scq'
          : options.length >= 2
            ? 'scq'
            : 'integer';

    const question = {
      questionRef: ref,
      subject,
      kind,
      position: position + 1,
      body: at(columns.body),
      options: kind === 'scq' ? options : [],
      correctAnswer: answer || null,
      imageUrl: at(columns.image) || null,
      solutionText: at(columns.solution) || null,
      solutionImageUrl: null,
      unit: kind === 'integer' ? at(columns.unit) || null : null,
      marksCorrect: 4,
      marksWrong: -1,
    };

    return { question, problems: checkRow(question, shape) };
  });
}

/** JSON, for a paper exported from somewhere else. */
function parseJson(text: string, shape: Shape): ParsedRow[] {
  const raw = JSON.parse(text) as Record<string, unknown>[];
  if (!Array.isArray(raw)) throw new Error('Expected a JSON array of questions.');

  return raw.map((entry, position) => {
    const kind = String(entry.kind ?? entry.type ?? 'scq').startsWith('int') ? 'integer' : 'scq';
    const question = {
      questionRef: String(entry.questionRef ?? entry.id ?? entry.number ?? `q${position + 1}`),
      subject: String(entry.subject ?? shape.subjects[0]).toLowerCase(),
      kind: kind as 'scq' | 'integer',
      position: Number(entry.position ?? position + 1),
      body: String(entry.body ?? entry.question ?? ''),
      options:
        kind === 'scq'
          ? ((entry.options as { key: string; body: string }[] | undefined) ?? []).map((option) => ({
              key: String(option.key),
              body: String(option.body ?? ''),
            }))
          : [],
      correctAnswer:
        entry.correctAnswer !== undefined && entry.correctAnswer !== null
          ? String(entry.correctAnswer)
          : entry.answer !== undefined && entry.answer !== null
            ? String(entry.answer)
            : null,
      imageUrl: entry.imageUrl ? String(entry.imageUrl) : null,
      solutionText: entry.solutionText ? String(entry.solutionText) : null,
      solutionImageUrl: entry.solutionImageUrl ? String(entry.solutionImageUrl) : null,
      unit: entry.unit ? String(entry.unit) : null,
      marksCorrect: Number(entry.marksCorrect ?? 4),
      marksWrong: Number(entry.marksWrong ?? -1),
    };
    return { question, problems: checkRow(question, shape) };
  });
}

/**
 * The same rules the server enforces, run in the browser so the preview can
 * show them per row. The server still refuses the upload — this is for the
 * message, not the rule.
 */
function checkRow(
  question: {
    questionRef: string;
    subject: string;
    kind: 'scq' | 'integer';
    body: string;
    options: { key: string; body: string }[];
    correctAnswer: string | null;
  },
  shape: Shape,
): string[] {
  const problems: string[] = [];

  if (!question.questionRef.trim()) problems.push('no number');
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(question.questionRef)) {
    problems.push('the number may only use letters, digits, dashes and underscores');
  }
  if (!question.body.trim()) problems.push('no question text');
  if (!shape.subjects.includes(question.subject)) {
    problems.push(`"${question.subject}" is not one of ${shape.subjects.join(', ')}`);
  }
  if (!question.correctAnswer?.trim()) {
    problems.push('no answer');
  }

  if (question.kind === 'scq') {
    if (question.options.length < 2) problems.push('fewer than two options');
    const keys = question.options.map((option) => option.key);
    if (question.correctAnswer && !keys.includes(question.correctAnswer)) {
      problems.push(`the answer "${question.correctAnswer}" is not one of ${keys.join('/')}`);
    }
  } else if (question.correctAnswer && !Number.isFinite(Number(question.correctAnswer))) {
    problems.push(`"${question.correctAnswer}" is not a number`);
  }

  return problems;
}

/** One row, honouring RFC 4180 quoting so a quoted comma stays in its cell. */
function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}
