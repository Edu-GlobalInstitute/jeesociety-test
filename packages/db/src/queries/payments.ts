import type { PaymentStatus } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';
import { getPool, withTransaction, type Pool } from '../pool.js';

export interface PaymentRow {
  id: number;
  user_id: string;
  test_id: number;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  amount: number;
  status: PaymentStatus;
  coupon_id: number | null;
  coupon_code: string | null;
  coupon_name: string | null;
  discount_paise: number;
  created_at: Date;
}

const PAYMENT_COLUMNS = `
  id, user_id, test_id, razorpay_order_id, razorpay_payment_id, amount, status,
  coupon_id, coupon_code, coupon_name, discount_paise, created_at
`;

export function createPayment(
  params: { userId: string; testId: number; orderId: string; amount: number },
  db?: Queryable,
): Promise<PaymentRow | null> {
  return one<PaymentRow>(
    `INSERT INTO payments (user_id, test_id, razorpay_order_id, amount)
          VALUES ($1, $2, $3, $4)
       RETURNING ${PAYMENT_COLUMNS}`,
    [params.userId, params.testId, params.orderId, params.amount],
    db,
  );
}

/** Returns the latest unpaid order so retries reuse the same provider order. */
export function getOpenPayment(
  params: { userId: string; testId: number },
  db?: Queryable,
): Promise<PaymentRow | null> {
  return one<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments
      WHERE user_id = $1 AND test_id = $2 AND status IN ('created', 'failed')
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [params.userId, params.testId],
    db,
  );
}

/**
 * Stores a provider order and its coupon hold atomically. A unique pending
 * order index prevents double-click races; the coupon/user constraint prevents
 * a second order from reserving the same code for the same student.
 */
export async function createOrderPayment(
  params: {
    userId: string;
    testId: number;
    orderId: string;
    amount: number;
    coupon?: { id: number; code: string; name: string; discountPaise: number };
  },
  pool: Pool,
): Promise<{ payment: PaymentRow | null; created: boolean }> {
  return withTransaction(async (client) => {
    const open = await getOpenPayment({ userId: params.userId, testId: params.testId }, client);
    if (open) return { payment: open, created: false };

    if (params.coupon) {
      const active = await one<{ id: number }>(
        `SELECT id FROM coupons WHERE id = $1 AND active = true FOR UPDATE`,
        [params.coupon.id],
        client,
      );
      if (!active) {
        const error = new Error('This coupon is no longer active.') as Error & { code: string };
        error.code = 'COUPON_INACTIVE';
        throw error;
      }
    }

    const inserted = await one<PaymentRow>(
      `INSERT INTO payments (
         user_id, test_id, razorpay_order_id, amount,
         coupon_id, coupon_code, coupon_name, discount_paise
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING ${PAYMENT_COLUMNS}`,
      [
        params.userId,
        params.testId,
        params.orderId,
        params.amount,
        params.coupon?.id ?? null,
        params.coupon?.code ?? null,
        params.coupon?.name ?? null,
        params.coupon?.discountPaise ?? 0,
      ],
      client,
    );
    if (!inserted) {
      const concurrent = await getOpenPayment({ userId: params.userId, testId: params.testId }, client);
      return { payment: concurrent, created: false };
    }

    if (params.coupon) {
      const redemption = await one<{ id: number }>(
        `INSERT INTO coupon_redemptions (
           coupon_id, user_id, test_id, payment_id, discount_paise
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (coupon_id, user_id) DO NOTHING
         RETURNING id`,
        [params.coupon.id, params.userId, params.testId, inserted.id, params.coupon.discountPaise],
        client,
      );
      if (!redemption) {
        const error = new Error('This student has already reserved or redeemed this coupon.') as Error & {
          code: string;
        };
        error.code = 'COUPON_ALREADY_USED';
        throw error;
      }
    }
    return { payment: inserted, created: true };
  }, pool);
}

/** A full-discount coupon creates a paid-access record without charging Razorpay. */
export async function createFreeCouponPayment(
  params: {
    userId: string;
    testId: number;
    orderId: string;
    coupon: { id: number; code: string; name: string; discountPaise: number };
  },
  pool: Pool,
): Promise<PaymentRow | null> {
  return withTransaction(async (client) => {
    const open = await getOpenPayment({ userId: params.userId, testId: params.testId }, client);
    if (open) return open;

    const active = await one<{ id: number }>(
      `SELECT id FROM coupons WHERE id = $1 AND active = true FOR UPDATE`,
      [params.coupon.id],
      client,
    );
    if (!active) {
      const error = new Error('This coupon is no longer active.') as Error & { code: string };
      error.code = 'COUPON_INACTIVE';
      throw error;
    }

    const inserted = await one<PaymentRow>(
      `INSERT INTO payments (
         user_id, test_id, razorpay_order_id, amount, status,
         coupon_id, coupon_code, coupon_name, discount_paise
       ) VALUES ($1, $2, $3, 0, 'paid', $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING ${PAYMENT_COLUMNS}`,
      [
        params.userId,
        params.testId,
        params.orderId,
        params.coupon.id,
        params.coupon.code,
        params.coupon.name,
        params.coupon.discountPaise,
      ],
      client,
    );
    if (!inserted) return getOpenPayment({ userId: params.userId, testId: params.testId }, client);

    const redemption = await one<{ id: number }>(
      `INSERT INTO coupon_redemptions (
         coupon_id, user_id, test_id, payment_id, discount_paise, redeemed_at
       ) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (coupon_id, user_id) DO NOTHING
       RETURNING id`,
      [params.coupon.id, params.userId, params.testId, inserted.id, params.coupon.discountPaise],
      client,
    );
    if (!redemption) {
      const error = new Error('This student has already reserved or redeemed this coupon.') as Error & {
        code: string;
      };
      error.code = 'COUPON_ALREADY_USED';
      throw error;
    }
    return inserted;
  }, pool);
}

export function getPaymentByOrderId(
  orderId: string,
  db?: Queryable,
): Promise<PaymentRow | null> {
  return one<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE razorpay_order_id = $1`,
    [orderId],
    db,
  );
}

/**
 * Marks a payment captured.
 *
 * Razorpay retries webhooks, so this must be safe to run many times with the
 * same body. razorpay_payment_id is UNIQUE and the guard on status means the
 * second delivery updates nothing and the route still answers 200 — a 4xx would
 * make Razorpay keep retrying a webhook that already succeeded.
 */
export async function markPaid(
  params: { orderId: string; paymentId: string; rawWebhook: unknown },
  db?: Queryable,
): Promise<{ applied: boolean; payment: PaymentRow | null }> {
  const run = async (client: Queryable) => {
    const updated = await one<PaymentRow>(
      `UPDATE payments
          SET status = 'paid',
              razorpay_payment_id = $2,
              raw_webhook = $3,
              updated_at = now()
        WHERE razorpay_order_id = $1
          AND status <> 'paid'
        RETURNING ${PAYMENT_COLUMNS}`,
      [params.orderId, params.paymentId, JSON.stringify(params.rawWebhook)],
      client,
    );
    if (!updated) return { applied: false, payment: await getPaymentByOrderId(params.orderId, client) };
    await rows(
      `UPDATE coupon_redemptions
          SET redeemed_at = COALESCE(redeemed_at, now())
        WHERE payment_id = $1`,
      [updated.id],
      client,
    );
    return { applied: true, payment: updated };
  };

  const target = db ?? getPool();
  if ('connect' in target && typeof target.connect === 'function') {
    return withTransaction(run, target as Pool);
  }
  // Callers supplying a transaction client already own the transaction.
  return run(target);
}

export async function markPaymentFailed(
  orderId: string,
  rawWebhook: unknown,
  db?: Queryable,
): Promise<void> {
  await rows(
    `UPDATE payments
        SET status = 'failed', raw_webhook = $2, updated_at = now()
      WHERE razorpay_order_id = $1 AND status = 'created'`,
    [orderId, JSON.stringify(rawWebhook)],
    db,
  );
}

export async function hasPaid(
  userId: string,
  testId: number,
  db?: Queryable,
): Promise<boolean> {
  const row = await one<{ paid: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payments
        WHERE user_id = $1 AND test_id = $2 AND status = 'paid'
     ) AS paid`,
    [userId, testId],
    db,
  );
  return row?.paid ?? false;
}

/**
 * Money captured but the webhook never delivered is a real scenario, and the
 * student finds out by being refused entry to the lobby. The reconciliation job
 * reads these and asks Razorpay directly.
 */
export function listStuckPayments(
  olderThanMs: number,
  limit = 200,
  db?: Queryable,
): Promise<PaymentRow[]> {
  return rows<PaymentRow>(
    `SELECT ${PAYMENT_COLUMNS}
       FROM payments
      WHERE status IN ('created', 'failed')
        AND created_at < now() - make_interval(secs => $1::float8)
      ORDER BY created_at
      LIMIT $2`,
    [olderThanMs / 1000, limit],
    db,
  );
}
