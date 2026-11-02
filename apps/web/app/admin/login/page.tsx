'use client';

import { useEffect, useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import { getProfile, signIn, signOut } from '../../../lib/auth';
import '../../auth.css';

const ADMIN_EMAIL = 'jeesocietydev@gmail.com';

interface Standing {
  isAdmin: boolean;
  allowed: boolean;
}

function adminDestination(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || next.length > 2048) return '/admin';

  try {
    const target = new URL(next, window.location.origin);
    const path = target.pathname.replace(/\/+$/, '');
    const isAdminPage = path === '/admin' || path.startsWith('/admin/');
    if (
      target.origin === window.location.origin
      && isAdminPage
      && path !== '/admin/login'
    ) {
      return `${target.pathname}${target.search}${target.hash}`;
    }
  } catch {
    // Ignore malformed return paths and send the admin to the dashboard.
  }
  return '/admin';
}

export default function AdminLoginPage() {
  const [mode, setMode] = useState<'sign-in' | 'setup'>('sign-in');
  const [email, setEmail] = useState(ADMIN_EMAIL);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getProfile()
      .then(async (profile) => {
        if (!live) return;
        if (!profile) return;
        try {
          const standing = await api<Standing>('/admin-security/standing');
          if (!live) return;
          if (!standing.isAdmin) {
            await signOut();
            setError('This account does not have admin access.');
          } else {
            window.location.replace(standing.allowed ? adminDestination() : '/admin/security');
          }
        } catch {
          if (live) {
            setError('Could not check admin access. You can still sign in below.');
          }
        }
      })
      .catch(() => {
        if (live) setError('Could not check the current session. You can still sign in below.');
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void api<{ available: boolean }>('/admin-bootstrap/status')
      .then((status) => {
        if (live) setSetupAvailable(status.available);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    let credentialsAccepted = false;
    try {
      if (mode === 'setup') {
        if (password !== confirmPassword) {
          setBusy(false);
          setError('The passwords do not match.');
          return;
        }
        await api('/admin-bootstrap/setup', {
          method: 'POST',
          body: JSON.stringify({ setupCode, password, confirmPassword }),
        });
        await signIn(ADMIN_EMAIL, password);
        window.location.href = '/admin/security';
        return;
      }

      const result = await signIn(email.trim(), password);
      credentialsAccepted = true;
      if (result.twoFactorRedirect) {
        window.location.href = `/two-factor?next=${encodeURIComponent(adminDestination())}`;
        return;
      }
      const standing = await api<Standing>('/admin-security/standing');
      if (!standing.isAdmin) {
        await signOut();
        setBusy(false);
        setError('This account does not have admin access.');
        return;
      }
      window.location.href = standing.allowed ? adminDestination() : '/admin/security';
    } catch (caught) {
      setBusy(false);
      setError(
        caught instanceof ApiError && caught.status === 401 && credentialsAccepted
          ? 'Your password was accepted, but the browser did not keep the sign-in session. Please retry. If it continues, contact the site owner.'
          : caught instanceof ApiError && caught.status === 401
            ? 'The email or password was not accepted. Check both and try again.'
          : caught instanceof Error
            ? caught.message
            : 'Could not sign in. Please try again.',
      );
    }
  }

  return (
    <main className="auth">
      <div className="auth__card">
        <p className="auth__eyebrow">JEEsociety · Administration</p>
        <h1 className="auth__title">{mode === 'setup' ? 'Set up admin password' : 'Admin sign in'}</h1>
        <p className="auth__sub">
          {mode === 'setup'
            ? 'Create the password for the administrator account. You will need the private setup code from the site owner.'
            : 'Sign in to the administrator account.'}
        </p>
        {error ? <p className="msg msg--bad">{error}</p> : null}
        <form onSubmit={submit}>
          <label className="field">
            <span>Admin email</span>
            <input
              className="inp"
              type="email"
              autoComplete="username"
              required
              value={mode === 'setup' ? ADMIN_EMAIL : email}
              readOnly={mode === 'setup'}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="field" style={{ display: 'block', marginTop: 12 }}>
            <span>{mode === 'setup' ? 'Create password' : 'Password'}</span>
            <div className="admin-login__password">
              <input
                className="inp"
                type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                required
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                className="admin-login__toggle"
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          {mode === 'setup' ? (
            <>
              <label className="field" style={{ display: 'block', marginTop: 12 }}>
                <span>Confirm password</span>
                <input
                  className="inp"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <label className="field" style={{ display: 'block', marginTop: 12 }}>
                <span>One-time setup code</span>
                <input
                  className="inp"
                  type="password"
                  autoComplete="off"
                  required
                  value={setupCode}
                  onChange={(event) => setSetupCode(event.target.value)}
                />
              </label>
            </>
          ) : null}
        <button className="btn btn--mark auth__submit" type="submit" disabled={busy || !email || !password || (mode === 'setup' && (!confirmPassword || !setupCode))}>
            {busy ? 'Working…' : mode === 'setup' ? 'Create admin account' : 'Sign in to admin'}
          </button>
        </form>
        {mode === 'sign-in' && setupAvailable ? (
          <button className="link-button admin-login__mode" type="button" onClick={() => { setMode('setup'); setError(null); }}>
            First time? Set up the admin account
          </button>
        ) : mode === 'setup' ? (
          <button className="link-button admin-login__mode" type="button" onClick={() => { setMode('sign-in'); setError(null); }}>
            Back to admin sign in
          </button>
        ) : null}
      </div>
    </main>
  );
}
