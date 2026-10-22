/**
 * Browser-side API client for the public site. The API lives on another origin,
 * so every call is credentialed and the API's CORS allowlist must include this
 * site's origin.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? 'unknown',
      body.message ?? `Something went wrong (${response.status}).`,
    );
  }
  return body as T;
}

export interface RazorpayOrder {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
}

/**
 * Opens Razorpay's checkout. Note what happens on success: nothing. Access is
 * granted by the server-to-server webhook, never by this callback — this path
 * is forgeable and it also fails silently whenever a student closes the tab on
 * the success screen.
 */
export function openCheckout(order: RazorpayOrder, onClosed: () => void): void {
  const razorpay = (window as unknown as { Razorpay?: new (options: unknown) => { open: () => void } })
    .Razorpay;
  if (!razorpay) {
    onClosed();
    return;
  }
  new razorpay({
    key: order.keyId,
    amount: order.amount,
    currency: order.currency,
    order_id: order.orderId,
    name: 'All-India JEE Mock',
    description: 'Test registration',
    handler: onClosed,
    modal: { ondismiss: onClosed },
  }).open();
}
