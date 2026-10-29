'use client';

import { useState } from 'react';
import '../auth.css';
import { api, ApiError } from '../../lib/api';
import { getProfile, nextStepFor } from '../../lib/auth';

/** Completes Better Auth's password sign-in challenge without creating a session first. */
export default function TwoFactorPage() {
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(useBackup ? '/auth/two-factor/verify-backup-code' : '/auth/two-factor/verify-totp', {
        method: 'POST',
        body: JSON.stringify({ code: code.replace(/\s/g, '') }),
      });
      const profile = await getProfile();
      window.location.href = nextStepFor(profile, '/admin');
    } catch (caught) {
      setBusy(false);
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That code was not accepted. Try the current code from your authenticator.'
          : caught instanceof Error
            ? caught.message
            : 'Could not verify that code.',
      );
    }
  }

  return (
    <main className="auth">
      <div className="auth__card">
        <h1 className="auth__title">Verify it’s you</h1>
        <p className="auth__sub">
          {useBackup
            ? 'Enter one of your unused recovery codes to finish signing in.'
            : 'Enter the six-digit code from your authenticator app to finish signing in.'}
        </p>
        {error ? <p className="msg msg--bad">{error}</p> : null}
        <form onSubmit={submit}>
          <label className="field">
            <span>Authenticator code</span>
            <input
              className="inp"
              inputMode={useBackup ? 'text' : 'numeric'}
              autoComplete={useBackup ? 'off' : 'one-time-code'}
              autoFocus
              required
              value={code}
              onChange={(event) => setCode(useBackup ? event.target.value.slice(0, 32) : event.target.value.replace(/[^0-9 ]/g, '').slice(0, 8))}
            />
          </label>
          <button className="btn btn--mark auth__submit" type="submit" disabled={busy || (useBackup ? !code.trim() : code.replace(/\D/g, '').length !== 6)}>
            {busy ? 'Checking…' : 'Verify and sign in'}
          </button>
        </form>
        <p className="auth__fine">
          <button type="button" className="link-button" onClick={() => { setUseBackup((value) => !value); setCode(''); setError(null); }}>
            {useBackup ? 'Use an authenticator code' : 'Use a recovery code'}
          </button>
        </p>
        <p className="auth__fine"><a href="/login">Return to sign in</a></p>
      </div>
    </main>
  );
}
