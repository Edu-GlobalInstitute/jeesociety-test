import express, { Router } from 'express';
import { z } from 'zod';
import { coupons, payments, profiles, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireUser } from '../middleware/session.js';
import { badRequest, conflict, forbidden, notFound } from '../middleware/errors.js';
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

  const CouponCode = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/);
  async function quoteFor(userId: string, code: string) {
    const test = await tests.getScholarshipTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');
    if (await payments.hasPaid(userId, test.id, pool)) {
      throw forbidden('already_paid', 'You have already paid for this test.');
    }
    const coupon = await coupons.findActiveCouponByCode(code, pool);
    if (!coupon) throw notFound('coupon_invalid', 'That coupon code is invalid or inactive.');
    const redemption = await coupons.findRedemption({ couponId: coupon.id, userId }, pool);
    if (redemption?.redeemed_at) throw conflict('coupon_already_used', 'This coupon has already been used by this student.');
    const basePaise = env.TEST_FEE_PAISE;
    const discountPaise = Math.min(coupon.discount_paise, basePaise);
    return { test, coupon, basePaise, discountPaise, amount: basePaise - discountPaise };
  }

  router.post('/coupon/quote', express.json({ limit: '4kb' }), requireUser(auth), async (req, res) => {
    const me = currentUser(req);
    const { code } = z.object({ code: CouponCode }).parse(req.body);
    if (!(await profiles.isComplete(me.id, pool))) {
      throw forbidden('profile_incomplete', 'Complete your student profile before applying a coupon.');
    }
    const quote = await quoteFor(me.id, code);
    res.json({ code: quote.coupon.code, name: quote.coupon.name, basePaise: quote.basePaise,
      discountPaise: quote.discountPaise, amount: quote.amount, currency: 'INR' });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /payments/order                                                    */
  /* ---------------------------------------------------------------------- */
  router.post('/order', express.json(), requireUser(auth), async (req, res) => {
    const me = currentUser(req);
    // The scholarship test by name, not whichever test is soonest. Now that
    // mock tests exist, getCurrentTest can return a free mock opening tomorrow
    // — and an order created against it would charge a student for something
    // that is not for sale.
    const { couponCode } = z.object({ couponCode: CouponCode.optional() }).parse(req.body ?? {});
    const test = await tests.getScholarshipTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');

    if (await payments.hasPaid(me.id, test.id, pool)) {
      throw forbidden('already_paid', 'You have already paid for this test.');
    }

    /**
     * The profile gate. This is what makes /complete-profile mandatory rather
     * than a form a student can navigate past: sign-up does not collect a
     * phone number, so a student reaches this point with a session and little
     * else.
     *
     * Checked server-side at the moment of sale, not just in the UI: taking
     * ₹499 from someone we have no phone number for means no way to reach them
     * if the exam date moves, and a refund to arrange by hand.
     */
    if (!(await profiles.isComplete(me.id, pool))) {
      throw forbidden(
        'profile_incomplete',
        'Add your mobile number and class before paying.',
      );
    }

    const existing = await payments.getOpenPayment({ userId: me.id, testId: test.id }, pool);
    if (existing) {
      if ((existing.coupon_code ?? null) !== (couponCode ?? null)) {
        throw conflict('payment_pending', 'A payment is already pending. Finish it or wait for it to expire before changing the coupon.');
      }
      res.json({ orderId: existing.razorpay_order_id, amount: existing.amount,
        currency: 'INR', keyId: env.RAZORPAY_KEY_ID, couponCode: existing.coupon_code,
        discountPaise: existing.discount_paise, free: existing.amount === 0 });
      return;
    }

    const quote = couponCode ? await quoteFor(me.id, couponCode) : null;
    const amount = quote?.amount ?? env.TEST_FEE_PAISE;
    if (amount === 0 && quote) {
      const free = await payments.createFreeCouponPayment({ userId: me.id, testId: test.id,
        orderId: `free-${crypto.randomUUID()}`, coupon: { id: quote.coupon.id, code: quote.coupon.code,
          name: quote.coupon.name, discountPaise: quote.discountPaise } }, pool);
      res.json({ orderId: free?.razorpay_order_id, amount: 0, currency: 'INR', keyId: '',
        couponCode: quote.coupon.code, discountPaise: quote.discountPaise, free: true });
      return;
    }

    const order = await razorpay.createOrder(config, {
      amount,
      receipt: `test-${test.id}-${me.id}`.slice(0, 40),
      notes: { userId: me.id, testId: String(test.id) },
    });

    try {
      const saved = await payments.createOrderPayment({ userId: me.id, testId: test.id,
        orderId: order.id, amount: order.amount,
        ...(quote ? { coupon: { id: quote.coupon.id, code: quote.coupon.code, name: quote.coupon.name,
          discountPaise: quote.discountPaise } } : {}) }, pool);
      if (!saved.created && saved.payment) {
        throw conflict('payment_pending', 'A payment was started in another request. Please retry.');
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'COUPON_ALREADY_USED') throw conflict('coupon_already_used', 'This coupon has already been reserved or redeemed by this student.');
      if (code === 'COUPON_INACTIVE') throw conflict('coupon_invalid', 'That coupon is no longer active.');
      throw error;
    }

    log.info({ orderId: order.id, testId: test.id }, 'razorpay order created');
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: env.RAZORPAY_KEY_ID,
      couponCode: quote?.coupon.code ?? null,
      discountPaise: quote?.discountPaise ?? 0,
      free: false,
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
        const stored = await payments.getPaymentByOrderId(entity.order_id, pool);
        if (!stored || stored.amount !== entity.amount) {
          log.warn({ orderId: entity.order_id, amountMismatch: Boolean(stored) }, 'captured payment does not match stored order');
          throw conflict('payment_mismatch', 'Captured payment does not match the order amount.');
        }
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
    // Same reason as /order: "have I paid" means the scholarship test.
    const test = await tests.getScholarshipTest(pool);
    if (!test) throw notFound('no_test', 'There is no scheduled test.');
    res.json({ paid: await payments.hasPaid(me.id, test.id, pool), testId: test.id });
  });

  return router;
}
