import type { TestStatusResponse } from '@jee/shared';

/**
 * What a student sees while the test is sold but the inside is not open yet.
 *
 * Two things this screen must do, in order of importance. First, reassure: a
 * student who has just paid ₹300 and lands on a page that is not the test needs
 * to be told, in the first sentence, that their payment is recorded and their
 * place is held. Second, tell them when to come back, and that they will be
 * emailed rather than having to keep checking.
 *
 * What it deliberately does not do is look like an error. There is no notice
 * box and no warning colour — nothing has gone wrong, the paper simply is not
 * open yet, and this is the expected view for the weeks between paying and
 * sitting.
 */

/** The public site owns registration and payment; this app only links to it. */
const WEB_URL = import.meta.env.VITE_WEB_URL ?? 'http://localhost:3001';

export interface ComingSoonProps {
  status: TestStatusResponse;
}

export function ComingSoon({ status }: ComingSoonProps) {
  const starts = new Date(status.startsAt);

  return (
    <main className="page">
      <img className="page__logo" src="/logo.jpeg" alt="JEE PENULTIMATE" width={44} height={44} />
      <h1 className="page__title">{status.name}</h1>
      <p className="page__lede">
        {status.paid
          ? 'Your place is booked. The test opens on the morning of the paper — this page will let you in when it does.'
          : 'This test is not open yet. You can register on the main site in the meantime.'}
      </p>

      <section className="panel">
        <h2 className="panel__title">When</h2>
        <p className="muted" style={{ margin: '0 0 10px' }}>
          {starts.toLocaleString()} · 3 hours · 75 questions
        </p>
        <p className="muted" style={{ margin: 0 }}>
          The waiting room opens thirty minutes before that, at{' '}
          {new Date(status.lobbyOpensAt).toLocaleTimeString()}. We will email you the day before
          with the link and what to have ready.
        </p>
      </section>

      <section className="panel">
        <h2 className="panel__title">
          {status.paid ? 'Nothing to do until then' : 'Not registered yet'}
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          {status.paid
            ? 'You do not need to keep this tab open or check back. Come to this page on the day of the paper, on the device you plan to sit it on.'
            : 'Registration closes when the test begins. Pay beforehand so a payment problem on the day cannot keep you out.'}
        </p>
        {!status.paid ? (
          <a
            className="btn btn--primary"
            style={{ marginTop: 16 }}
            href={`${WEB_URL}/register`}
          >
            Register for the test
          </a>
        ) : null}
      </section>
    </main>
  );
}
