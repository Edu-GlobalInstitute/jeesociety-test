import express, { Router } from 'express';
import { z } from 'zod';
import { admin, coupons, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireAdmin } from '../middleware/session.js';
import { conflict, notFound } from '../middleware/errors.js';
import { MAX_COUPON_DISCOUNT_PAISE, STANDARD_COUPON_DISCOUNT_PAISE } from '@jee/shared';

/**
 * A coupon, as the admin screen submits it.
 *
 * The discount is capped at the fee. It was capped at ten lakh, which let a
 * mistyped figure create a coupon worth two thousand times the ticket --
 * harmless at the till, because quoteFor clamps the discount to the fee and a
 * payment can never go negative, but the coupon would still read "₹1,000,000
 * off" wherever it was shown, and nobody would find out until a student asked.
 * Catching it here means it is caught while someone is looking at it.
 */
const CouponInput = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/),
  discountRupees: z
    .number()
    .finite()
    .min(0.01)
    .max(MAX_COUPON_DISCOUNT_PAISE / 100, {
      message: `A coupon cannot take off more than the ₹${MAX_COUPON_DISCOUNT_PAISE / 100} fee.`,
    })
    .refine((amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001),
  active: z.boolean().optional(),
});

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === '23505';
}

function view(row: coupons.CouponAdminRow | coupons.CouponRow) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    discountPaise: row.discount_paise,
    discountRupees: row.discount_paise / 100,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...('redeemed_count' in row
      ? { redeemedCount: row.redeemed_count, pendingCount: row.pending_count }
      : {}),
  };
}

export function adminCouponRoutes({ pool, auth }: { pool: Pool; auth: Auth }): Router {
  const router = Router();
  router.use(express.json({ limit: '16kb' }));
  router.use(requireAdmin(auth, pool));

  router.get('/', async (_req, res) => {
    const list = await coupons.listCouponsForAdmin(pool);
    res.json({
      coupons: list.map(view),
      // The form defaults to this, so every marketing code takes the same
      // amount off without anyone having to remember the figure.
      standardDiscountRupees: STANDARD_COUPON_DISCOUNT_PAISE / 100,
      maxDiscountRupees: MAX_COUPON_DISCOUNT_PAISE / 100,
    });
  });

  router.post('/', async (req, res) => {
    const me = currentUser(req);
    const body = CouponInput.parse(req.body);
    try {
      const created = await coupons.createCoupon(
        {
          name: body.name,
          code: body.code,
          discountPaise: Math.round(body.discountRupees * 100),
          createdBy: me.id,
        },
        pool,
      );
      if (!created) throw new Error('Coupon insert returned no row.');
      await admin.logAdminAction(
        {
          adminId: me.id,
          action: 'coupon_create',
          attemptId: null,
          questionId: null,
          before: null,
          after: { couponId: created.id, code: created.code, discountPaise: created.discount_paise },
          reason: 'coupon created from admin portal',
        },
        pool,
      );
      res.status(201).json({ coupon: view(created) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('coupon_code_exists', 'That coupon code is already in use.');
      }
      throw error;
    }
  });

  router.post('/:couponId', async (req, res) => {
    const me = currentUser(req);
    const id = z.coerce.number().int().positive().parse(req.params.couponId);
    const body = CouponInput.parse(req.body);
    const before = await coupons.findCouponById(id, pool);
    if (!before) throw notFound('coupon_not_found', 'No such coupon.');
    try {
      const updated = await coupons.updateCoupon(
        {
          id,
          name: body.name,
          code: body.code,
          discountPaise: Math.round(body.discountRupees * 100),
          active: body.active ?? before.active,
        },
        pool,
      );
      if (!updated) throw notFound('coupon_not_found', 'No such coupon.');
      await admin.logAdminAction(
        {
          adminId: me.id,
          action: 'coupon_update',
          attemptId: null,
          questionId: null,
          before: { couponId: id, code: before.code, discountPaise: before.discount_paise, active: before.active },
          after: { couponId: id, code: updated.code, discountPaise: updated.discount_paise, active: updated.active },
          reason: 'coupon updated from admin portal',
        },
        pool,
      );
      res.json({ coupon: view(updated) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('coupon_code_exists', 'That coupon code is already in use.');
      }
      throw error;
    }
  });

  return router;
}
