import type { PaymentStatus } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

export interface PaymentRow {
  id: number;
  user_id: string;
  test_id: number;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  amount: number;
  status: PaymentStatus;
  created_at: Date;
}

const PAYMENT_COLUMNS = `
  id, user_id, test_id, razorpay_order_id, razorpay_payment_id, amount, status, created_at
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
    db,
  );
  if (updated) return { applied: true, payment: updated };
  return { applied: false, payment: await getPaymentByOrderId(params.orderId, db) };
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
      WHERE status = 'created'
        AND created_at < now() - make_interval(secs => $1::float8)
      ORDER BY created_at
      LIMIT $2`,
    [olderThanMs / 1000, limit],
    db,
  );
}
