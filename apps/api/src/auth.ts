import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { twoFactor } from 'better-auth/plugins';
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
    /**
     * No social providers.
     *
     * Google sign-in was offered and has been removed: email and password is
     * the only way in. Removing it here, rather than only hiding the button, is
     * what makes that true -- /auth/sign-in/social answers
     * PROVIDER_NOT_FOUND once this is empty, so a saved link or a crafted
     * request cannot create an account that bypasses the password.
     *
     * `account.accountLinking` went with it. It existed so that a student who
     * had registered with a password and later used Google got their existing
     * account rather than a second one holding no payment; with one route in
     * there is nothing to link.
     *
     * Note for anyone turning a provider back on: an account created through
     * one has no password row, and this deployment has no email sending, so
     * such a student has no reset path. Add password reset first.
     */
    socialProviders: {},
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
      ipAddress: {
        /*
         * Which header carries the client, rather than letting it guess.
         *
         * Better Auth's default order checks x-forwarded-for before
         * cf-connecting-ip and takes the first value in the list. The proxy
         * sets x-forwarded-for to the real client, but Render's edge appends
         * its own address -- so what Better Auth read was not reliably the
         * student, and its rate limiter put everyone in one bucket of sixty a
         * minute. Signing in then answered "Too many requests" to someone who
         * had tried once.
         *
         * cf-connecting-ip is set by Cloudflare to the real client and
         * overwrites whatever a client sent, so it cannot be forged through
         * the proxy -- and this API is only reachable through it. Naming it
         * first makes this limiter agree with the one in app.ts, which keys on
         * the same header.
         */
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
    /*
     * Better Auth's own limiter, on top of the one in app.ts.
     *
     * Raised from 20 for the same reason as LIMITS.authPerMinute: one address
     * is often a whole coaching centre or hostel behind a single NAT, and the
     * lower of two stacked limits is the one that bites. Twenty meant the
     * outer limit could be generous and students still be refused.
     *
     * This one keys on the address Better Auth derives from the request, so it
     * depends on `trust proxy` being right -- which is exactly what went wrong
     * when the same-origin proxy was added. Keeping it well above the outer
     * limit means the outer one, which uses cf-connecting-ip directly and
     * cannot be thrown off by a hop count, is the one that decides.
     */
    rateLimit: {
      /*
       * OFF, 5 November 2026, with the limiter in middleware/rateLimit.ts.
       *
       * This one is Better Auth's own and is enforced inside the library, so
       * disabling the outer limiter alone would leave it firing -- it was the
       * second of the two "Too many requests" screens. It keys on the address
       * Better Auth derives from the request, which depends on `trust proxy`
       * being right, so it was also the one that could be wrong without
       * anything looking wrong.
       */
      enabled: false,
      window: 60,
      max: 60,
    },
    /**
     * Two-factor authentication, for admins.
     *
     * Enabled for the whole instance because the plugin has to own the sign-in
     * path to work: when a user with 2FA signs in, it deletes the session it
     * would have created and returns `{ twoFactorRedirect: true }` with a
     * ten-minute cookie instead. No session exists until the code is verified,
     * which is what makes a stolen admin password insufficient rather than
     * merely inconvenient.
     *
     * Students are unaffected. Nothing turns 2FA on for an account except that
     * account calling /auth/two-factor/enable with its own password, and the
     * portal only offers it to admins. A student who wants it may have it.
     *
     * TOTP only -- no email OTP. `otpOptions.sendOTP` is deliberately not
     * configured: this deployment has no email sending at all, so an OTP route
     * would be a code path that silently never delivers. The authenticator app
     * needs no infrastructure and keeps working if email ever breaks.
     */
    plugins: [
      twoFactor({
        // What the authenticator app shows beside the six digits.
        issuer: 'JEEsociety Admin',
        backupCodeOptions: {
          // Ten codes, shown once. Enough that losing a phone is recoverable
          // without them becoming a password list someone leaves in a drawer.
          amount: 10,
          length: 10,
        },
        // The code must be verified before the flag is set, so an admin cannot
        // lock themselves out by enabling 2FA against a mistyped secret.
        skipVerificationOnEnable: false,
      }),
    ],
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
