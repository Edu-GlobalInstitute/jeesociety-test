import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '../lib/razorpay.js';
import {
  createTest,
  createTestApi,
  request,
  signUp,
  type Student,
  type TestApi,
} from './helpers.js';

/**
 * Payments. The webhook is the only thing that grants access — a frontend
 * callback is forgeable and also silently fails whenever a student closes the
 * tab on the success screen.
 */

const SECRET = 'whsec_test';

let api: TestApi;
let student: Student;
let testId: number;

beforeAll(async () => {
  api = await createTestApi('apipay');
  ({ testId } = await createTest(api));
  student = await signUp(api);
});
afterAll(async () => {
  await api.close();
});

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

function capturedEvent(orderId: string, paymentId: string): string {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: paymentId, order_id: orderId, status: 'captured', amount: 50_000 },
      },
    },
  });
}

async function createOrder(orderId: string, forUser = student.userId): Promise<void> {
  await api.db.pool.query(
    `INSERT INTO payments (user_id, test_id, razorpay_order_id, amount, status)
          VALUES ($1, $2, $3, 50000, 'created')`,
    [forUser, testId, orderId],
  );
}

const post = (body: string, signature?: string) => {
  const req = request(api.app)
    .post('/payments/webhook')
    .set('content-type', 'application/json');
  if (signature !== undefined) req.set('x-razorpay-signature', signature);
  return req.send(body);
};

describe('verifyWebhookSignature', () => {
  it('accepts a correct signature over the raw bytes', () => {
    const body = '{"event":"payment.captured"}';
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature over different bytes', () => {
    expect(verifyWebhookSignature('{"a":1}', sign('{"a":2}'), SECRET)).toBe(false);
  });

  it('rejects a missing signature or an unset secret', () => {
    expect(verifyWebhookSignature('{}', undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature('{}', sign('{}'), '')).toBe(false);
  });

  it('rejects a short signature without throwing on the length mismatch', () => {
    // timingSafeEqual throws on unequal lengths, which would itself disclose
    // the expected length through the error path.
    expect(() => verifyWebhookSignature('{}', 'abc', SECRET)).not.toThrow();
    expect(verifyWebhookSignature('{}', 'abc', SECRET)).toBe(false);
  });
});

describe('POST /payments/webhook', () => {
  it('marks a payment paid on a valid signature', async () => {
    await createOrder('order_valid');
    const body = capturedEvent('order_valid', 'pay_valid');

    const response = await post(body, sign(body));
    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(true);

    const { rows } = await api.db.pool.query(
      `SELECT status, razorpay_payment_id FROM payments WHERE razorpay_order_id = $1`,
      ['order_valid'],
    );
    expect(rows[0]).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_valid' });
  });

  it('refuses a forged signature', async () => {
    await createOrder('order_forged');
    const body = capturedEvent('order_forged', 'pay_forged');

    const response = await post(body, 'deadbeef'.repeat(8));
    expect(response.status).toBe(403);

    const { rows } = await api.db.pool.query(
      `SELECT status FROM payments WHERE razorpay_order_id = $1`,
      ['order_forged'],
    );
    expect(rows[0]!.status).toBe('created');
  });

  it('refuses a request with no signature at all', async () => {
    const body = capturedEvent('order_none', 'pay_none');
    expect((await post(body)).status).toBe(403);
  });

  it('answers 200 to a redelivery without applying it twice', async () => {
    await createOrder('order_retry');
    const body = capturedEvent('order_retry', 'pay_retry');
    const signature = sign(body);

    const first = await post(body, signature);
    const second = await post(body, signature);
    const third = await post(body, signature);

    expect(first.body.applied).toBe(true);
    // A 4xx here would make Razorpay keep retrying a webhook that succeeded.
    expect(second.status).toBe(200);
    expect(second.body.applied).toBe(false);
    expect(third.status).toBe(200);

    const { rows } = await api.db.pool.query(
      `SELECT count(*) AS n FROM payments WHERE razorpay_order_id = $1`,
      ['order_retry'],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('ignores an event it does not act on, with a 200', async () => {
    const body = JSON.stringify({ event: 'order.paid', payload: {} });
    const response = await post(body, sign(body));
    expect(response.status).toBe(200);
    expect(response.body.ignored).toBe('order.paid');
  });

  it('records a failed payment without granting access', async () => {
    await createOrder('order_failed');
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_f', order_id: 'order_failed', status: 'failed', amount: 50_000 },
        },
      },
    });

    await post(body, sign(body));
    const { rows } = await api.db.pool.query(
      `SELECT status FROM payments WHERE razorpay_order_id = $1`,
      ['order_failed'],
    );
    expect(rows[0]!.status).toBe('failed');
  });

  it('is the only thing that grants lobby access', async () => {
    // Open the lobby first: the route checks the window before payment, so a
    // closed window would mask the refusal this test is about.
    await api.db.pool.query(
      `UPDATE tests SET starts_at = now() + interval '10 minutes',
                        ends_at = now() + interval '190 minutes',
                        lobby_opens_at = now() - interval '20 minutes'
        WHERE id = $1`,
      [testId],
    );

    // A student of their own: the earlier tests in this file already paid for
    // `student`, and hasPaid would mask the refusal.
    const fresh = await signUp(api);

    const before = await request(api.app)
      .post('/attempt/register')
      .set('Cookie', fresh.cookie)
      .send({});
    expect(before.body.error).toBe('not_paid');

    await createOrder('order_access', fresh.userId);
    const body = capturedEvent('order_access', 'pay_access');
    await post(body, sign(body));

    const after = await request(api.app)
      .post('/attempt/register')
      .set('Cookie', fresh.cookie)
      .send({});
    expect(after.status).toBe(200);
  });
});
