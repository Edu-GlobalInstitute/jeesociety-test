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

export interface ProfileState {
  /** From the session. Used to prefill the payment screen. */
  name: string | null;
  email: string | null;
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
