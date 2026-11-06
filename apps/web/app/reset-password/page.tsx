'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import '../auth.css';
import { ApiError, api } from '../../lib/api';

/**
 * Set a new password, from the link in the email.
 *
 * The token arrives as ?token=... — Better Auth appends it to the redirectTo
 * we asked for. It is read in an effect rather than during render because
 * this page is statically exported: at build time there is no URL to read,
 * and touching window during render would break the prerender.
 *
 * On success the student is sent to /login rather than being signed in here.
 * Someone who just proved control of the inbox still has to type the new
 * password once, which catches a typo immediately instead of at the next
 * visit — and on exam morning there is no time to discover it then.
 */

/** Must match minPasswordLength in the API's Better Auth config. */
const MIN_PASSWORD = 8;

export default function ResetPassword() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get('token');
    setToken(found && found.length > 0 ? found : null);
    setReady(true);
  }, []);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !token) return;

    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword: password, token }),
      });
      setDone(true);
    } catch (caught) {
      /*
       * The common failure is a token that has expired or been used, and the
       * student's next move is the same either way: ask for a fresh link. So
       * say that, with the link, rather than reporting a status code.
       */
      setError(
        caught instanceof ApiError && (caught.status === 400 || caught.status === 401)
          ? 'This link has expired or has already been used. Ask for a new one below.'
          : 'We could not set your password. Check your connection and try again.',
      );
      setBusy(false);
    }
  }

  // Nothing is rendered until the token has been read, so the "broken link"
  // panel never flashes at a student whose link is perfectly good.
  if (!ready) {
    return (
      <main className="auth">
        <div className="auth__card"><p className="prose">Loading…</p></div>
      </main>
    );
  }

  if (done) {
    return (
      <main className="auth">
        <div className="auth__card">
          <h1 className="auth__title">Password changed</h1>
          <p className="auth__sub">You can sign in with your new password now.</p>
          <Link className="btn btn--mark auth__submit" href="/login/">Go to sign in</Link>
        </div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="auth">
        <div className="auth__card">
          <h1 className="auth__title">This link is not complete</h1>
          <p className="auth__sub">
            The reset link was missing its code. That usually means the email client
            broke the address across two lines when you copied it.
          </p>
          <Link className="btn btn--mark auth__submit" href="/forgot-password/">
            Send a new link
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__title">Set a new password</h1>
        <p className="auth__sub">At least {MIN_PASSWORD} characters.</p>

        {error ? <div className="notice" role="alert">{error}</div> : null}

        <form onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="rp-new">New password</label>
            <input
              id="rp-new"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              /*
               * new-password, not current-password: it tells a password
               * manager to offer a generated one and to save what is typed,
               * rather than autofilling the password being replaced.
               */
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              autoFocus
              required
            />
          </div>

          <div className="field">
            <label htmlFor="rp-confirm">Confirm new password</label>
            <input
              id="rp-confirm"
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              required
            />
          </div>

          <p className="auth__alt">
            <button
              type="button"
              className="link-button"
              onClick={() => setShow((v) => !v)}
              aria-pressed={show}
            >
              {show ? 'Hide passwords' : 'Show passwords'}
            </button>
          </p>

          <button
            className="btn btn--mark auth__submit"
            type="submit"
            disabled={busy || !password || !confirm}
          >
            {busy ? 'Saving…' : 'Save new password'}
          </button>
        </form>

        {error ? (
          <p className="auth__alt">
            <Link href="/forgot-password/">Send a new link</Link>
          </p>
        ) : null}
      </div>
    </main>
  );
}
