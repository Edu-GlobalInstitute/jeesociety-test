'use client';

import { useState } from 'react';
import { MCQ_MARKS } from '@jee/shared/config';
import { TASTER_QUESTIONS, TASTER_SOURCE } from '../lib/tasterQuestions';
import { Celebration } from './Celebration';
import { ArrowIcon } from './PosterMarks';

/**
 * Five questions, answered before paying.
 *
 * This is the one part of the page that argues for itself. A student can read
 * "JEE level" anywhere; here they feel it in forty seconds, and they feel it
 * marked the way the real paper is marked — +4 and −1 come from the same
 * constant the server scores with, so the tally on screen cannot drift from
 * what an attempt is actually worth.
 *
 * Three rules it keeps:
 *  - It never scolds. A wrong answer shows the working and moves on; the
 *    closing line for a low score is about what the mistakes are worth in
 *    November, not about the student.
 *  - An answer is final, as in the real paper's marking — tapping a second
 *    option does nothing once the verdict is showing.
 *  - It needs no network and stores nothing. Nobody has an account yet.
 */

const MAX_MARKS = TASTER_QUESTIONS.length * MCQ_MARKS.correct;

/** A score a student should be allowed to celebrate: four of five, clean. */
const CELEBRATE_AT = 16;

export type Picks = (number | null)[];

/** JEE marking, applied to the taster: +4, −1, nothing for a skip. */
export function tally(picks: Picks): number {
  return picks.reduce<number>((marks, pick, index) => {
    if (pick === null) return marks + MCQ_MARKS.unattempted;
    return marks + (pick === TASTER_QUESTIONS[index]!.answer
      ? MCQ_MARKS.correct
      : MCQ_MARKS.wrong);
  }, 0);
}

/** The closing line. Written so that every one of them is a reason to sit. */
export function verdictFor(marks: number): { title: string; note: string } {
  if (marks === MAX_MARKS) {
    return {
      title: 'Full marks.',
      note:
        'Clean sweep, no negatives. The top band is not a fantasy for you — it is a Sunday '
        + 'morning and three hours of work. Come and prove it against the whole country.',
    };
  }
  if (marks >= CELEBRATE_AT) {
    return {
      title: 'That is rank-list territory.',
      note:
        'You are losing almost nothing to silly errors. What you do not know yet is where that '
        + 'puts you among ten thousand other students — which is the number this test exists '
        + 'to give you.',
    };
  }
  if (marks >= 8) {
    return {
      title: 'Solid, with marks left on the table.',
      note:
        'Each slip you just made is five marks in the real paper: four you did not take, and '
        + 'one taken off. Three hours under a real clock is how you find out how many of those '
        + 'you are making.',
    };
  }
  return {
    title: 'Better here than in November.',
    note:
      'Every one of those is cheap today and expensive in the exam hall. This is exactly what a '
      + 'full-length paper is for: it tells you which chapters are costing you marks while there '
      + 'is still time to fix them.',
  };
}

export function TryQuestions() {
  const [picks, setPicks] = useState<Picks>(() => TASTER_QUESTIONS.map(() => null));
  const [at, setAt] = useState(0);
  const [done, setDone] = useState(false);

  const question = TASTER_QUESTIONS[at]!;
  const picked = picks[at];
  const answered = picked !== null;
  const marks = tally(picks);
  const last = at === TASTER_QUESTIONS.length - 1;

  function choose(option: number) {
    if (answered) return;
    setPicks((current) => current.map((value, index) => (index === at ? option : value)));
  }

  function next() {
    if (last) setDone(true);
    else setAt(at + 1);
  }

  function restart() {
    setPicks(TASTER_QUESTIONS.map(() => null));
    setAt(0);
    setDone(false);
  }

  if (done) {
    const verdict = verdictFor(marks);
    const right = picks.filter((pick, index) => pick === TASTER_QUESTIONS[index]!.answer).length;
    return (
      <div className="taster taster--result">
        {marks >= CELEBRATE_AT ? <Celebration /> : null}
        <p className="taster__eyebrow">Your taster score</p>
        <p className="taster__score tnum">
          {marks}
          <span>/ {MAX_MARKS}</span>
        </p>
        <p className="taster__tally tnum">
          {right} right · {TASTER_QUESTIONS.length - right} wrong · marked +{MCQ_MARKS.correct} / {MCQ_MARKS.wrong}
        </p>
        <h3 className="taster__verdict">{verdict.title}</h3>
        <p className="taster__note">{verdict.note}</p>
        <div className="taster__actions">
          <a className="btn-sun" href="/register">
            Take the real paper
            <span className="btn-sun__arrow" aria-hidden="true"><ArrowIcon /></span>
          </a>
          <button type="button" className="taster__again" onClick={restart}>
            Go through them again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="taster">
      <div className="taster__head">
        <ol className="taster__rail" aria-label="Question progress">
          {TASTER_QUESTIONS.map((item, index) => {
            const state = picks[index] === null
              ? (index === at ? 'now' : 'todo')
              : (picks[index] === item.answer ? 'right' : 'wrong');
            return (
              <li
                key={item.id}
                className={`taster__pip taster__pip--${state}`}
                aria-current={index === at ? 'step' : undefined}
              >
                <span className="sr-only">{`Question ${index + 1}: ${state}`}</span>
              </li>
            );
          })}
        </ol>
        <p className="taster__marks tnum" aria-live="off">
          <span>marks so far</span>
          <b className={marks < 0 ? 'is-negative' : undefined}>
            {marks > 0 ? `+${marks}` : marks}
          </b>
        </p>
      </div>

      {/* Keyed on the question so React remounts the card and the entrance
          animation plays again for each one. */}
      <div className="taster__card" key={question.id}>
        <p className="taster__topic">
          <span>{question.topic}</span>
          <small>{TASTER_SOURCE}</small>
        </p>
        <p className="taster__prompt">{question.prompt}</p>

        <ul className="taster__options">
          {question.options.map((option, index) => {
            const isAnswer = index === question.answer;
            const chosen = picked === index;
            const className = [
              'taster__option',
              answered && isAnswer ? 'is-right' : '',
              answered && chosen && !isAnswer ? 'is-wrong' : '',
              answered && !chosen && !isAnswer ? 'is-dim' : '',
            ].filter(Boolean).join(' ');
            return (
              <li key={option}>
                <button
                  type="button"
                  className={className}
                  onClick={() => choose(index)}
                  aria-pressed={chosen}
                  aria-disabled={answered}
                >
                  <span className="taster__key" aria-hidden="true">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span className="taster__text">{option}</span>
                </button>
              </li>
            );
          })}
        </ul>

        {answered ? (
          <div className="taster__after" role="status">
            <p className={`taster__call ${picked === question.answer ? 'is-right' : 'is-wrong'}`}>
              {picked === question.answer
                ? `Correct. +${MCQ_MARKS.correct}.`
                : `Not this one. ${MCQ_MARKS.wrong} mark.`}
            </p>
            <p className="taster__why">{question.why}</p>
            <button type="button" className="taster__next" onClick={next}>
              {last ? 'See my score' : 'Next question'}
              <span className="taster__next-arrow" aria-hidden="true"><ArrowIcon /></span>
            </button>
          </div>
        ) : (
          <p className="taster__hint">Pick one. You will see the working straight away.</p>
        )}
      </div>
    </div>
  );
}
