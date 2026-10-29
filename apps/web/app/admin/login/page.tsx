'use client';

import { useEffect, useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import { getProfile, signIn, signOut } from '../../../lib/auth';
import '../../auth.css';

interface Standing {
  isAdmin: boolean;
  allowed: boolean;
}

function adminDestination(): string {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next === '/admin' || (next?.startsWith('/admin/') && next !== '/admin/login')) return next;
  return '/admin';
}

export default function AdminLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getProfile()
      .then(async (profile) => {
        if (!live) return;
        if (!profile) {
          setChecking(false);
          return;
        }
        try {
          const standing = await api<Standing>('/admin-security/standing');
          if (!live) return;
          if (!standing.isAdmin) {
            await signOut();
            setError('This account does not have admin access.');
            setChecking(false);
          } else {
            window.location.replace(standing.allowed ? adminDestination() : '/admin/security');
          }
        } catch {
          if (live) {
            setError('Could not check admin access. Please try again.');
            setChecking(false);
          }
        }
      })
      .catch(() => {
        if (live) {
          setError('Could not reach the sign-in service. Please try again.');
          setChecking(false);
        }
      });
    return () => { live = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await signIn(email.trim(), password);
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
        caught instanceof ApiError && caught.status === 401
          ? 'The password was not accepted. Check it and try again.'
          : caught instanceof Error ? caught.message : 'Could not sign in. Please try again.',
      );
    }
  }

  if (checking) {
    return <main className="auth"><div className="auth__card"><p className="auth__sub">Checking sign-in…</p></div></main>;
  }

  return (
    <main className="auth">
      <div className="auth__card">
        <p className="auth__eyebrow">JEE Society · Administration</p>
        <h1 className="auth__title">Admin sign in</h1>
        <p className="auth__sub">Sign in to the administrator account.</p>
        {error ? <p className="msg msg--bad">{error}</p> : null}
        <form onSubmit={submit}>
          <label className="field">
            <span>Email</span>
            <input className="inp" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label className="field" style={{ display: 'block', marginTop: 12 }}>
            <span>Password</span>
            <div className="admin-login__password">
              <input
                className="inp"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
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
          <button className="btn btn--mark auth__submit" type="submit" disabled={busy || !email.trim() || !password}>
            {busy ? 'Working…' : 'Sign in to admin'}
          </button>
        </form>
      </div>
    </main>
  );
}
