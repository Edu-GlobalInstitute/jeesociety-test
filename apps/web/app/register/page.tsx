'use client';

import { useEffect, useState } from 'react';
import {
  DIAGNOSTIC, MENTORSHIP, PAPER, REWARD_BANDS, TEST_FEE_PAISE, WHATSAPP_COMMUNITY_URL,
} from '@jee/shared/config';
import { ApiError, api, openCheckout, type RazorpayOrder } from '../../lib/api';
import { getProfile } from '../../lib/auth';
import { TEST_WHEN } from '../../lib/testDate';
import './register.css';

/**
 * Register, pay, and check in.
 *
 * The page polls payment status after checkout closes rather than trusting the
 * checkout callback, because the webhook is what actually grants access and it
 * may land a second or two later.
 */

/**
 * The community invite, shown only after payment.
 *
 * Both paid states render this -- the one before the paper opens and the one
 * on exam day -- because a student who paid in November and a student arriving
 * on the morning are both people we want in the group, and a student who
 * dismissed it once has no other way back to it.
 *
 * Deliberate choices:
 *
 *   `target="_blank"` with `rel="noopener noreferrer"`. WhatsApp opens in its
 *   own app or tab; without this, a student on a phone leaves the registration
 *   page and loses the waiting-room link they were just given. noopener is not
 *   decoration -- without it the opened page gets a handle on this one through
 *   window.opener and can navigate it somewhere else.
 *
 *   It renders nothing when the URL is empty, so clearing the constant while
 *   rotating a link removes the button rather than shipping one that leads
 *   nowhere.
 *
 *   The wording says "follow the channel", not "join the community", because
 *   the destination is a broadcast channel: students receive updates there
 *   and cannot post or see each other. Promising a community and delivering
 *   a one-way feed is a small lie that costs trust on the first visit.
 *
 *   Secondary styling, not the gold button. On these screens the primary
 *   action is opening the waiting room; the community is an invitation, and
 *   two gold buttons would make a student guess which one registers them.
 */
function WhatsAppInvite() {
  if (!WHATSAPP_COMMUNITY_URL) return null;
  return (
    <div className="reg__community">
      <p className="reg__community-why">
        Follow the WhatsApp channel. Updates about the day, what to have ready, and
        the result announcement all go out here first.
      </p>
      <a
        className="reg__wa"
        href={WHATSAPP_COMMUNITY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <svg
          className="reg__wa-icon"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.87 9.87 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 18.15h-.01a8.23 8.23 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.38c0-4.54 3.7-8.23 8.25-8.23 2.2 0 4.27.86 5.83 2.41a8.19 8.19 0 0 1 2.41 5.83c0 4.54-3.7 8.23-8.24 8.23Zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.14.16-.29.18-.53.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.47-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.1-.22-.17-.47-.29Z"
          />
        </svg>
        Follow the WhatsApp channel
      </a>
    </div>
  );
}

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

/** Paise to the rupee string every line on this card is written in. */
const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

export default function Register() {
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Null while unknown; false sends the student to step two. */
  const [profileComplete, setProfileComplete] = useState<boolean | null>(null);
  /** Kept so Razorpay's screen can be prefilled with what we already asked for. */
  const [prefill, setPrefill] = useState<{ name?: string | null; email?: string | null; contact?: string | null }>({});
  const [couponCode, setCouponCode] = useState('');
  const [couponQuote, setCouponQuote] = useState<{ code: string; name: string; discountPaise: number; amount: number } | null>(null);

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
      setPrefill({
        name: profile.name ?? null,
        email: profile.email ?? null,
        contact: profile.profile?.phone ?? null,
      });
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
      const order = await api<RazorpayOrder & { free?: boolean }>('/payments/order', {
        method: 'POST', body: JSON.stringify(couponQuote ? { couponCode: couponQuote.code } : {}),
      });
      if (order.free) {
        await refresh();
        setBusy(false);
        setMessage('Your coupon covers the full price. Your registration is confirmed.');
        return;
      }
      openCheckout(
        order,
        (outcome) => {
          if (outcome === 'unavailable') {
            setBusy(false);
            setMessage(
              'The payment window could not open. Check that nothing is blocking scripts from '
              + 'razorpay.com, then try again. Nothing has been charged.',
            );
            return;
          }
          if (outcome === 'dismissed') {
            // They closed the window. Nothing is coming, so do not leave them
            // watching a spinner that resolves into a message about money.
            setBusy(false);
            setMessage('Payment cancelled. Nothing has been charged — you can try again whenever you are ready.');
            return;
          }

          /*
           * A payment was submitted. Access is granted by the webhook, which
           * arrives independently of this browser, so poll until it lands.
           *
           * Two minutes, not one. Razorpay usually calls within seconds, but a
           * retry or a slow bank pushes it past a minute, and the old window
           * gave up at sixty seconds -- telling a student who had genuinely
           * paid that confirmation had not arrived. Easing the interval keeps
           * the common case fast without hammering the API for the whole wait.
           */
          setMessage('Confirming your payment…');
          let waited = 0;
          const deadlineMs = 120_000;

          const poll = async () => {
            await refresh();
            const current = await api<Status>('/test/status').catch(() => null);
            if (current?.paid) {
              setBusy(false);
              setMessage('Payment confirmed. Your seat is booked.');
              return;
            }
            if (waited >= deadlineMs) {
              setBusy(false);
              setMessage(
                'We have not had confirmation from the payment provider yet. If money has left '
                + 'your account it will appear here shortly, and you do not need to pay again. '
                + 'This page updates on its own if you leave it open.',
              );
              return;
            }
            const next = waited < 30_000 ? 3_000 : 8_000;
            waited += next;
            window.setTimeout(() => void poll(), next);
          };
          void poll();
        },
        prefill,
      );
    } catch (error) {
      setBusy(false);
      setMessage(
        error instanceof ApiError ? error.message : 'We could not start the payment.',
      );
    }
  }

  async function applyCoupon() {
    setMessage(null);
    setCouponQuote(null);
    const code = couponCode.trim().toUpperCase();
    if (!code) return;
    try {
      const quote = await api<{ code: string; name: string; discountPaise: number; amount: number }>(
        '/payments/coupon/quote', { method: 'POST', body: JSON.stringify({ code }) },
      );
      setCouponQuote(quote);
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Could not apply that coupon.');
    }
  }

  const examUrl = process.env.NEXT_PUBLIC_EXAM_URL ?? 'http://localhost:5173';

  return (
    <main className="reg">
      <div className="reg__card">
        <p className="reg__step">Last step</p>

        {/* The reason, before the bill. A student who has got this far has
            already read the landing page; what they need here is the one
            sentence that says why today and not later. */}
        <h1 className="reg__title">
          {status?.paid
            ? 'Your place is held. Now keep the date.'
            : (
              <>
                Your last chance to score <em>99%ile</em> in the January attempt.
              </>
            )}
        </h1>

        {/* The test's own name and start time, straight from the server, so
            this line cannot drift from the paper that is actually being sold. */}
        <p className="reg__when">
          <span className="reg__when-dot" aria-hidden="true" />
          <span>
            {status
              ? `${status.name}: starts ${new Date(status.startsAt).toLocaleString()}.`
              : `Create an account, pay ₹${RUPEES}, and you are in.`}
          </span>
        </p>

        {message ? <div className="notice">{message}</div> : null}

        {/* Signed in and profile complete, but the status call has not landed:
            the redirect in the effect above owns every other case. */}
        {profileComplete === null || !status ? (
          <section className="reg__panel">
            <p className="prose">Loading…</p>
          </section>
        ) : status.paid && !status.examOpen ? (
          /* Paid, but the inside is not open yet. The receipt comes first: a
             student who has just paid and is not handed a test needs to be told
             their money registered something before they are told to wait. */
          <section className="reg__panel">
            <p className="reg__done">
              <span className="reg__tick" aria-hidden="true">✓</span>
              Payment recorded, place held
            </p>
            <p className="prose">
              The paper opens on <strong>{TEST_WHEN}</strong>. The waiting room opens thirty
              minutes before that, and we will email you the day before with the link and what to
              have ready. There is nothing for you to do until then.
            </p>
            <p className="prose" style={{ marginTop: 14 }}>
              Keep the email address you signed up with working. It is how we reach you if
              anything about the day changes.
            </p>
            <WhatsAppInvite />
          </section>
        ) : status.paid ? (
          <section className="reg__panel">
            <p className="reg__done">
              <span className="reg__tick" aria-hidden="true">✓</span>
              You are registered for this test
            </p>
            <p className="prose">
              Open the waiting room on the device you plan to sit the test on. It checks that
              your browser can save and send your answers while there is still time to fix
              anything.
            </p>
            <dl className="reg__wait">
              <dt>Waiting room opens</dt>
              <dd>{new Date(status.lobbyOpensAt).toLocaleString()}</dd>
            </dl>
            <a className="btn btn--mark reg__pay reg__open" href={examUrl}>
              Open the waiting room
            </a>
            <WhatsAppInvite />
          </section>
        ) : (
          <section className="reg__panel">
            {/* What the fee buys, priced, before it is asked for. */}
            <div className="reg__item">
              <h2 className="reg__item-name">
                JEE Main full paper + report + IITian workshops
              </h2>
              <span className="reg__item-price tnum">{money(TEST_FEE_PAISE)}</span>
            </div>

            <ul className="reg__includes">
              <li>
                <span className="reg__tick" aria-hidden="true">✓</span>
                <span>
                  A full <b>{PAPER.maxMarks}-mark</b> paper, 3 hours, on the JEE Main
                  pattern, with your score and your percentile among everyone who sits it.
                </span>
              </li>
              <li>
                <span className="reg__tick" aria-hidden="true">✓</span>
                <span>
                  A personalised report showing where your{' '}
                  <b>+{DIAGNOSTIC.liftMarks} marks</b> are hiding: the chapters bleeding
                  marks, the mistakes you repeat, the minutes you burn.
                </span>
              </li>
              <li>
                <span className="reg__tick" aria-hidden="true">✓</span>
                <span>
                  Live workshops where <b>an {DIAGNOSTIC.webinarHost}</b> takes you through
                  your report and the way they analyse their own tests.
                </span>
              </li>
            </ul>

            <div className="reg__coupon">
              {couponQuote ? (
                <div className="reg__coupon-on" role="status">
                  <span className="reg__tick" aria-hidden="true">✓</span>
                  <span className="reg__coupon-code">{couponQuote.code}</span>
                  <span className="reg__coupon-off tnum">
                    &minus;{money(couponQuote.discountPaise)}
                  </span>
                  <button
                    type="button"
                    className="reg__coupon-drop"
                    onClick={() => { setCouponQuote(null); setCouponCode(''); }}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <label className="reg__coupon-label" htmlFor="coupon">
                    Have a coupon?
                  </label>
                  {/* One control, not two: the field and its button share a
                      border and a focus ring (register.css). */}
                  <div className="reg__coupon-row">
                    <input
                      id="coupon"
                      value={couponCode}
                      onChange={(event) => {
                        setCouponCode(event.target.value.toUpperCase());
                        setCouponQuote(null);
                      }}
                      maxLength={32}
                      autoComplete="off"
                      placeholder="Enter code"
                    />
                    <button
                      className="reg__coupon-apply"
                      type="button"
                      onClick={applyCoupon}
                      disabled={!couponCode.trim() || busy}
                    >
                      Apply
                    </button>
                  </div>
                </>
              )}
            </div>

            <dl className="reg__sums">
              <div className="reg__sum">
                <dt>Registration fee</dt>
                <dd className="tnum">{money(TEST_FEE_PAISE)}</dd>
              </div>
              {couponQuote ? (
                <div className="reg__sum reg__sum--off">
                  <dt>{couponQuote.name}</dt>
                  <dd className="tnum">&minus;{money(couponQuote.discountPaise)}</dd>
                </div>
              ) : null}
              <div className="reg__sum reg__sum--total">
                <dt>You pay</dt>
                <dd>
                  {/* The old price stays beside the new one: a number that
                      simply changed would not show the discount. */}
                  {couponQuote ? <s className="tnum">{money(TEST_FEE_PAISE)}</s> : null}
                  <strong className="tnum">
                    {money(couponQuote?.amount ?? TEST_FEE_PAISE)}
                  </strong>
                </dd>
              </div>
            </dl>

            <button className="btn btn--mark reg__pay" onClick={pay} disabled={busy}>
              {busy
                ? 'Working…'
                : `Pay ${money(couponQuote?.amount ?? TEST_FEE_PAISE)} and take your seat`}
            </button>

            <p className="reg__fine">
              Registration closes the moment the test begins. Pay now so a payment problem on
              the day cannot keep you out.
            </p>
            <p className="reg__secure">Payment is handled by Razorpay.</p>
          </section>
        )}

        {/* What the rank is worth, last, and only while there is still
            something to buy. */}
        {status && !status.paid ? (
          <p className="reg__prize">
            Finish in the <b>{REWARD_BANDS[0].share}</b> on this paper and you get{' '}
            <b>{REWARD_BANDS[0].label}</b> with {MENTORSHIP.mentors}. A seat on that
            programme costs ₹{MENTORSHIP.worthRupees.toLocaleString('en-IN')}.
          </p>
        ) : null}
      </div>
    </main>
  );
}
