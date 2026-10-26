import { useEffect, useRef } from 'react';
import { LIMITS, MCQ_MARKS, type Question } from '@jee/shared';

/**
 * One question. Single-correct questions render as a radio group; integer
 * questions render a short numeric field.
 *
 * Both are marked identically (+4 / −1), so the header says so once and the
 * student never has to work out which rule applies to the question in front of
 * them.
 */

export interface QuestionViewProps {
  question: Question;
  number: number;
  value: string;
  marked: boolean;
  onChange: (value: string) => void;
  onToggleReview: () => void;
  onClear: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Keeps the field to something that can be marked: an optional sign, digits and
 * at most one decimal point. Filtering as they type beats validating on submit —
 * a student who cannot see why their answer was rejected at minute 170 has no
 * way to recover, and there is no one to ask.
 *
 * A minus anywhere in the input makes the value negative, rather than only one
 * in front. Someone who types "4" and then the minus key meant −4, and a
 * keypress that does nothing at all reads as a broken field; this way the sign
 * appears where they can see it and press again to remove it.
 *
 * Not a correctness check. "9." and "-" are allowed through while being typed;
 * scoring treats anything that is not a finite number as a wrong answer.
 */
export function filterIntegerInput(raw: string): string {
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  const negative = cleaned.includes('-');
  const digits = cleaned.replace(/-/g, '');
  const [whole, ...rest] = digits.split('.');
  const joined = rest.length > 0 ? `${whole}.${rest.join('')}` : whole ?? '';
  return `${negative ? '-' : ''}${joined}`.slice(0, LIMITS.maxAnswerChars);
}

export function QuestionView(props: QuestionViewProps) {
  const { question, number, value } = props;
  const input = useRef<HTMLInputElement>(null);

  // Focus moves with the question so keyboard navigation does not strand the
  // student in the navigator.
  useEffect(() => {
    if (question.kind === 'integer') input.current?.focus();
  }, [question.id, question.kind]);

  return (
    <article className="question">
      <header className="question__head">
        <span className="question__number tnum">Question {number}</span>
        <span className="question__kind">
          {question.kind === 'scq' ? 'One correct option' : 'Integer answer'}
        </span>
        <span className="question__marks tnum">
          +{MCQ_MARKS.correct} / {MCQ_MARKS.wrong}
        </span>
      </header>

      <p className="question__body">{question.body}</p>

      {question.kind === 'scq' ? (
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
                onChange={() => props.onChange(option.key)}
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
          <div className="integer">
            <input
              ref={input}
              className="integer__input tnum"
              // `text` with inputMode rather than type="number": a number field
              // scrolls its value on a trackpad gesture and silently swallows
              // what it considers invalid, both of which lose a student's answer.
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              maxLength={LIMITS.maxAnswerChars}
              value={value}
              aria-label={`Answer to question ${number}`}
              placeholder="Your answer"
              onChange={(event) => props.onChange(filterIntegerInput(event.target.value))}
            />
            {question.unit ? (
              <span className="integer__unit" aria-hidden="true">
                {question.unit}
              </span>
            ) : null}
          </div>
          <div className="integer__meta">
            <span>
              Digits only{question.unit ? `, in ${question.unit}` : ''}. Saved as you type.
            </span>
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
