'use client';

import { useState } from 'react';
import { signInWithGoogle } from '../lib/auth';

/**
 * "Continue with Google".
 *
 * The mark is inlined rather than loaded from Google's CDN: this app is a
 * static export and one more third-party request on the sign-in path is one
 * more thing that can be slow on a school connection.
 *
 * Google's brand guidelines require their four-colour mark, the word "Google"
 * in the label, and no recolouring of the glyph — so none of this is themed.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

export function GoogleButton({
  next,
  disabled,
  label = 'Continue with Google',
}: {
  /** Where to land after the round trip. Carried through the OAuth state. */
  next?: string;
  disabled?: boolean;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * Getting to Google takes a request of its own (see signInWithGoogle), so
   * this can fail before the student ever leaves the page — most likely because
   * the server has no Google credentials configured. Saying so, and leaving the
   * password form right there, is better than a button that does nothing.
   */
  async function start() {
    setBusy(true);
    setFailed(false);
    try {
      await signInWithGoogle(next);
      // On success the browser is navigating away; leave the button disabled.
    } catch {
      setBusy(false);
      setFailed(true);
    }
  }

  return (
    <>
      <button
        type="button"
        className="auth__google"
        disabled={disabled || busy}
        onClick={start}
      >
        <GoogleMark />
        {busy ? 'Taking you to Google…' : label}
      </button>
      {failed ? (
        <p className="field__error" style={{ marginTop: 8 }} role="alert">
          Google sign-in is not available right now. Use your email and password below.
        </p>
      ) : null}
    </>
  );
}
