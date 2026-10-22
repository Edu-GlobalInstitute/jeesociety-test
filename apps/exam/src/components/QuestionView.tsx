import { useEffect, useRef } from 'react';
import { LIMITS, type Question } from '@jee/shared';

/**
 * One question. MCQs render as a radio group; subjective questions render a
 * textarea with telemetry listeners attached.
 *
 * Paste is deliberately not blocked. Students legitimately move their own text
 * around — rewriting a derivation, pulling a line up from a scratch area — and
 * blocking it generates support load without stopping anyone determined. The
 * paste is counted, not prevented, and the count is evidence for a human.
 */

export interface QuestionViewProps {
  question: Question;
  number: number;
  value: string;
  marked: boolean;
  onChange: (value: string) => void;
  onKeystroke: () => void;
  onPaste: (chars: number) => void;
  onToggleReview: () => void;
  onClear: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

export function QuestionView(props: QuestionViewProps) {
  const { question, number, value } = props;
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Focus moves with the question so keyboard navigation does not strand the
  // student in the navigator.
  useEffect(() => {
    if (question.kind === 'subjective') textarea.current?.focus();
  }, [question.id, question.kind]);

  return (
    <article className="question">
      <header className="question__head">
        <span className="question__number tnum">Question {number}</span>
        <span className="question__kind">
          {question.kind === 'mcq' ? 'Multiple choice' : 'Written answer'}
        </span>
        <span className="question__marks">
          {question.kind === 'mcq' ? '+4 / −1' : 'up to 3 marks'}
        </span>
      </header>

      <p className="question__body">{question.body}</p>

      {question.kind === 'mcq' ? (
        <fieldset className="options">
          <legend className="muted" style={{ marginBottom: 8 }}>
            Choose one
          </legend>
          {question.options.map((option) => (
            <label
              key={option.key}
              className={`option${value === option.key ? ' option--selected' : ''}`}
            >
              <input
                type="radio"
                name={question.id}
                value={option.key}
                checked={value === option.key}
                onChange={() => {
                  props.onKeystroke();
                  props.onChange(option.key);
                }}
              />
              <span className="option__key" aria-hidden="true">
                {option.key}
              </span>
              <span className="option__body">{option.body}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <textarea
            ref={textarea}
            className="answer"
            value={value}
            maxLength={LIMITS.maxAnswerChars}
            spellCheck={false}
            aria-label={`Answer to question ${number}`}
            placeholder="Show your working here."
            onChange={(event) => props.onChange(event.target.value)}
            onKeyDown={(event) => {
              // Counters only: one increment per character or backspace. The
              // keys themselves are never recorded.
              if (event.key.length === 1 || event.key === 'Backspace') props.onKeystroke();
            }}
            onPaste={(event) => {
              props.onPaste(event.clipboardData.getData('text').length);
            }}
          />
          <div className="answer__meta">
            <span className="tnum">
              {value.length.toLocaleString()} / {LIMITS.maxAnswerChars.toLocaleString()} characters
            </span>
            <span>Saved as you type</span>
          </div>
        </>
      )}

      <div className="actions">
        <button type="button" className="btn" onClick={props.onPrev} disabled={!props.hasPrev}>
          Previous
        </button>
        <button
          type="button"
          className="btn btn--review"
          aria-pressed={props.marked}
          onClick={props.onToggleReview}
        >
          {props.marked ? 'Marked to come back to' : 'Mark to come back to'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={props.onClear}
          disabled={value.length === 0}
        >
          Clear answer
        </button>
        <button
          type="button"
          className="btn btn--primary btn--spacer"
          onClick={props.onNext}
          disabled={!props.hasNext}
        >
          Next
        </button>
      </div>
    </article>
  );
}
