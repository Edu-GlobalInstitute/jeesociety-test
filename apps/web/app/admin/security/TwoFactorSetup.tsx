'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import { encodeQr } from '../../../lib/qr';

interface TwoFactorSetupProps {
  enabled: boolean;
  graceExpired: boolean;
  mustSetUpBy: string | null;
  onChanged: () => void;
}

/** Setup and verify an authenticator, or disable it after password confirmation. */
export function TwoFactorSetup({
  enabled,
  graceExpired,
  mustSetUpBy,
  onChanged,
}: TwoFactorSetupProps) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [uri, setUri] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function beginSetup() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ totpURI: string; backupCodes: string[] }>(
        '/auth/two-factor/enable',
        { method: 'POST', body: JSON.stringify({ password }) },
      );
      setUri(result.totpURI);
      setBackupCodes(result.backupCodes ?? []);
      setPassword('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start setup.');
    } finally {
      setBusy(false);
    }
  }

  async function verifySetup() {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/two-factor/verify-totp', {
        method: 'POST',
        body: JSON.stringify({ code: code.replace(/\s/g, '') }),
      });
      setUri(null);
      setCode('');
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/two-factor/disable', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setPassword('');
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not disable two-factor authentication.');
    } finally {
      setBusy(false);
    }
  }

  let qr: ReturnType<typeof encodeQr> | null = null;
  if (uri) {
    try {
      qr = encodeQr(uri);
    } catch {
      // The URI remains available as text for authenticator apps that support
      // manual secret entry; do not hide setup if the QR encoder rejects it.
    }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>Authenticator app</h2>
      {enabled ? (
        <p className="ap__sub">Two-factor authentication is on for this account.</p>
      ) : (
        <p className="ap__sub">
          {graceExpired
            ? 'Your setup grace period has expired. Set up an authenticator to restore admin access.'
            : `Set up an authenticator app${mustSetUpBy ? ` by ${new Date(mustSetUpBy).toLocaleString('en-IN')}` : ''}.`}
        </p>
      )}

      {error ? <p className="msg msg--bad">{error}</p> : null}

      {uri ? (
        <div>
          {qr ? (
            <svg
              role="img"
              aria-label="Authenticator setup QR code"
              viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
              width="220"
              height="220"
              style={{ background: 'white', padding: 8, shapeRendering: 'crispEdges' }}
            >
              <rect width="100%" height="100%" fill="white" />
              {qr.modules.flatMap((row, y) =>
                row.map((dark, x) => dark ? <rect key={`${x}-${y}`} x={x + 4} y={y + 4} width="1" height="1" fill="black" /> : null),
              )}
            </svg>
          ) : null}
          <p className="ap__sub">Scan with your authenticator app, or enter this setup key manually:</p>
          <code style={{ overflowWrap: 'anywhere' }}>{new URL(uri).searchParams.get('secret') ?? uri}</code>
          <label className="field" style={{ display: 'block', marginTop: 12 }}>
            <span>Six-digit code from the app</span>
            <input
              className="inp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/[^0-9 ]/g, '').slice(0, 8))}
            />
          </label>
          <button type="button" className="btn" disabled={busy || code.replace(/\D/g, '').length !== 6} onClick={verifySetup}>
            {busy ? 'Checking…' : 'Verify and finish setup'}
          </button>
          {backupCodes.length > 0 ? (
            <div className="msg msg--warn" style={{ marginTop: 12 }}>
              <strong>Save these recovery codes somewhere safe. Each works once.</strong>
              <ul>{backupCodes.map((backup) => <li key={backup}><code>{backup}</code></li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : enabled ? (
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="inp inp--sm"
            type="password"
            autoComplete="current-password"
            placeholder="Password to disable"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="button" className="btn btn--sm btn--danger" disabled={busy || !password} onClick={disable}>
            {busy ? 'Working…' : 'Disable authenticator'}
          </button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="inp inp--sm"
            type="password"
            autoComplete="current-password"
            placeholder="Confirm your password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="button" className="btn btn--sm" disabled={busy || !password} onClick={beginSetup}>
            {busy ? 'Starting…' : 'Set up authenticator'}
          </button>
        </div>
      )}
    </section>
  );
}
