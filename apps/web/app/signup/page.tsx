'use client';

import { useEffect, useState } from 'react';
import { TEST_FEE_PAISE } from '@jee/shared/config';
import '../auth.css';
import { ApiError } from '../../lib/api';
import { getProfile, nextStepFor, signUp } from '../../lib/auth';
import { GoogleButton } from '../../components/GoogleButton';
import { TEST_WHEN } from '../../lib/testDate';

/**
 * Create an account — step one of three.
 *
 * Only what Better Auth needs to exist: a name, an address, a password. The
 * phone number, class and guardian consent are step two (/complete-profile),
 * because Google sign-in cannot supply them and one profile form serving both
 * routes in beats two that drift apart.
 *
 * Splitting it this way also shortens the first screen a student meets after
 * deciding to spend ₹300, which is the screen most likely to be abandoned.
 */
const RUPEES = TEST_FEE_PAISE / 100;

export default function SignUp() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ password?: string }>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

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

    // Checked here as well as by the server so the student is told before the
    // round trip, not after it.
    if (password.length < 8) {
      setFieldError({ password: 'Use at least 8 characters.' });
      return;
    }
    setFieldError({});
    setBusy(true);
    setError(null);

    try {
      await signUp({ name: name.trim(), email: email.trim(), password });
      // Straight to step two. The account exists but cannot pay yet.
      window.location.href = '/complete-profile';
    } catch (caught) {
      setBusy(false);
      if (caught instanceof ApiError && caught.status === 429) {
        setError('Too many attempts. Wait a minute and try again.');
        return;
      }
      /*
       * Better Auth returns a 422 for an address that already exists. Saying so
       * is the right trade here: this is a sign-up form, the address is one the
       * student just typed about themselves, and the alternative is a dead end
       * where the obvious next move — signing in — is never suggested.
       */
      if (caught instanceof ApiError && (caught.status === 422 || caught.status === 400)) {
        setError('An account already uses that email. Sign in instead.');
        return;
      }
      setError('We could not create your account. Try again in a moment.');
    }
  }

  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__title">Create your account</h1>
        <p className="auth__sub">
          Three short steps: your account, your details, then ₹{RUPEES}. The paper opens{' '}
          {TEST_WHEN}.
        </p>

        <p className="auth__steps">
          <span className="auth__step auth__step--now">
            <b>1</b> Account
          </span>
          <span aria-hidden="true">→</span>
          <span className="auth__step">
            <b>2</b> Your details
          </span>
          <span aria-hidden="true">→</span>
          <span className="auth__step">
            <b>3</b> Pay
          </span>
        </p>

        <div className="auth__panel">
          <GoogleButton next="/register" disabled={busy || checking} label="Sign up with Google" />

          <div className="auth__or">or</div>

          {error ? (
            <div className="notice" role="alert">
              {error}
              {error.includes('Sign in instead') ? (
                <>
                  {' '}
                  <a href="/login">Go to sign in</a>.
                </>
              ) : null}
            </div>
          ) : null}

          <form onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="name">Your full name</label>
              <input
                id="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                placeholder="As it should appear on your admit card"
                required
              />
            </div>

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
              <span className="field__hint">
                Your admit card and result go here. Use an address you will still read in a
                month.
              </span>
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                aria-invalid={fieldError.password ? 'true' : undefined}
                aria-describedby={fieldError.password ? 'password-error' : undefined}
                required
              />
              {fieldError.password ? (
                <span className="field__error" id="password-error">
                  {fieldError.password}
                </span>
              ) : (
                <span className="field__hint">At least 8 characters.</span>
              )}
            </div>

            <button className="btn btn--mark auth__submit" type="submit" disabled={busy || checking}>
              {busy ? 'Creating your account…' : 'Create account'}
            </button>
          </form>

          <p className="auth__alt">
            Already registered? <a href="/login">Sign in</a>
          </p>
        </div>

        <p className="auth__fine">
          Creating an account does not reserve a place — payment does. Nothing is charged on this
          screen.
        </p>
      </div>
    </main>
  );
}
