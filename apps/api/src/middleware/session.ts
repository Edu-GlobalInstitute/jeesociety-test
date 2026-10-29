import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { admin as adminQueries, type Pool } from '@jee/db';
import type { Auth, SessionUser } from '../auth.js';
import { resolveSession } from '../auth.js';
import { forbidden, unauthorized } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export function requireUser(auth: Auth): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = await resolveSession(auth, req.headers);
    if (!user) return next(unauthorized());
    req.user = user;
    next();
  };
}

/**
 * Admin is a row in `admins`, checked per request, plus a verified second
 * factor.
 *
 * Three properties, each of which was a real gap before:
 *
 *   The admin row is read on every request, never cached in the session cookie,
 *   so revoking access takes effect immediately rather than when a twelve-hour
 *   session happens to expire.
 *
 *   2FA is required. Better Auth enforces the hard part at sign-in: for an
 *   account with `twoFactorEnabled`, it deletes the session it would have
 *   created and issues a ten-minute challenge cookie instead, so no session
 *   exists until a TOTP code is verified. The check here is the second half —
 *   it refuses an admin who has not set 2FA up at all, which the sign-in path
 *   cannot notice because such an account signs in normally.
 *
 *   Every attempt is logged, including the refusals. An attempt that is turned
 *   away changes nothing and so writes no admin_audit row; without
 *   admin_access_log there would be no trace of someone trying an admin
 *   account repeatedly.
 *
 * The grace period is what keeps this from being a lockout. The first admin row
 * is always created by hand in SQL, by someone who then has to sign in and set
 * up an authenticator — so an admin without 2FA is allowed through until
 * `mfa_grace_until`, and refused after it.
 */
export function requireAdmin(auth: Auth, pool: Pool): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = await resolveSession(auth, req.headers);

    const record = (
      outcome: 'granted' | 'no_session' | 'not_admin' | 'mfa_required' | 'mfa_stale',
    ) =>
      adminQueries.logAdminAccess(
        {
          userId: user?.id ?? null,
          email: user?.email ?? null,
          outcome,
          path: req.originalUrl?.slice(0, 200) ?? null,
          ip: req.ip ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
        pool,
      );

    if (!user) {
      void record('no_session');
      return next(unauthorized());
    }

    const standing = await adminQueries.adminStanding(user.id, pool);
    if (!standing.is_admin) {
      void record('not_admin');
      return next(forbidden('not_admin', 'Admin access is required.'));
    }

    if (standing.require_2fa && !standing.two_factor_enabled && standing.grace_expired) {
      void record('mfa_stale');
      // 403 with a code the portal routes on, rather than a bare refusal: the
      // admin is legitimate and the fix is theirs to make, so the response has
      // to say what it is.
      return next(
        forbidden(
          'mfa_required',
          'Two-factor authentication is required for admin access. '
            + 'Set up an authenticator app to continue.',
        ),
      );
    }

    void record('granted');
    req.user = user;
    next();
  };
}

export function currentUser(req: Request): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
