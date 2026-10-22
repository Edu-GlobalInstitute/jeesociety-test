'use client';

import { useEffect, useState } from 'react';
import { ApiError, api, openCheckout, type RazorpayOrder } from '../../lib/api';

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
  attempt: { id: string; status: string } | null;
}

export default function Register() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-up');
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await api<Status>('/test/status'));
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void refresh();
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

  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/auth/${mode === 'sign-up' ? 'sign-up' : 'sign-in'}/email`, {
        method: 'POST',
        body: JSON.stringify(
          mode === 'sign-up' ? { email, password, name } : { email, password },
        ),
      });
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? error.message
          : 'We could not sign you in. Check your details and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

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
          : 'Create an account, pay the entry fee, and you are in.'}
      </p>

      {message ? <div className="notice">{message}</div> : null}

      {!status ? (
        <section className="panel">
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}>
            {mode === 'sign-up' ? 'Create your account' : 'Sign in'}
          </h2>
          <form onSubmit={authenticate}>
            {mode === 'sign-up' ? (
              <div className="field">
                <label htmlFor="name">Your name</label>
                <input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
                minLength={8}
                required
              />
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {mode === 'sign-up' ? 'Create account' : 'Sign in'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ marginLeft: 10 }}
              onClick={() => setMode(mode === 'sign-up' ? 'sign-in' : 'sign-up')}
            >
              {mode === 'sign-up' ? 'I already have an account' : 'Create an account instead'}
            </button>
          </form>
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
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Pay the entry fee</h2>
          <p className="prose">
            Registration closes the moment the test begins. Pay now so a payment problem on the
            day cannot keep you out.
          </p>
          <button className="btn" onClick={pay} disabled={busy}>
            {busy ? 'Working…' : 'Pay and register'}
          </button>
        </section>
      )}
    </main>
  );
}
