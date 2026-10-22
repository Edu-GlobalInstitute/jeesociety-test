import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import type { Pool } from '@jee/db';
import type { Env } from './env.js';

/**
 * Better Auth owns the user, session, account and verification tables. It is
 * pointed at the same pool as everything else so a session lookup is a local
 * query over private networking, not a second connection budget.
 *
 * Session lifetime is the thing to get right here: a session that expires at
 * minute 150 ejects a student mid-test. 12 hours covers the lobby, a 3-hour
 * window, and a student who signed in the previous evening.
 */

export type Auth = ReturnType<typeof createAuth>;

export function createAuth(env: Env, pool: Pool) {
  return betterAuth({
    database: pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/auth',
    trustedOrigins: env.CORS_ORIGINS,
    emailAndPassword: {
      enabled: true,
      // Students register days before the event; requiring an inbox round-trip
      // at the lobby would lock out anyone with a typo and no time to fix it.
      // Verification is sent but not required to sit the test.
      requireEmailVerification: false,
      minPasswordLength: 8,
    },
    session: {
      expiresIn: 60 * 60 * 12,
      // Rolling refresh, at most hourly, so a 3-hour test never expires under
      // a student who is actively syncing.
      updateAge: 60 * 60,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    advanced: {
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: {
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        secure: env.NODE_ENV === 'production',
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 20,
    },
  });
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** Resolves the session for a Node request, or null when unauthenticated. */
export async function resolveSession(
  auth: Auth,
  headers: IncomingHttpHeaders,
): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session?.user) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}
