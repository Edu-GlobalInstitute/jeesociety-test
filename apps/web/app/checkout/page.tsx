'use client';

import { useState } from 'react';
import { DIAGNOSTIC, PAPER } from '@jee/shared/config';
import {
  COUPON_PRICE,
  COUPON_SAVING,
  LIST_PRICE,
  isCoupon,
} from '../../lib/pricing';
import { TEST_WHEN } from '../../lib/testDate';
import '../auth.css';
import './checkout.css';

/**
 * The checkout box.
 *
 * The landing page's one button lands here, and this page's only job is to
 * show what the test costs and let a coupon knock it down before the student
 * pays. It is front end only: nothing is sent anywhere, and "Pay" ends in a
 * placeholder rather than an order. The real payment route lives on /register
 * and is untouched.
 *
 * The coupon is deliberately a separate, small affordance rather than a field
 * in the middle of the form: a student who has a code goes looking for it, and
 * a student who does not should not be made to feel they are missing one.
 */

type CouponState =
  | { kind: 'none' }
  | { kind: 'applied' }
  | { kind: 'error'; message: string };

export default function Checkout() {
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<CouponState>({ kind: 'none' });
  const [paying, setPaying] = useState(false);

  const applied = coupon.kind === 'applied';
  const total = applied ? COUPON_PRICE : LIST_PRICE;

  function apply(event: React.FormEvent) {
    event.preventDefault();
    if (!code.trim()) {
      setCoupon({ kind: 'error', message: 'Enter a coupon code first.' });
      return;
    }
    if (isCoupon(code)) {
      setCoupon({ kind: 'applied' });
      return;
    }
    setCoupon({ kind: 'error', message: `“${code.trim()}” is not a valid coupon.` });
  }

  function remove() {
    setCoupon({ kind: 'none' });
    setCode('');
  }

  return (
    <main className="checkout">
      <div className="checkout__card">
        <h1 className="auth__title">Checkout</h1>
        <p className="auth__sub">
          One payment, nothing after it. {TEST_WHEN}.
        </p>

        <section className="auth__panel">
          {/* ── What is being bought ──────────────────────────────────── */}
          <div className="checkout__item">
            <div>
              <h2 className="checkout__item-name">JEE Main full paper + report</h2>
              <p className="checkout__item-note">
                {PAPER.maxMarks}-mark paper, an all-India rank, and a report showing where
                your {DIAGNOSTIC.liftMarks} marks are hiding.
              </p>
            </div>
            <span className="checkout__item-price tnum">₹{LIST_PRICE}</span>
          </div>

          {/* ── The coupon ────────────────────────────────────────────── */}
          {applied ? (
            <div className="checkout__coupon-on">
              <span className="checkout__tick" aria-hidden="true">✓</span>
              <span>
                Coupon applied — <b>₹{COUPON_SAVING} off</b>
              </span>
              <button type="button" className="link-button" onClick={remove}>
                Remove
              </button>
            </div>
          ) : (
            <form className="checkout__coupon" onSubmit={apply} noValidate>
              <div className="field">
                <label htmlFor="coupon">Have a coupon?</label>
                <div className="checkout__coupon-row">
                  <input
                    id="coupon"
                    name="coupon"
                    value={code}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    placeholder="Enter code"
                    aria-invalid={coupon.kind === 'error'}
                    aria-describedby={coupon.kind === 'error' ? 'coupon-error' : undefined}
                    onChange={(event) => {
                      setCode(event.target.value);
                      if (coupon.kind === 'error') setCoupon({ kind: 'none' });
                    }}
                  />
                  <button type="submit" className="btn btn--ghost btn--small">
                    Apply
                  </button>
                </div>
                {coupon.kind === 'error' ? (
                  <p className="field__error" id="coupon-error" role="alert">
                    {coupon.message}
                  </p>
                ) : null}
              </div>
            </form>
          )}

          {/* ── The arithmetic ────────────────────────────────────────── */}
          <dl className="checkout__sums">
            <div className="checkout__sum">
              <dt>Test fee</dt>
              <dd className="tnum">₹{LIST_PRICE}</dd>
            </div>
            {applied ? (
              <div className="checkout__sum checkout__sum--off">
                <dt>Coupon discount</dt>
                <dd className="tnum">−₹{COUPON_SAVING}</dd>
              </div>
            ) : null}
            <div className="checkout__sum checkout__sum--total">
              <dt>Total</dt>
              <dd className="tnum">
                {applied ? <s>₹{LIST_PRICE}</s> : null}
                <strong>₹{total}</strong>
              </dd>
            </div>
          </dl>

          <button
            type="button"
            className="btn btn--mark auth__submit"
            disabled={paying}
            onClick={() => setPaying(true)}
          >
            {paying ? 'Opening payment…' : `Pay ₹${total}`}
          </button>

          {paying ? (
            <p className="checkout__stub" role="status">
              Payment is not connected yet — this screen is the front end only.
            </p>
          ) : null}
        </section>

        <p className="auth__fine">
          Only for students scoring under {DIAGNOSTIC.entryCeilingMarks} of {PAPER.maxMarks}.
          One payment, no renewals, nothing more to pay later.
        </p>
      </div>
    </main>
  );
}
