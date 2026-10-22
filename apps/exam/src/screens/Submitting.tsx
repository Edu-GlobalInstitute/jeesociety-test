/**
 * The screens after the student presses submit, or the timer reaches zero.
 *
 * The wording here is the most carefully chosen in the app. A failed submit is
 * genuinely harmless — the last sync is on the server and auto-submit finalises
 * the attempt ten minutes after the window closes — so the copy says so plainly
 * rather than implying the student has lost anything.
 */

export interface SubmittingProps {
  attemptNumber: number;
  jitterSeconds: number;
}

export function Submitting({ attemptNumber, jitterSeconds }: SubmittingProps) {
  return (
    <main className="page">
      <h1 className="page__title">Submitting your test</h1>
      <p className="page__lede">
        {attemptNumber <= 1
          ? `Sending your answers. This takes up to ${jitterSeconds} seconds — everyone submits at once, so we spread it out.`
          : 'Still sending. Your answers are saved; we are completing your submission.'}
      </p>
      <section className="panel">
        <p className="muted" style={{ margin: 0 }}>
          Do not close this tab yet. If it closes anyway, your answers are already with us and
          your test will be completed automatically.
        </p>
      </section>
    </main>
  );
}

export interface SubmittedProps {
  receipt: string;
  answered: number;
  total: number;
}

export function Submitted({ receipt, answered, total }: SubmittedProps) {
  return (
    <main className="page">
      <h1 className="page__title">Your test is submitted</h1>
      <p className="page__lede">
        You answered {answered} of {total} questions. Objective results are published tomorrow,
        and final ranks within six days.
      </p>
      <section className="panel">
        <h2 className="panel__title">Your receipt</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Keep this. Quote it if you ever need to ask us about this test.
        </p>
        <p className="receipt tnum">{receipt}</p>
      </section>
      <p className="muted" style={{ marginTop: 20 }}>
        You can close this tab now.
      </p>
    </main>
  );
}

export interface SubmitPendingProps {
  answered: number;
  total: number;
}

/**
 * Shown when every submit attempt failed. This is not an error state from the
 * student's point of view, and it does not read like one.
 */
export function SubmitPending({ answered, total }: SubmitPendingProps) {
  return (
    <main className="page">
      <h1 className="page__title">Your answers are saved</h1>
      <p className="page__lede">
        We are completing your submission. You answered {answered} of {total} questions, and all
        of them are with us.
      </p>
      <section className="panel">
        <p className="muted" style={{ margin: 0 }}>
          Your connection dropped before we could confirm your submission, so we are finishing it
          on our side. Nothing more is needed from you, and nothing has been lost. Results arrive
          on the same schedule as everyone else&rsquo;s.
        </p>
      </section>
    </main>
  );
}
