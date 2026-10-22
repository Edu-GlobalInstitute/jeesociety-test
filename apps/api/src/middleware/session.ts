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
 * Admin is a row in `admins`, checked per request. There is no admin claim in
 * the session cookie: revoking access must take effect immediately, not when a
 * 12-hour session happens to expire.
 */
export function requireAdmin(auth: Auth, pool: Pool): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const user = await resolveSession(auth, req.headers);
    if (!user) return next(unauthorized());
    if (!(await adminQueries.isAdmin(user.id, pool))) {
      return next(forbidden('not_admin', 'Admin access is required.'));
    }
    req.user = user;
    next();
  };
}

export function currentUser(req: Request): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
