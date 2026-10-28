import express, { Router } from 'express';
import { z } from 'zod';
import { payments, profiles, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireUser } from '../middleware/session.js';
import { badRequest, forbidden, notFound } from '../middleware/errors.js';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import {
  createOrder,
  verifyWebhookSignature,
  type RazorpayConfig,
  type WebhookEvent,
} from '../lib/razorpay.js';

/**
 * Payment is what admits a student to the lobby, so the thing that matters is
 * that a captured payment always ends up marked paid — even when Razorpay's
 * webhook is late, duplicated, or never arrives at all (the reconciliation job
 * in the worker covers the last case).
 */

export interface PaymentRouteDeps {
  pool: Pool;
  auth: Auth;
  env: Env;
  log: Logger;
  /** Injectable for tests; defaults to the real Razorpay API. */
  razorpay?: { createOrder: typeof createOrder };
}

export function paymentRoutes({
  pool,
  auth,
  env,
  log,
  razorpay = { createOrder },
}: PaymentRouteDeps): Router {
  const router = Router();
  const config: RazorpayConfig = {
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
  };

  /* ---------------------------------------------------------------------- */
  /* POST /payments/order                                                    */
  /* ---------------------------------------------------------------------- */
  router.post('/order', express.json(), requireUser(auth), async (req, res) => {
    const me = currentUser(req);
    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');

    if (await payments.hasPaid(me.id, test.id, pool)) {
      throw forbidden('already_paid', 'You have already paid for this test.');
    }

    /**
     * The profile gate. This is what makes /complete-profile mandatory rather
     * than a form a student can navigate past — particularly a Google student,
     * who arrives here with a session and nothing else.
     *
     * Checked server-side at the moment of sale, not just in the UI: taking
     * ₹300 from someone we have no phone number for means no way to reach them
     * if the exam date moves, and a refund to arrange by hand.
     */
    if (!(await profiles.isComplete(me.id, pool))) {
      throw forbidden(
        'profile_incomplete',
        'Add your mobile number and class before paying.',
      );
    }

    const order = await razorpay.createOrder(config, {
      amount: env.TEST_FEE_PAISE,
      receipt: `test-${test.id}-${me.id}`.slice(0, 40),
      notes: { userId: me.id, testId: String(test.id) },
    });

    await payments.createPayment(
      { userId: me.id, testId: test.id, orderId: order.id, amount: order.amount },
      pool,
    );

    log.info({ orderId: order.id, testId: test.id }, 'razorpay order created');
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: env.RAZORPAY_KEY_ID,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /payments/webhook                                                  */
  /* ---------------------------------------------------------------------- */
  /**
   * express.raw() is mounted on this route specifically, ahead of the JSON
   * parser in app.ts, because the HMAC is computed over the exact bytes
   * Razorpay sent. Re-serialising a parsed body changes key order and
   * whitespace and the signature stops matching.
   *
   * Access is never granted from a frontend callback: that path is forgeable,
   * and it also silently fails whenever a student closes the tab on the payment
   * success screen.
   */
  const WebhookSchema = z.object({
    event: z.string(),
    payload: z.object({
      payment: z
        .object({
          entity: z.object({
            id: z.string(),
            order_id: z.string(),
            status: z.string(),
            amount: z.number(),
          }),
        })
        .optional(),
    }),
  });

  router.post(
    '/webhook',
    express.raw({ type: '*/*', limit: '64kb' }),
    async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
      const signature = req.header('x-razorpay-signature');

      if (!verifyWebhookSignature(raw, signature, config.webhookSecret)) {
        log.warn({ hasSignature: Boolean(signature) }, 'webhook signature rejected');
        throw forbidden('bad_signature', 'Invalid webhook signature.');
      }

      let event: WebhookEvent;
      try {
        event = WebhookSchema.parse(JSON.parse(raw.toString('utf8'))) as WebhookEvent;
      } catch {
        throw badRequest('bad_payload', 'Webhook body was not the expected JSON.');
      }

      const entity = event.payload.payment?.entity;
      if (!entity) {
        // An event we do not act on. 200, because a 4xx makes Razorpay retry
        // something that will never succeed.
        res.json({ ok: true, ignored: event.event });
        return;
      }

      if (event.event === 'payment.captured' || entity.status === 'captured') {
        const { applied } = await payments.markPaid(
          { orderId: entity.order_id, paymentId: entity.id, rawWebhook: event },
          pool,
        );
        // Razorpay retries. razorpay_payment_id is UNIQUE and markPaid guards
        // on status, so a redelivery applies nothing and still answers 200.
        log.info(
          { orderId: entity.order_id, applied },
          applied ? 'payment captured' : 'duplicate webhook ignored',
        );
        res.json({ ok: true, applied });
        return;
      }

      if (event.event === 'payment.failed') {
        await payments.markPaymentFailed(entity.order_id, event, pool);
        res.json({ ok: true, applied: true });
        return;
      }

      res.json({ ok: true, ignored: event.event });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* GET /payments/status                                                    */
  /* ---------------------------------------------------------------------- */
  router.get('/status', requireUser(auth), async (req, res) => {
    const me = currentUser(req);
    const test = await tests.getCurrentTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');
    res.json({ paid: await payments.hasPaid(me.id, test.id, pool), testId: test.id });
  });

  return router;
}
