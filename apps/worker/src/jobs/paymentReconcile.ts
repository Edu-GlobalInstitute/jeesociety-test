import { SERVER_TIMING } from '@jee/shared';
import { payments, type Pool } from '@jee/db';
import type { Logger } from 'pino';
import type { Env } from '../env.js';

/**
 * Money captured but the webhook never delivered is a real scenario, and the
 * way a student finds out is by being refused entry to the lobby with a paid
 * receipt in their inbox. This job closes that gap by asking Razorpay directly
 * about every order still sitting in `created`.
 *
 * Runs continuously from registration opening until the test starts.
 */

interface RazorpayPaymentItem {
  id: string;
  order_id: string;
  status: string;
}

export async function reconcilePayments(
  pool: Pool,
  env: Env,
  log: Logger,
): Promise<{ checked: number; recovered: number }> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return { checked: 0, recovered: 0 };
  }

  const stuck = await payments.listStuckPayments(
    SERVER_TIMING.paymentReconcileAfterMs,
    100,
    pool,
  );
  if (stuck.length === 0) return { checked: 0, recovered: 0 };

  const auth = `Basic ${Buffer.from(
    `${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`,
  ).toString('base64')}`;

  let recovered = 0;
  for (const payment of stuck) {
    try {
      const response = await fetch(
        `https://api.razorpay.com/v1/orders/${payment.razorpay_order_id}/payments`,
        { headers: { authorization: auth } },
      );
      if (!response.ok) {
        log.warn(
          { orderId: payment.razorpay_order_id, status: response.status },
          'razorpay reconciliation lookup failed',
        );
        continue;
      }

      const body = (await response.json()) as { items?: RazorpayPaymentItem[] };
      const captured = body.items?.find((item) => item.status === 'captured');
      if (!captured) continue;

      // Same path the webhook takes, so a webhook arriving later is a no-op.
      const { applied } = await payments.markPaid(
        {
          orderId: payment.razorpay_order_id,
          paymentId: captured.id,
          rawWebhook: { source: 'reconciliation', payment: captured },
        },
        pool,
      );
      if (applied) {
        recovered += 1;
        log.warn(
          { orderId: payment.razorpay_order_id, paymentId: captured.id },
          'recovered a captured payment whose webhook never arrived',
        );
      }
    } catch (error) {
      log.warn(
        {
          orderId: payment.razorpay_order_id,
          err: error instanceof Error ? error.message : String(error),
        },
        'razorpay reconciliation error',
      );
    }
  }

  return { checked: stuck.length, recovered };
}
