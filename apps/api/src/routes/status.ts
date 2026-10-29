import { Router } from 'express';
import { isExamOpen } from '@jee/shared';
import { attempts, payments, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireUser } from '../middleware/session.js';
import { notFound } from '../middleware/errors.js';

/**
 * GET /test/status drives the client's clock. Every timer in the exam app is
 * computed from `serverTime` rather than from the student's own clock, which is
 * routinely minutes off — getting this wrong would give some students 2h50m and
 * others 3h10m.
 *
 * It also carries `examOpen`, which is what lets the exam app render a
 * coming-soon screen rather than probing an endpoint and showing the student a
 * 403 — but the lock itself is enforced in attempt.ts, not here.
 *
 * Note what this does not return: no paper key, no answer key. The columns are
 * named explicitly in queries/tests.ts for exactly this reason.
 */
export function statusRoutes({ pool, auth }: { pool: Pool; auth: Auth }): Router {
  const router = Router();

  router.get('/status', requireUser(auth), async (req, res) => {
    const me = currentUser(req);
    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');

    const [paid, attempt] = await Promise.all([
      payments.hasPaid(me.id, test.id, pool),
      attempts.getAttemptForUser(me.id, test.id, pool),
    ]);

    res.json({
      testId: test.id,
      name: test.name,
      startsAt: test.starts_at.getTime(),
      endsAt: test.ends_at.getTime(),
      lobbyOpensAt: test.lobby_opens_at.getTime(),
      serverTime: Date.now(),
      paperUrl: test.paper_url,
      paid,
      examOpen: isExamOpen(test.status),
      attempt: attempt
        ? {
            id: attempt.id,
            status: attempt.status,
            revision: attempt.revision,
            submittedAt: attempt.submitted_at?.toISOString() ?? null,
            receipt: attempt.receipt,
          }
        : null,
    });
  });

  /**
   * GET /test/list — every published test, with this student's standing in each.
   *
   * What the dashboard renders. The scholarship test appears for everyone, as
   * it is the thing being sold; `canEnter` is what differs, and it is false
   * until the student has paid. Mocks are free and `canEnter` is true for any
   * signed-in student once they are live.
   *
   * `canEnter` is computed here for the UI, but it is not the lock: every one
   * of those conditions is re-checked by POST /attempt/register, which is the
   * only place that admits anyone. This endpoint decides what a button looks
   * like, not who gets in.
   */
  router.get('/list', requireUser(auth), async (req, res) => {
    const me = currentUser(req);
    const published = await tests.listPublishedTests(pool);

    const rows = await Promise.all(
      published.map(async (test) => {
        const [paid, attempt] = await Promise.all([
          // Only asked when it can matter: a free mock needs no payment lookup.
          test.requires_payment
            ? payments.hasPaid(me.id, test.id, pool)
            : Promise.resolve(true),
          attempts.getAttemptForUser(me.id, test.id, pool),
        ]);

        return {
          testId: test.id,
          name: test.name,
          kind: test.kind,
          requiresPayment: test.requires_payment,
          durationMinutes: test.duration_minutes,
          startsAt: test.starts_at.getTime(),
          endsAt: test.ends_at.getTime(),
          lobbyOpensAt: test.lobby_opens_at.getTime(),
          examOpen: isExamOpen(test.status),
          paid,
          canEnter: isExamOpen(test.status) && paid,
          attempt: attempt
            ? {
                id: attempt.id,
                status: attempt.status,
                submittedAt: attempt.submitted_at?.toISOString() ?? null,
                receipt: attempt.receipt,
              }
            : null,
        };
      }),
    );

    res.json({ serverTime: Date.now(), tests: rows });
  });

  /**
   * Unauthenticated clock reference. The exam client re-reads this every few
   * minutes to correct for drift, and it must not require a session: a student
   * whose session is being refreshed should never see their timer jump.
   */
  router.get('/time', (_req, res) => {
    res.json({ serverTime: Date.now() });
  });

  return router;
}
