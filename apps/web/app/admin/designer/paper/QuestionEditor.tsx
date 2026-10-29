'use client';

import { useState } from 'react';
import { api } from '../../../../lib/api';
import { imageSrc, uploadImage, type Question, type Shape } from './types';

/**
 * One question, editable: body, options, the correct answer, figures for any of
 * them, and a worked solution.
 *
 * Collapsed by default and opened one at a time. A paper is 75 questions, and
 * 75 expanded forms is a screen nobody can find anything in — the header shows
 * the number, the first line, and whether it is finished, which is what a
 * reviewer scans for.
 *
 * The correct answer is a radio button beside each option rather than a text
 * field. Typing "B" into a box is how a key ends up naming an option the
 * question does not have, and the API refuses that — so the control makes the
 * mistake unexpressible rather than reporting it afterwards.
 */
export function QuestionEditor({
  testId,
  question,
  shape,
  readOnly,
  startOpen = false,
  onSaved,
  onCancel,
}: {
  testId: number;
  question: Question;
  shape: Shape;
  readOnly: boolean;
  startOpen?: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [draft, setDraft] = useState<Question>(question);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const incomplete = !draft.correctAnswer?.trim();

  function set<K extends keyof Question>(key: K, value: Question[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function pickImage(file: File | undefined, apply: (url: string) => void, slot: string) {
    if (!file) return;
    setUploading(slot);
    setError(null);
    try {
      apply(await uploadImage(file, testId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload that image.');
    } finally {
      setUploading(null);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/tests/${testId}/questions`, {
        method: 'POST',
        body: JSON.stringify({
          questionRef: draft.questionRef.trim(),
          subject: draft.subject,
          kind: draft.kind,
          position: draft.position,
          body: draft.body,
          options: draft.kind === 'scq' ? draft.options : [],
          correctAnswer: draft.correctAnswer,
          imageUrl: draft.imageUrl,
          solutionText: draft.solutionText,
          solutionImageUrl: draft.solutionImageUrl,
          unit: draft.unit,
          marksCorrect: draft.marksCorrect,
          marksWrong: draft.marksWrong,
        }),
      });
      onSaved();
      if (!onCancel) setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save this question.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${draft.questionRef}? This cannot be undone.`)) return;
    try {
      await api(`/admin/questions/${question.id}`, { method: 'DELETE' });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete this question.');
    }
  }

  return (
    <article className={`q ${open ? 'q--open' : ''} ${incomplete ? 'q--bad' : ''}`}>
      <div
        className="q__head"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(!open);
          }
        }}
      >
        <span className="q__ref">{draft.questionRef}</span>
        <span className="chip chip--draft">{draft.kind === 'scq' ? 'MCQ' : 'integer'}</span>
        <span className="q__peek">{draft.body.slice(0, 110) || <em>empty</em>}</span>
        {draft.imageUrl ? <span title="has a figure">🖼</span> : null}
        {incomplete ? (
          <span className="chip chip--bad">no answer</span>
        ) : (
          <span className="chip chip--paid">{draft.correctAnswer}</span>
        )}
      </div>

      {open ? (
        <div className="q__body">
          {error ? <p className="msg msg--bad">{error}</p> : null}

          <div className="grid grid--kpi" style={{ marginBottom: 10 }}>
            <label className="field">
              <span>Number</span>
              <input
                className="inp inp--sm"
                value={draft.questionRef}
                disabled={readOnly}
                onChange={(event) => set('questionRef', event.target.value)}
              />
            </label>
            <label className="field">
              <span>Subject</span>
              <select
                className="sel sel--sm"
                value={draft.subject}
                disabled={readOnly}
                onChange={(event) => set('subject', event.target.value)}
              >
                {shape.subjects.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Type</span>
              <select
                className="sel sel--sm"
                value={draft.kind}
                disabled={readOnly}
                onChange={(event) => {
                  const kind = event.target.value as 'scq' | 'integer';
                  // Changing type invalidates the answer: an option letter is
                  // not a number and vice versa. Clearing it is honest — the
                  // question is now unfinished and the header says so.
                  setDraft((current) => ({
                    ...current,
                    kind,
                    correctAnswer: null,
                    options:
                      kind === 'scq' && current.options.length === 0
                        ? [
                            { key: 'A', body: '' },
                            { key: 'B', body: '' },
                            { key: 'C', body: '' },
                            { key: 'D', body: '' },
                          ]
                        : current.options,
                  }));
                }}
              >
                <option value="scq">Single correct (MCQ)</option>
                <option value="integer">Integer answer</option>
              </select>
            </label>
            <label className="field">
              <span>Order in subject</span>
              <input
                className="inp inp--sm tnum"
                type="number"
                min={1}
                value={draft.position}
                disabled={readOnly}
                onChange={(event) => set('position', Number(event.target.value))}
              />
            </label>
          </div>

          <label className="field">
            <span>Question</span>
            <textarea
              className="ta"
              value={draft.body}
              disabled={readOnly}
              placeholder="A particle moves along the x-axis such that…"
              onChange={(event) => set('body', event.target.value)}
            />
          </label>

          <ImageField
            label="Figure for the question"
            url={draft.imageUrl}
            busy={uploading === 'body'}
            readOnly={readOnly}
            onPick={(file) => pickImage(file, (url) => set('imageUrl', url), 'body')}
            onClear={() => set('imageUrl', null)}
          />

          {draft.kind === 'scq' ? (
            <>
              <p style={{ fontSize: '0.76rem', fontWeight: 700, color: 'var(--admin-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 6px' }}>
                Options · select the correct one
              </p>
              {draft.options.map((option, index) => (
                <div
                  key={index}
                  className={draft.correctAnswer === option.key ? 'opt opt--right' : 'opt'}
                >
                  <div className="opt__key">
                    <label style={{ cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name={`answer-${question.id}-${draft.questionRef}`}
                        checked={draft.correctAnswer === option.key}
                        disabled={readOnly}
                        onChange={() => set('correctAnswer', option.key)}
                        aria-label={`Option ${option.key} is correct`}
                      />
                      <div>{option.key}</div>
                    </label>
                  </div>
                  <div>
                    <textarea
                      className="ta"
                      style={{ minHeight: 44 }}
                      value={option.body}
                      disabled={readOnly}
                      placeholder={`Option ${option.key}`}
                      onChange={(event) => {
                        const next = [...draft.options];
                        next[index] = { ...option, body: event.target.value };
                        set('options', next);
                      }}
                    />
                    <ImageField
                      label=""
                      url={option.imageUrl ?? null}
                      busy={uploading === `opt-${index}`}
                      readOnly={readOnly}
                      compact
                      onPick={(file) =>
                        pickImage(
                          file,
                          (url) => {
                            const next = [...draft.options];
                            next[index] = { ...option, imageUrl: url };
                            set('options', next);
                          },
                          `opt-${index}`,
                        )
                      }
                      onClear={() => {
                        const next = [...draft.options];
                        next[index] = { ...option, imageUrl: null };
                        set('options', next);
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    disabled={readOnly || draft.options.length <= 2}
                    title={draft.options.length <= 2 ? 'A question needs at least two options' : 'Remove'}
                    onClick={() => {
                      const next = draft.options.filter((_, position) => position !== index);
                      setDraft((current) => ({
                        ...current,
                        options: next,
                        // The answer cannot point at an option that is gone.
                        correctAnswer: current.correctAnswer === option.key ? null : current.correctAnswer,
                      }));
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {!readOnly && draft.options.length < 8 ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() =>
                    set('options', [
                      ...draft.options,
                      { key: String.fromCharCode(65 + draft.options.length), body: '' },
                    ])
                  }
                >
                  + Option
                </button>
              ) : null}
            </>
          ) : (
            <div className="grid grid--kpi">
              <label className="field">
                <span>Correct answer (a number)</span>
                <input
                  className="inp tnum"
                  value={draft.correctAnswer ?? ''}
                  disabled={readOnly}
                  placeholder="12"
                  onChange={(event) => set('correctAnswer', event.target.value)}
                />
              </label>
              <label className="field">
                <span>Unit (shown, not marked)</span>
                <input
                  className="inp"
                  value={draft.unit ?? ''}
                  disabled={readOnly}
                  placeholder="m/s²"
                  onChange={(event) => set('unit', event.target.value || null)}
                />
              </label>
            </div>
          )}

          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600, color: 'var(--admin-muted)' }}>
              Solution and marks
            </summary>
            <div style={{ paddingTop: 10 }}>
              <label className="field">
                <span>Worked solution</span>
                <textarea
                  className="ta"
                  value={draft.solutionText ?? ''}
                  disabled={readOnly}
                  onChange={(event) => set('solutionText', event.target.value || null)}
                />
              </label>
              <ImageField
                label="Figure for the solution"
                url={draft.solutionImageUrl}
                busy={uploading === 'solution'}
                readOnly={readOnly}
                onPick={(file) => pickImage(file, (url) => set('solutionImageUrl', url), 'solution')}
                onClear={() => set('solutionImageUrl', null)}
              />
              <div className="grid grid--kpi">
                <label className="field">
                  <span>Marks if correct</span>
                  <input
                    className="inp tnum"
                    type="number"
                    value={draft.marksCorrect}
                    disabled={readOnly}
                    onChange={(event) => set('marksCorrect', Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Marks if wrong</span>
                  <input
                    className="inp tnum"
                    type="number"
                    value={draft.marksWrong}
                    disabled={readOnly}
                    onChange={(event) => set('marksWrong', Number(event.target.value))}
                  />
                </label>
              </div>
            </div>
          </details>

          {!readOnly ? (
            <div className="row" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn--go" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save question'}
              </button>
              {onCancel ? (
                <button type="button" className="btn" onClick={onCancel}>
                  Cancel
                </button>
              ) : null}
              {question.id > 0 ? (
                <button type="button" className="btn btn--danger" style={{ marginLeft: 'auto' }} onClick={remove}>
                  Delete
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** An image slot: upload, preview, remove. */
function ImageField({
  label,
  url,
  busy,
  readOnly,
  compact = false,
  onPick,
  onClear,
}: {
  label: string;
  url: string | null;
  busy: boolean;
  readOnly: boolean;
  compact?: boolean;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
}) {
  return (
    <div className={compact ? '' : 'field'}>
      {label ? <span style={{ display: 'block', fontSize: '0.76rem', fontWeight: 700, color: 'var(--admin-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span> : null}
      <div className="row">
        {!readOnly ? (
          <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
            {busy ? 'Uploading…' : url ? 'Replace image' : '+ Image'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={(event) => {
                onPick(event.target.files?.[0]);
                // Cleared so picking the same file twice fires again, which it
                // otherwise would not.
                event.target.value = '';
              }}
            />
          </label>
        ) : null}
        {url && !readOnly ? (
          <button type="button" className="btn btn--sm btn--danger" onClick={onClear}>
            Remove
          </button>
        ) : null}
      </div>
      {url ? (
        // Plain <img>: this app is a static export with images.unoptimized, so
        // next/image would add a component and buy nothing.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="thumb" src={imageSrc(url)} alt="" />
      ) : null}
    </div>
  );
}
