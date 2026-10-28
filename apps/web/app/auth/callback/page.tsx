'use client';

import { useEffect, useState } from 'react';
import '../../auth.css';
import { getProfile, nextStepFor } from '../../../lib/auth';

/**
 * Where Google sends the student back.
 *
 * Better Auth has already set the session cookie by the time this renders — the
 * OAuth exchange happened server-to-server on the API. So this page does one
 * thing: ask whether the profile is finished, and forward accordingly. A Google
 * account is always incomplete on first sign-in (no phone number), so the usual
 * destination is /complete-profile.
 *
 * It exists as a real page rather than a redirect because the student has just
 * come back from a third-party screen and needs to see that something is
 * happening, and because a failed sign-in needs somewhere to say so.
 *
 * `next` is read from the query string but never used as a redirect target
 * directly — it is passed to nextStepFor as a fallback and only honoured when
 * it is one of this app's own paths. An absolute URL from the query string
 * would be an open redirect carrying a live session.
 */

/** Same-origin, single-segment paths only. Anything else falls back. */
function safeNext(raw: string | null): string {
  if (!raw) return '/register';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/register';
  return raw;
}

export default function AuthCallback() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      // Better Auth appends ?error=... when the provider or the exchange failed.
      if (params.get('error')) {
        if (live) setFailed(true);
        return;
      }

      const profile = await getProfile().catch(() => null);
      if (!live) return;
      if (!profile) {
        // Signed-in session not found: the cookie did not stick. On localhost
        // that is nearly always the two-origin setup — see deploy/google-oauth.md.
        setFailed(true);
        return;
      }
      window.location.replace(nextStepFor(profile, safeNext(params.get('next'))));
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="auth">
      <div className="auth__card">
        {failed ? (
          <>
            <h1 className="auth__title">That did not work</h1>
            <p className="auth__sub">
              We could not complete the Google sign-in. Nothing was charged and no account was
              changed.
            </p>
            <div className="auth__panel">
              <p className="prose" style={{ marginBottom: 18 }}>
                Try again, or sign in with an email and password instead.
              </p>
              <a className="btn btn--mark auth__submit" href="/login">
                Back to sign in
              </a>
            </div>
          </>
        ) : (
          <>
            <h1 className="auth__title">Signing you in…</h1>
            <p className="auth__sub">One moment.</p>
          </>
        )}
      </div>
    </main>
  );
}
