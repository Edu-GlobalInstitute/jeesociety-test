'use client';

import { useState } from 'react';
import Link from 'next/link';
import '../auth.css';
import { api } from '../../lib/api';

/**
 * Ask for a reset link.
 *
 * The one rule that shapes this whole page: it answers identically whether or
 * not the address has an account. A form that says "no account with that
 * email" is a way for anyone to find out who has registered — and for a
 * scholarship test being marketed to thousands of students, that list has
 * value to the wrong people. So the success panel says a link has been sent
 * *if* an account exists, and nothing distinguishes the two cases, including
 * how long the request takes.
 *
 * Better Auth's /auth/forget-password already behaves this way; this page
 * must not undo it by reporting an error the server did not give.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      await api('/auth/forget-password', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          // Where the link lands. Better Auth appends ?token=... to this.
          redirectTo: `${window.location.origin}/reset-password/`,
        }),
      });
      setSent(true);
    } catch {
      /*
       * Deliberately not surfaced as "that address is not registered", which
       * the server never says either. The only errors a student can act on
       * here are their own connection, so that is what this names.
       */
      setError('We could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="auth">
        <div className="auth__card">
          <h1 className="auth__title">Check your email</h1>
          <p className="auth__sub">
            If an account exists for <strong>{email.trim()}</strong>, a link to set a new
            password is on its way. It works for one hour.
          </p>
          <div className="auth__panel">
            <p className="prose">
              The email can take a minute to arrive, and it does sometimes land in spam or
              promotions. Look for <strong>“Reset your JEE Society password”</strong>.
            </p>
            <p className="prose" style={{ marginTop: 12 }}>
              Nothing has changed on your account yet. Your old password still works until
              you set a new one.
            </p>
          </div>
          <p className="auth__alt">
            <Link href="/login/">Back to sign in</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__title">Forgot your password?</h1>
        <p className="auth__sub">
          Enter the email you registered with and we will send a link to set a new one.
        </p>

        {error ? <div className="notice" role="alert">{error}</div> : null}

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="fp-email">Email</label>
            <input
              id="fp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
              required
            />
          </div>

          <button
            className="btn btn--mark auth__submit"
            type="submit"
            disabled={busy || !email}
          >
            {busy ? 'Sending…' : 'Send the reset link'}
          </button>
        </form>

        <p className="auth__alt">
          Remembered it? <Link href="/login/">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
