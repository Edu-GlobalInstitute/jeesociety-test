import { timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import type { Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';

const ADMIN_EMAIL = 'jeesocietydev@gmail.com';

/**
 * First-time admin provisioning. The email is fixed; the private setup code
 * proves who is allowed to initialize it. A password confirmation alone is
 * not proof of mailbox ownership.
 */
export function adminBootstrapRoutes({
  pool,
  auth,
  env,
  log,
}: {
  pool: Pool;
  auth: Auth;
  env: Env;
  log: Logger;
}): Router {
  const router = Router();
  router.use(express.json({ limit: '16kb' }));

  const SetupSchema = z.object({
    setupCode: z.string().min(32).max(256),
    password: z.string().min(8).max(128),
    confirmPassword: z.string().min(8).max(128),
  });

  // The client only shows the setup action while the private setup code is
  // configured and this fixed account has not been claimed. This is a UX
  // signal only; POST /setup still enforces the secret and the account check.
  router.get('/status', async (_req, res) => {
    if (!env.ADMIN_BOOTSTRAP_SECRET) {
      res.json({ available: false });
      return;
    }
    const account = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM "user" WHERE lower("email") = lower($1)
       ) AS exists`,
      [ADMIN_EMAIL],
    );
    res.json({ available: !account.rows[0]?.exists });
  });

  router.post('/setup', async (req, res) => {
    if (!env.ADMIN_BOOTSTRAP_SECRET) {
      res.status(503).json({
        error: 'setup_unavailable',
        message: 'First-time setup is not configured. Contact the site owner.',
      });
      return;
    }

    const body = SetupSchema.parse(req.body);
    const supplied = Buffer.from(body.setupCode);
    const expected = Buffer.from(env.ADMIN_BOOTSTRAP_SECRET);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(403).json({ error: 'invalid_setup_code', message: 'The setup code was not accepted.' });
      return;
    }
    if (body.password !== body.confirmPassword) {
      res.status(400).json({ error: 'password_mismatch', message: 'The passwords do not match.' });
      return;
    }

    const found = await pool.query<{ id: string }>(
      `SELECT "id" FROM "user" WHERE lower("email") = lower($1) LIMIT 1`,
      [ADMIN_EMAIL],
    );
    if (found.rows.length > 0) {
      res.status(409).json({
        error: 'admin_account_exists',
        message: 'This admin account already exists. Sign in with its current password.',
      });
      return;
    }

    const authResponse = await auth.handler(
      new Request(new URL('/auth/sign-up/email', env.BETTER_AUTH_URL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: req.headers.origin ?? env.WEB_ORIGIN,
          'user-agent': req.headers['user-agent'] ?? 'JEE Society admin bootstrap',
        },
        body: JSON.stringify({ name: 'JEE Society Admin', email: ADMIN_EMAIL, password: body.password }),
      }),
    );
    const result = await authResponse.json().catch(() => ({})) as {
      user?: { id?: string };
      message?: string;
      error?: string;
    };

    if (!authResponse.ok || !result.user?.id) {
      res.status(authResponse.status || 500).json({
        error: result.error ?? 'admin_setup_failed',
        message: result.message ?? 'Could not initialize the admin account.',
      });
      return;
    }

    await pool.query(
      `INSERT INTO admins (user_id, note)
       VALUES ($1, 'owner')
       ON CONFLICT (user_id) DO NOTHING`,
      [result.user.id],
    );

    log.warn({ userId: result.user.id }, 'bootstrap admin initialized');
    res.json({ ok: true, email: ADMIN_EMAIL });
  });

  return router;
}
