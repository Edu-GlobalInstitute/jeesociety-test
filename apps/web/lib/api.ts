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
export interface CheckoutPrefill {
  /** Shown on Razorpay's screen so the student knows whose payment this is. */
  name?: string | null;
  email?: string | null;
  /** Ten digits; Razorpay prefixes the country code itself. */
  contact?: string | null;
}

export type CheckoutOutcome = 'submitted' | 'dismissed' | 'unavailable';

/**
 * Opens Razorpay's checkout.
 *
 * Note what happens on success: nothing. Access is granted by the
 * server-to-server webhook, never by this callback — that path is forgeable,
 * and it also never fires when a student closes the tab on the success screen.
 *
 * What the callback does carry is *which* way the window closed, which the page
 * needs in order to say something true. `handler` means the student submitted a
 * payment and the webhook is now expected; `ondismiss` means they closed the
 * window and nothing is coming. Reporting both as "we are confirming your
 * payment" left someone who had simply changed their mind watching a spinner
 * for a minute and then reading that their money may arrive shortly.
 *
 * Prefilling matters more than it looks: Razorpay asks for a phone number, and
 * a student who has already given us one should not have to find it again on a
 * payment screen.
 */
export function openCheckout(
  order: RazorpayOrder,
  onClosed: (outcome: CheckoutOutcome) => void,
  prefill: CheckoutPrefill = {},
): void {
  const razorpay = (window as unknown as { Razorpay?: new (options: unknown) => { open: () => void } })
    .Razorpay;
  if (!razorpay) {
    // The script is blocked or has not loaded. Saying so beats a dead button.
    onClosed('unavailable');
    return;
  }

  // Razorpay fires ondismiss after handler in some flows; only the first
  // outcome is the real one.
  let settled = false;
  const settle = (outcome: CheckoutOutcome) => {
    if (settled) return;
    settled = true;
    onClosed(outcome);
  };

  new razorpay({
    key: order.keyId,
    amount: order.amount,
    currency: order.currency,
    order_id: order.orderId,
    name: 'JEEsociety',
    description: 'Scholarship test registration',
    prefill: {
      ...(prefill.name ? { name: prefill.name } : {}),
      ...(prefill.email ? { email: prefill.email } : {}),
      ...(prefill.contact ? { contact: prefill.contact } : {}),
    },
    // The site's own accent, so the payment screen does not look like a
    // different company's.
    theme: { color: '#ff8c42' },
    retry: { enabled: false },
    handler: () => settle('submitted'),
    modal: { ondismiss: () => settle('dismissed') },
  }).open();
}

/**
 * Turns a thrown API error into a sentence worth showing an admin.
 *
 * Several admin screens used to answer "Admin access is required." for every
 * failure, including a 500 — so a missing database migration looked like a
 * permissions problem and sent people to the wrong fix entirely. The whole
 * reason the dashboard outage took so long to place was that the one screen
 * that knew the answer threw it away.
 *
 * The rules are the ones that actually distinguish the causes:
 *   401  the session went, not a permissions problem
 *   403  genuinely not an admin
 *   5xx  the server broke, and on this deployment that is nearly always a
 *        migration that has not been run against this environment
 */
export function adminErrorMessage(error: unknown, what = 'that'): string {
  const status = error instanceof ApiError ? error.status : 0;
  const detail = error instanceof Error ? error.message : String(error);

  if (status === 401) return 'Your session has expired. Sign in again.';
  if (status === 403) {
    return 'Admin access is required. Ask for your account to be added to the admins table.';
  }
  if (status >= 500) {
    return (
      `The server could not load ${what} (${status}). This usually means a database `
      + `migration has not been run against this environment. Server said: ${detail}`
    );
  }
  if (status === 0) {
    return `Could not reach the server. Check your connection. (${detail})`;
  }
  return `Could not load ${what}. ${detail}`;
}
