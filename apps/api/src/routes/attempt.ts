import { Router, type Request } from 'express';
import {
  CLIENT_TIMING,
  SERVER_TIMING,
  SubmitSchema,
  SyncSchema,
  answerLengths,
  generateReceipt,
  type AnswerMap,
  type TelemetryMap,
} from '@jee/shared';
import { attempts, payments, pick, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireUser } from '../middleware/session.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { badRequest, forbidden, notFound } from '../middleware/errors.js';
import type { Logger } from '../logger.js';

/**
 * The student-facing routes. Four of them, in the order a student meets them:
 * register (lobby), key (start instant), sync (every 90 s), submit (once).
 *
 * Every one whitelists its response. There is no res.json(row) in this file —
 * a `tests` row carries `paper_key` and `answer_key`, and one careless
 * serialisation of it would invalidate the entire event.
 */

export interface AttemptRouteDeps {
  pool: Pool;
  auth: Auth;
  log: Logger;
}

/** The client's real address, honest only because trust proxy is a hop count. */
function clientIp(req: Request): string | null {
  return req.ip ?? null;
}

export function attemptRoutes({ pool, auth, log }: AttemptRouteDeps): Router {
  const router = Router();
  const user = requireUser(auth);

  // 2 per minute per user. A client syncs once per 90 s, so this is ~3x its
  // normal rate and still catches a loop. See middleware/rateLimit.ts.
  const syncLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 2,
    message: 'Syncing too often. Your answers are saved locally and will sync shortly.',
  });

  /* ---------------------------------------------------------------------- */
  /* POST /attempt/register — the lobby. This is what admits a student.      */
  /* ---------------------------------------------------------------------- */
  router.post('/register', user, async (req, res) => {
    const me = currentUser(req);
    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');

    const now = Date.now();
    if (now < test.lobby_opens_at.getTime()) {
      throw forbidden(
        'lobby_closed',
        `The lobby opens at ${test.lobby_opens_at.toISOString()}.`,
      );
    }
    // The cutoff is here and nowhere else. A student who registers in time but
    // whose key request is slow still gets in.
    if (now >= test.starts_at.getTime()) {
      throw forbidden('registration_closed', 'Registration closed when the test began.');
    }
    if (!(await payments.hasPaid(me.id, test.id, pool))) {
      throw forbidden('not_paid', 'Complete payment to enter the test.');
    }

    const attempt = await attempts.registerAttempt(me.id, test.id, pool);
    if (!attempt) throw notFound('attempt_failed', 'Could not create the attempt.');

    log.info({ attemptId: attempt.id, testId: test.id }, 'attempt registered');
    res.json({
      attemptId: attempt.id,
      status: attempt.status,
      revision: attempt.revision,
      registeredAt: attempt.registered_at?.toISOString() ?? new Date().toISOString(),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* GET /attempt/key — the paper key, not one millisecond before starts_at. */
  /* ---------------------------------------------------------------------- */
  router.get('/key', user, async (req, res) => {
    const me = currentUser(req);
    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');

    const now = Date.now();
    if (now < test.starts_at.getTime()) {
      // Time is checked against the database clock, not the client's. A client
      // whose clock runs fast asks early and is told to wait.
      throw forbidden('not_started', 'The test has not started yet.');
    }
    if (now > test.ends_at.getTime() + SERVER_TIMING.submitGraceMs) {
      throw forbidden('test_over', 'The test window has closed.');
    }

    const attempt = await attempts.getAttemptForUser(me.id, test.id, pool);
    if (!attempt) {
      throw forbidden('not_registered', 'You did not register for this test in the lobby.');
    }
    if (attempt.submitted_at) {
      throw forbidden('already_submitted', 'This attempt has already been submitted.');
    }

    // Read through the one function allowed to touch key material. The guard on
    // starts_at is repeated inside it, in SQL, so a bug in the check above
    // cannot release the key early.
    const key = await tests.readPaperKeyForRelease(test.id, pool);
    if (!key) throw notFound('no_key', 'The paper is not ready. Contact an invigilator.');

    await attempts.markKeyIssued(attempt.id, pool);
    log.info({ attemptId: attempt.id }, 'paper key released');

    res.json({
      key,
      attemptId: attempt.id,
      endsAt: test.ends_at.getTime(),
      serverTime: Date.now(),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /attempt/sync — the hot path. ~1.2M requests per event.            */
  /* ---------------------------------------------------------------------- */
  router.post('/sync', user, syncLimiter, async (req, res) => {
    const me = currentUser(req);
    const body = SyncSchema.parse(req.body);

    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');
    if (Date.now() > test.ends_at.getTime()) {
      throw forbidden('window_closed', 'The test window has closed.');
    }

    const answers: AnswerMap = body.answers;
    const telemetry: TelemetryMap = body.telemetry ?? {};
    const ip = clientIp(req);

    const result = await attempts.syncAttempt(
      {
        attemptId: body.attemptId,
        userId: me.id,
        revision: body.revision,
        answers,
        telemetry,
        ip,
      },
      pool,
    );

    // Lengths only. Recorded whether or not the update applied, because a
    // late-arriving revision still describes real state at that point.
    await attempts.recordSnapshot(
      body.attemptId,
      body.revision,
      answerLengths(answers),
      ip,
      pool,
    );

    // A stale revision is 200, not an error. It means an out-of-order request
    // arrived, which is normal on these networks, and a 4xx would make every
    // client treat it as failure and retry-storm.
    res.json({
      ok: true,
      revision: result.revision,
      stale: !result.updated,
      serverTime: Date.now(),
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /attempt/submit — idempotent finalise. One row, no score, no LLM.  */
  /* ---------------------------------------------------------------------- */
  router.post('/submit', user, async (req, res) => {
    const me = currentUser(req);
    const body = SubmitSchema.parse(req.body);

    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');

    // The client spreads its submission across 45 s of jitter and then retries
    // with backoff, so the window here is deliberately wider than the test's.
    if (Date.now() > test.ends_at.getTime() + SERVER_TIMING.submitGraceMs) {
      throw forbidden(
        'window_closed',
        'The submission window has closed. Your answers were finalised automatically.',
      );
    }

    const result = await attempts.submitAttempt(
      {
        attemptId: body.attemptId,
        userId: me.id,
        revision: body.revision,
        answers: body.answers,
        telemetry: body.telemetry ?? {},
        receipt: generateReceipt(test.id),
      },
      pool,
    );

    if (!result) throw notFound('no_attempt', 'No such attempt.');

    log.info(
      { attemptId: body.attemptId, alreadySubmitted: result.alreadySubmitted },
      'attempt submitted',
    );

    // Already submitted is a 200 with the existing receipt. The student may
    // have double-clicked, or the client may have retried a request that
    // actually succeeded.
    res.json({
      ok: true,
      receipt: result.receipt,
      submittedAt: result.submittedAt.toISOString(),
      alreadySubmitted: result.alreadySubmitted,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* GET /attempt/state — resume support after a crash on a new machine.     */
  /* ---------------------------------------------------------------------- */
  router.get('/state', user, async (req, res) => {
    const me = currentUser(req);
    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');

    const attempt = await attempts.getAttemptForUser(me.id, test.id, pool);
    if (!attempt) throw notFound('no_attempt', 'No attempt for this test.');

    // A student on a replacement machine has no IndexedDB. This hands back the
    // last synced state so they resume where the server last heard from them.
    res.json({
      ...pick(attempt, ['id', 'revision', 'status', 'answers', 'telemetry']),
      submittedAt: attempt.submitted_at?.toISOString() ?? null,
      receipt: attempt.receipt,
      serverTime: Date.now(),
      endsAt: test.ends_at.getTime(),
    });
  });

  return router;
}

export const attemptTimings = CLIENT_TIMING;
export { badRequest };
