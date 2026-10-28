'use client';

import { useEffect, useState } from 'react';
import { TEST_FEE_PAISE } from '@jee/shared/config';
import { ApiError, api, openCheckout, type RazorpayOrder } from '../../lib/api';
import { getProfile } from '../../lib/auth';
import { TEST_WHEN } from '../../lib/testDate';

/**
 * Register, pay, and check in.
 *
 * The page polls payment status after checkout closes rather than trusting the
 * checkout callback, because the webhook is what actually grants access and it
 * may land a second or two later.
 */

interface Status {
  testId: number;
  name: string;
  startsAt: number;
  lobbyOpensAt: number;
  paid: boolean;
  /** False while the test is on sale but the exam surface is not open yet. */
  examOpen: boolean;
  attempt: { id: string; status: string } | null;
}

const RUPEES = TEST_FEE_PAISE / 100;

export default function Register() {
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Null while unknown; false sends the student to step two. */
  const [profileComplete, setProfileComplete] = useState<boolean | null>(null);

  const refresh = async () => {
    try {
      setStatus(await api<Status>('/test/status'));
    } catch {
      setStatus(null);
    }
  };

  /**
   * Sign-in and sign-up used to live on this page behind a `mode` toggle. They
   * are now /login and /signup, and the profile fields are /complete-profile,
   * so this page is only the last step: pay, or see what you already have.
   *
   * An unauthenticated or unfinished student is sent back to the step they are
   * actually on, which is also what /payments/order enforces server-side.
   */
  useEffect(() => {
    void (async () => {
      const profile = await getProfile().catch(() => null);
      if (!profile) {
        window.location.href = '/login';
        return;
      }
      if (!profile.complete) {
        window.location.href = '/complete-profile';
        return;
      }
      setProfileComplete(true);
      await refresh();
    })();
  }, []);

  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    document.body.appendChild(script);
    return () => {
      script.remove();
    };
  }, []);

  async function pay() {
    setBusy(true);
    setMessage(null);
    try {
      const order = await api<RazorpayOrder>('/payments/order', { method: 'POST', body: '{}' });
      openCheckout(order, () => {
        // Poll: the webhook grants access, and it arrives independently of
        // whatever the checkout window told us.
        let tries = 0;
        const timer = setInterval(async () => {
          tries += 1;
          await refresh();
          const current = await api<Status>('/test/status').catch(() => null);
          if (current?.paid || tries > 20) {
            clearInterval(timer);
            setBusy(false);
            if (!current?.paid) {
              setMessage(
                'We have not had confirmation from the payment provider yet. If money has left '
                + 'your account, it will appear here within a few minutes — you do not need to pay again.',
              );
            }
          }
        }, 3_000);
      });
    } catch (error) {
      setBusy(false);
      setMessage(
        error instanceof ApiError ? error.message : 'We could not start the payment.',
      );
    }
  }

  const examUrl = process.env.NEXT_PUBLIC_EXAM_URL ?? 'http://localhost:5173';

  return (
    <main className="wrap" style={{ paddingTop: 48, paddingBottom: 64 }}>
      <h1 style={{ fontSize: '1.8rem', margin: '0 0 8px' }}>Register for the test</h1>
      <p className="prose" style={{ marginBottom: 28 }}>
        {status
          ? `${status.name} — starts ${new Date(status.startsAt).toLocaleString()}.`
          : `Create an account, pay ₹${RUPEES}, and you are in.`}
      </p>

      {message ? <div className="notice">{message}</div> : null}

      {/* Signed in and profile complete, but the status call has not landed:
          the redirect in the effect above owns every other case. */}
      {profileComplete === null || !status ? (
        <section className="panel">
          <p className="prose">Loading…</p>
        </section>
      ) : status.paid && !status.examOpen ? (
        /* Paid, but the inside is not open yet. The receipt comes first: a
           student who has just paid and is not handed a test needs to be told
           their money registered something before they are told to wait. */
        <section className="panel">
          <div className="notice notice--ok">
            Your payment is recorded and your place is held.
          </div>
          <p className="prose">
            The paper opens on <strong>{TEST_WHEN}</strong>. The waiting room opens thirty
            minutes before that, and we will email you the day before with the link and what to
            have ready — there is nothing for you to do until then.
          </p>
          <p className="prose" style={{ marginTop: 14 }}>
            Keep the email address you signed up with working. It is how we reach you if
            anything about the day changes.
          </p>
        </section>
      ) : status.paid ? (
        <section className="panel">
          <div className="notice notice--ok">You are registered for this test.</div>
          <p className="prose">
            The waiting room opens at{' '}
            <strong>{new Date(status.lobbyOpensAt).toLocaleString()}</strong>, thirty minutes
            before the start. Open it on the device you plan to sit the test on — it checks that
            your browser can save and send your answers while there is still time to fix
            anything.
          </p>
          <a className="btn" href={examUrl}>
            Open the waiting room
          </a>
        </section>
      ) : (
        <section className="panel">
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Pay ₹{RUPEES} and take your place</h2>
          <p className="prose">
            Registration closes the moment the test begins. Pay now so a payment problem on the
            day cannot keep you out.
          </p>
          <button className="btn" onClick={pay} disabled={busy}>
            {busy ? 'Working…' : `Pay ₹${RUPEES} and register`}
          </button>
        </section>
      )}
    </main>
  );
}
