/**
 * Browser-side auth calls, against Better Auth's endpoints under /auth.
 *
 * These are thin wrappers rather than the Better Auth React client, for the
 * reason lib/api.ts exists at all: this app is a static export talking to
 * another origin, so every call must be credentialed and the API's CORS
 * allowlist must name this origin. One fetch helper does that in one place.
 */

import { ApiError, api } from './api';

export interface SignUpInput {
  name: string;
  email: string;
  password: string;
}

export function signUp(input: SignUpInput) {
  return api('/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function signIn(email: string, password: string) {
  return api<{ twoFactorRedirect?: boolean }>('/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function signOut() {
  return api('/auth/sign-out', { method: 'POST', body: '{}' });
}

/**
 * Starts the Google round trip.
 *
 * Two steps, because Better Auth's /sign-in/social is a POST that returns the
 * provider URL as JSON rather than a 302: ask for the URL, then navigate to it.
 * A plain link cannot do this, which is why the button is a <button>.
 *
 * `callbackURL` is where Google's round trip lands the student once the session
 * cookie is set. It is validated server-side against the API's own allowlist
 * (WEB_ORIGIN), so a tampered value cannot carry a live session off-site.
 *
 * `next` rides along in the query string so a student who clicked "Register"
 * comes back to the registration flow rather than the home page.
 */
export async function signInWithGoogle(next = '/register'): Promise<void> {
  const callbackURL = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
  const { url, redirect } = await api<{ url: string; redirect: boolean }>(
    '/auth/sign-in/social',
    {
      method: 'POST',
      body: JSON.stringify({ provider: 'google', callbackURL }),
    },
  );
  // `redirect: false` means the provider is misconfigured server-side (no
  // client id, usually). Surfacing it beats navigating to `undefined`.
  if (!redirect || !url) throw new ApiError(500, 'google_unavailable', 'Google sign-in is unavailable.');
  window.location.href = url;
}

export interface ProfileState {
  complete: boolean;
  profile: {
    phone: string;
    class: '11' | '12' | 'dropper';
    targetYear: number;
    dob: string | null;
    state: string | null;
    city: string | null;
    school: string | null;
    guardianName: string | null;
    guardianPhone: string | null;
    referralSource: string | null;
  } | null;
  hasPassword: boolean;
  providers: string[];
}

/** Null when not signed in, rather than throwing: callers branch on it. */
export async function getProfile(): Promise<ProfileState | null> {
  try {
    return await api<ProfileState>('/profile');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/**
 * Where a signed-in student belongs right now. One function so the three pages
 * that need to route (sign-in, sign-up, the OAuth landing) cannot disagree.
 */
export function nextStepFor(profile: ProfileState | null, fallback = '/register'): string {
  if (!profile) return '/login';
  if (!profile.complete) return '/complete-profile';
  return fallback;
}
