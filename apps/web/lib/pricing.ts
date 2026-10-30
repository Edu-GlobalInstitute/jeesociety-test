/**
 * What the checkout box charges, and the one coupon that changes it.
 *
 * Front-end only, on purpose. TEST_FEE_PAISE in @jee/shared/config is what the
 * payment route actually charges, and it is not touched here: these are the
 * numbers the checkout page shows while the real order route is not wired up
 * yet. When it is, this module is the single place that has to go.
 */

/** The price on the box before any coupon. */
export const LIST_PRICE = 499;

/** What the same test costs once the coupon below is applied. */
export const COUPON_PRICE = 299;

/** The one code that works, compared case-insensitively and trimmed. */
export const COUPON_CODE = 'JEE200';

export const COUPON_SAVING = LIST_PRICE - COUPON_PRICE;

/** True when what the student typed is the coupon, however they typed it. */
export function isCoupon(input: string): boolean {
  return input.trim().toUpperCase() === COUPON_CODE;
}
