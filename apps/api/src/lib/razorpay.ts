import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A thin client over Razorpay's REST API. Three calls are needed — create an
 * order, read an order's payments, read a payment — so this is hand-rolled
 * rather than pulling in an SDK whose surface is mostly unused.
 */

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amount: number;
}

const API = 'https://api.razorpay.com/v1';

function authHeader(config: RazorpayConfig): string {
  return `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;
}

export async function createOrder(
  config: RazorpayConfig,
  params: { amount: number; receipt: string; notes?: Record<string, string> },
): Promise<RazorpayOrder> {
  const response = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { authorization: authHeader(config), 'content-type': 'application/json' },
    body: JSON.stringify({
      amount: params.amount,
      currency: 'INR',
      receipt: params.receipt,
      notes: params.notes,
      payment_capture: 1,
    }),
  });
  if (!response.ok) {
    throw new Error(`razorpay order failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as RazorpayOrder;
}

/** Used by the reconciliation job: did this order actually get paid? */
export async function listOrderPayments(
  config: RazorpayConfig,
  orderId: string,
): Promise<RazorpayPayment[]> {
  const response = await fetch(`${API}/orders/${orderId}/payments`, {
    headers: { authorization: authHeader(config) },
  });
  if (!response.ok) {
    throw new Error(`razorpay payments fetch failed: ${response.status}`);
  }
  const body = (await response.json()) as { items?: RazorpayPayment[] };
  return body.items ?? [];
}

/**
 * Verifies a webhook signature.
 *
 * Two things matter here and both are easy to get wrong:
 *  - the HMAC is over the **raw** request body, byte for byte, so the route
 *    mounts express.raw() ahead of the JSON parser;
 *  - the comparison is timing-safe, so a signature cannot be discovered one
 *    byte at a time.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  webhookSecret: string,
): boolean {
  if (!signature || !webhookSecret) return false;

  const expected = createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  const received = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // expected length; check it first and return the same `false` either way.
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
}

export interface WebhookEvent {
  event: string;
  payload: {
    payment?: { entity: RazorpayPayment };
    order?: { entity: RazorpayOrder };
  };
}
