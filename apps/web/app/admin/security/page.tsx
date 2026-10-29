'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { TwoFactorSetup } from './TwoFactorSetup';

/**
 * Admin security: who holds admin access, whether each has a second factor, and
 * the log of attempts to reach the portal.
 *
 * The access log is the part worth having. A granted request that changed
 * something writes an admin_audit row, but a *refused* one changes nothing and
 * so writes nothing — without this table there would be no trace at all of an
 * admin account being probed.
 */

interface Standing {
  isAdmin: boolean;
  twoFactorEnabled: boolean;
  require2fa: boolean;
  graceExpired: boolean;
  allowed: boolean;
  mustSetUpBy: string | null;
}

interface AdminAccount {
  userId: string;
  name: string | null;
  email: string;
  note: string | null;
  require2fa: boolean;
  twoFactorEnabled: boolean;
  graceUntil: string | null;
  grantedBy: string | null;
  grantedAt: string;
  isYou: boolean;
}

interface LogEntry {
  id: number;
  email: string | null;
  outcome: string;
  path: string | null;
  ip: string | null;
  at: string;
}

const OUTCOME_LABELS: Record<string, string> = {
  granted: 'allowed in',
  no_session: 'not signed in',
  not_admin: 'not an admin',
  mfa_required: 'no second factor',
  mfa_stale: 'second factor overdue',
};

export default function SecurityPage() {
  const [standing, setStanding] = useState<Standing | null>(null);
  const [admins, setAdmins] = useState<AdminAccount[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [refusedOnly, setRefusedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    // Standing first and on its own: it is the one call that works for an admin
    // whose 2FA is overdue, and it is what tells them so.
    api<Standing>('/admin-security/standing')
      .then((next) => {
        setStanding(next);
        if (!next.allowed) return;
        void api<{ admins: AdminAccount[] }>('/admin-security/admins')
          .then((result) => setAdmins(result.admins))
          .catch(() => {});
        void api<{ entries: LogEntry[] }>(
          `/admin-security/access-log?limit=100${refusedOnly ? '&refusedOnly=true' : ''}`,
        )
          .then((result) => setLog(result.entries))
          .catch(() => {});
      })
      .catch(() => setError('Could not load your security standing.'));
  }, [refusedOnly]);

  useEffect(load, [load]);

  async function revoke(account: AdminAccount) {
    if (
      !window.confirm(
        `Remove admin access from ${account.email}? They keep their student account.`,
      )
    ) {
      return;
    }
    try {
      await api('/admin-security/revoke', {
        method: 'POST',
        body: JSON.stringify({ userId: account.userId }),
      });
      setMessage(`Admin access removed from ${account.email}.`);
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke that.');
    }
  }

  if (!standing) {
    return (
      <main className="ap">
        {error ? <p className="msg msg--bad">{error}</p> : <p className="empty">Loading…</p>}
      </main>
    );
  }

  if (!standing.isAdmin) {
    return (
      <main className="ap">
        <p className="msg msg--bad">
          This account does not have admin access.
        </p>
      </main>
    );
  }

  return (
    <main className="ap">
      <div className="ap__head">
        <div>
          <h1>Security</h1>
          <p className="ap__sub">
            Admin access is checked on every request, so revoking it takes effect immediately.
          </p>
        </div>
      </div>

      {error ? <p className="msg msg--bad">{error}</p> : null}
      {message ? <p className="msg msg--ok">{message}</p> : null}

      <TwoFactorSetup
        enabled={standing.twoFactorEnabled}
        graceExpired={standing.graceExpired}
        mustSetUpBy={standing.mustSetUpBy}
        onChanged={load}
      />

      {standing.allowed ? (
        <>
          <section className="card" style={{ marginBottom: 16 }}>
            <h2>Admin accounts</h2>
            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Second factor</th>
                    <th>Granted</th>
                    <th>By</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {admins.map((account) => (
                    <tr key={account.userId}>
                      <td>
                        <strong>{account.name ?? account.email}</strong>
                        {account.isYou ? (
                          <span className="chip chip--draft" style={{ marginLeft: 6 }}>
                            you
                          </span>
                        ) : null}
                        <div className="muted-cell" style={{ fontSize: '0.76rem' }}>
                          {account.email}
                          {account.note ? ` · ${account.note}` : ''}
                        </div>
                      </td>
                      <td className="nowrap">
                        {account.twoFactorEnabled ? (
                          <span className="chip chip--paid">on</span>
                        ) : account.graceUntil && new Date(account.graceUntil) > new Date() ? (
                          <span className="chip chip--warn">
                            due {new Date(account.graceUntil).toLocaleDateString('en-IN')}
                          </span>
                        ) : (
                          <span className="chip chip--bad">locked out</span>
                        )}
                      </td>
                      <td className="nowrap muted-cell">
                        {new Date(account.grantedAt).toLocaleDateString('en-IN')}
                      </td>
                      <td className="nowrap muted-cell">{account.grantedBy ?? 'by hand'}</td>
                      <td className="nowrap">
                        {account.isYou ? null : (
                          <button
                            type="button"
                            className="btn btn--sm btn--danger"
                            onClick={() => revoke(account)}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="ap__sub" style={{ marginTop: 10 }}>
              To add an admin, the person must sign up on the site first — then grant it by
              email. You need your own second factor set up before you can grant access to
              anyone else.
            </p>
            <GrantAdmin
              disabled={!standing.twoFactorEnabled}
              onGranted={(email) => {
                setMessage(`${email} now has admin access.`);
                load();
              }}
              onError={setError}
            />
          </section>

          <section className="card">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Access attempts</h2>
              <label className="row" style={{ gap: 5, fontSize: '0.82rem', fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={refusedOnly}
                  onChange={(event) => setRefusedOnly(event.target.checked)}
                />
                Refused only
              </label>
            </div>
            {log.length === 0 ? (
              <p className="empty">Nothing recorded yet.</p>
            ) : (
              <div className="tablewrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Account</th>
                      <th>Outcome</th>
                      <th>From</th>
                      <th>Path</th>
                    </tr>
                  </thead>
                  <tbody>
                    {log.map((entry) => (
                      <tr key={entry.id}>
                        <td className="nowrap muted-cell tnum">
                          {new Date(entry.at).toLocaleString('en-IN')}
                        </td>
                        <td className="nowrap">{entry.email ?? <em>none</em>}</td>
                        <td className="nowrap">
                          <span
                            className={
                              entry.outcome === 'granted' ? 'chip chip--paid' : 'chip chip--bad'
                            }
                          >
                            {OUTCOME_LABELS[entry.outcome] ?? entry.outcome}
                          </span>
                        </td>
                        <td className="nowrap tnum muted-cell">{entry.ip ?? '—'}</td>
                        <td className="muted-cell" style={{ fontSize: '0.76rem' }}>
                          {entry.path ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </main>
  );
}

/** Grants admin access by email. Needs the granting admin to hold 2FA. */
function GrantAdmin({
  disabled,
  onGranted,
  onError,
}: {
  disabled: boolean;
  onGranted: (email: string) => void;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="row" style={{ marginTop: 10 }}>
      <input
        className="inp inp--sm"
        style={{ width: 'auto', flex: '1 1 220px' }}
        type="email"
        placeholder="their@email.com"
        value={email}
        disabled={disabled}
        onChange={(event) => setEmail(event.target.value)}
      />
      <input
        className="inp inp--sm"
        style={{ width: 'auto', flex: '1 1 160px' }}
        placeholder="Why (e.g. sales team)"
        value={note}
        disabled={disabled}
        onChange={(event) => setNote(event.target.value)}
      />
      <button
        type="button"
        className="btn btn--sm"
        disabled={disabled || busy || !email.includes('@') || note.trim().length < 2}
        onClick={async () => {
          setBusy(true);
          try {
            await api('/admin-security/grant', {
              method: 'POST',
              body: JSON.stringify({ email: email.trim(), note: note.trim() }),
            });
            onGranted(email.trim());
            setEmail('');
            setNote('');
          } catch (caught) {
            onError(caught instanceof Error ? caught.message : 'Could not grant access.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Grant admin
      </button>
      {disabled ? (
        <span className="ap__sub">Set up your own second factor first.</span>
      ) : null}
    </div>
  );
}
