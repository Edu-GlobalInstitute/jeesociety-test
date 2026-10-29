'use client';

import { useEffect, useState } from 'react';
import '../auth.css';
import { ApiError } from '../../lib/api';
import { getProfile, nextStepFor, signIn } from '../../lib/auth';
import { GoogleButton } from '../../components/GoogleButton';

/**
 * Sign in.
 *
 * Split out of /register, which used to be account-creation and payment in one
 * page with a `mode` toggle. A student coming back a week later to check their
 * admit card should not land on a page headed "Register for the test", and a
 * returning student is the common case once registration has been open a while.
 *
 * Where it sends them is decided by nextStepFor(), shared with /signup and the
 * OAuth landing page, so the three cannot disagree about whether a profile is
 * finished.
 */
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  // A student who is already signed in should not be shown a sign-in form.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const profile = await getProfile();
        if (live && profile) window.location.href = nextStepFor(profile);
        else if (live) setChecking(false);
      } catch {
        if (live) setChecking(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn(email, password);
      if (result.twoFactorRedirect) {
        window.location.href = '/two-factor';
        return;
      }
      window.location.href = nextStepFor(await getProfile());
    } catch (caught) {
      setBusy(false);
      if (caught instanceof ApiError && caught.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
        return;
      }
      /*
       * One message for a wrong password and for an address with no account.
       * Distinguishing them turns this form into a way to find out who has
       * registered, and the student's next move is the same either way.
       */
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That email and password do not match an account.'
          : 'We could not sign you in. Check your details and try again.',
      );
    }
  }

  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__title">Sign in</h1>
        <p className="auth__sub">
          Your registration, admit card and result all live behind this.
        </p>

        <div className="auth__panel">
          <GoogleButton next="/register" disabled={busy || checking} label="Sign in with Google" />

          <div className="auth__or">or</div>

          {error ? (
            <div className="notice" role="alert">
              {error}
            </div>
          ) : null}

          <form onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus
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
                autoComplete="current-password"
                required
              />
            </div>

            <button className="btn btn--mark auth__submit" type="submit" disabled={busy || checking}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="auth__alt">
            New here? <a href="/signup">Create an account</a>
          </p>
        </div>

        <p className="auth__fine">
          Signed up with Google? Use the Google button — an account created that way has no
          password to type.
        </p>
      </div>
    </main>
  );
}
