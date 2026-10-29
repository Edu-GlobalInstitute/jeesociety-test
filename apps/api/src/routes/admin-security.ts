import express, { Router } from 'express';
import { z } from 'zod';
import { admin, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireUser } from '../middleware/session.js';
import { forbidden, notFound } from '../middleware/errors.js';
import type { Logger } from '../logger.js';

/**
 * The admin security screen, and the one endpoint that must NOT sit behind
 * requireAdmin.
 *
 * `GET /admin-security/standing` is mounted on requireUser rather than
 * requireAdmin on purpose, and it is the whole reason this is a separate file.
 * An admin who has not yet set up 2FA is refused by requireAdmin once their
 * grace period expires — so if the endpoint that tells them *why* were behind
 * the same gate, they would get a 403 with no way to learn what to do about
 * it. This answers "you are an admin, your grace period ended, set up an
 * authenticator" to an account that requireAdmin is currently turning away.
 *
 * It returns no secret. Whether 2FA is on is not sensitive to the person it is
 * about; the TOTP secret and the backup codes are, and those are Better Auth's
 * to issue over /auth/two-factor/* — never this file's.
 */
export function adminSecurityRoutes({
  pool,
  auth,
  log,
}: {
  pool: Pool;
  auth: Auth;
  log: Logger;
}): Router {
  const router = Router();
  router.use(express.json({ limit: '16kb' }));
  router.use(requireUser(auth));

  /**
   * What the portal routes on at load: admin or not, 2FA or not, and how long
   * is left to set it up.
   */
  router.get('/standing', async (req, res) => {
    const me = currentUser(req);
    const standing = await admin.adminStanding(me.id, pool);

    res.json({
      isAdmin: standing.is_admin,
      twoFactorEnabled: standing.two_factor_enabled,
      require2fa: standing.require_2fa,
      graceExpired: standing.grace_expired,
      // The portal shows this as a countdown, so it is the thing to send
      // rather than a boolean the admin cannot plan around.
      mustSetUpBy:
        standing.is_admin && standing.require_2fa && !standing.two_factor_enabled
          ? standing.mfa_grace_until?.toISOString() ?? null
          : null,
      // True when the admin can use the portal right now.
      allowed:
        standing.is_admin
        && (!standing.require_2fa || standing.two_factor_enabled || !standing.grace_expired),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Everything below is admin-only, and checked here rather than by         */
  /* requireAdmin so that /standing above stays reachable.                   */
  /* ---------------------------------------------------------------------- */

  /**
   * The full admin check, applied per route.
   *
   * requireAdmin cannot be used as router-level middleware in this file
   * (see the header), so the routes that do need it ask for it explicitly. The
   * duplication is deliberate and small: one call per route is harder to get
   * wrong than a conditional router.
   */
  async function assertFullAdmin(userId: string): Promise<void> {
    const standing = await admin.adminStanding(userId, pool);
    if (!standing.is_admin) {
      throw forbidden('not_admin', 'Admin access is required.');
    }
    if (standing.require_2fa && !standing.two_factor_enabled && standing.grace_expired) {
      throw forbidden(
        'mfa_required',
        'Two-factor authentication is required for admin access.',
      );
    }
  }

  /** Who holds admin access, and whether each has a second factor. */
  router.get('/admins', async (req, res) => {
    const me = currentUser(req);
    await assertFullAdmin(me.id);

    const accounts = await admin.listAdminAccounts(pool);
    res.json({
      admins: accounts.map((row) => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        note: row.note,
        require2fa: row.require_2fa,
        twoFactorEnabled: row.two_factor_enabled,
        graceUntil: row.mfa_grace_until?.toISOString() ?? null,
        grantedBy: row.granted_by_email,
        grantedAt: row.created_at.toISOString(),
        isYou: row.user_id === me.id,
      })),
    });
  });

  /**
   * Admin access attempts, including the refused ones.
   *
   * The refusals are the reason this screen exists. A granted request that
   * changed something writes an admin_audit row; a refused one changes nothing
   * and writes nothing, so without this log there is no trace of an account
   * being probed.
   */
  router.get('/access-log', async (req, res) => {
    const me = currentUser(req);
    await assertFullAdmin(me.id);

    const query = z
      .object({
        refusedOnly: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);

    const entries = await admin.recentAdminAccess(
      { refusedOnly: query.refusedOnly, limit: query.limit },
      pool,
    );

    res.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        email: entry.email,
        outcome: entry.outcome,
        path: entry.path,
        ip: entry.ip,
        userAgent: entry.user_agent,
        at: entry.at.toISOString(),
      })),
    });
  });

  /**
   * POST /admin-security/grant — adds an admin.
   *
   * Requires the granting admin to hold a second factor themselves, not merely
   * to be inside a grace period: granting admin access is the one action that
   * creates more of the privilege being protected, so it is the last thing that
   * should be reachable with a password alone.
   *
   * The new admin gets a fresh grace period of their own, because they have to
   * be able to sign in before they can set up an authenticator.
   */
  const GrantSchema = z.object({
    email: z.string().email(),
    note: z.string().trim().min(2).max(200),
  });

  router.post('/grant', async (req, res) => {
    const me = currentUser(req);
    const standing = await admin.adminStanding(me.id, pool);
    if (!standing.is_admin) throw forbidden('not_admin', 'Admin access is required.');
    if (!standing.two_factor_enabled) {
      throw forbidden(
        'mfa_required',
        'Set up two-factor authentication on your own account before granting admin access to anyone else.',
      );
    }

    const body = GrantSchema.parse(req.body);
    const granted = await admin.grantAdmin(
      { email: body.email, note: body.note, grantedBy: me.id },
      pool,
    );
    if (!granted) {
      throw notFound(
        'no_such_user',
        'No account with that email address. They must sign up on the site first.',
      );
    }

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'admin_grant',
        attemptId: null,
        questionId: null,
        before: null,
        after: { email: body.email, userId: granted.user_id },
        reason: body.note,
      },
      pool,
    );

    log.warn({ adminId: me.id, granted: granted.user_id }, 'admin access granted');
    res.json({ ok: true, userId: granted.user_id });
  });

  /**
   * POST /admin-security/revoke — removes an admin.
   *
   * Refuses to remove the last admin, and refuses to remove yourself. Both are
   * ways to lock everyone out of the portal with one request, recoverable only
   * by hand in SQL.
   */
  router.post('/revoke', async (req, res) => {
    const me = currentUser(req);
    await assertFullAdmin(me.id);

    const body = z.object({ userId: z.string().min(1).max(64) }).parse(req.body);

    if (body.userId === me.id) {
      throw forbidden(
        'cannot_revoke_self',
        'You cannot remove your own admin access. Ask another admin to do it.',
      );
    }

    const removed = await admin.revokeAdmin(body.userId, pool);
    if (!removed) {
      throw forbidden(
        'last_admin',
        'That is the only admin account with two-factor set up. Removing it would lock everyone out.',
      );
    }

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'admin_revoke',
        attemptId: null,
        questionId: null,
        before: { userId: body.userId },
        after: null,
        reason: 'revoked from the security screen',
      },
      pool,
    );

    log.warn({ adminId: me.id, revoked: body.userId }, 'admin access revoked');
    res.json({ ok: true });
  });

  return router;
}
