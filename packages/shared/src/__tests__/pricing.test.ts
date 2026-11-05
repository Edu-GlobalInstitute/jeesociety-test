import { describe, expect, it } from 'vitest';
import {
  MAX_COUPON_DISCOUNT_PAISE,
  MENTORSHIP,
  STANDARD_COUPON_DISCOUNT_PAISE,
  TEST_FEE_PAISE,
} from '../config.js';

/**
 * The price, pinned.
 *
 * Every page that quotes a figure and the route that charges it read
 * TEST_FEE_PAISE, so they cannot disagree with each other — but nothing stopped
 * the constant itself from being edited to a value the business did not intend,
 * and a wrong number here is wrong everywhere at once, silently, including on
 * Razorpay's screen after a student has decided to pay.
 *
 * So the agreed price is written down twice: once as the constant the code
 * uses, and once here as the figure a human confirmed. Changing the price means
 * changing both, which makes it a deliberate act rather than a typo.
 */

/** The agreed entry fee, in rupees. Confirmed with the site owner. */
const AGREED_FEE_RUPEES = 499;

describe('the entry fee', () => {
  it(`is ₹${AGREED_FEE_RUPEES}`, () => {
    expect(TEST_FEE_PAISE).toBe(AGREED_FEE_RUPEES * 100);
  });

  /**
   * Razorpay takes paise as an integer. A rupee value with a fractional part
   * would be silently truncated or rejected by the API depending on where it
   * entered, so the constant has to be whole paise.
   */
  it('is a whole number of paise', () => {
    expect(Number.isInteger(TEST_FEE_PAISE)).toBe(true);
    expect(TEST_FEE_PAISE).toBeGreaterThan(0);
  });

  /**
   * Formatting is what a student actually reads. Every page builds its figure
   * the same way — paise / 100, then toLocaleString('en-IN') — so this is the
   * string the site displays, and at this price it must carry no separator and
   * no decimals.
   */
  it('renders as a plain ₹499 with no decimals or separators', () => {
    const shown = (TEST_FEE_PAISE / 100).toLocaleString('en-IN');
    expect(shown).toBe('499');
    expect(`₹${shown}`).toBe('₹499');
  });

  /**
   * The prize has to be worth visibly more than the ticket, or the offer makes
   * no sense to the student being asked to pay.
   */
  it('is far below the mentorship seat it can win', () => {
    expect(MENTORSHIP.worthRupees * 100).toBeGreaterThan(TEST_FEE_PAISE);
  });
});

/**
 * Coupons.
 *
 * Every marketing code takes the same amount off, so a student comparing two
 * codes is never told one is worth more than another. The figures are pinned
 * the same way the fee is: stated independently here, so changing one is two
 * deliberate edits rather than a typo.
 */
describe('the standard coupon', () => {
  /** What the codes promise students: ₹499 − ₹200 = ₹299. */
  const AGREED_DISCOUNT_RUPEES = 200;

  it(`takes ₹${AGREED_DISCOUNT_RUPEES} off`, () => {
    expect(STANDARD_COUPON_DISCOUNT_PAISE).toBe(AGREED_DISCOUNT_RUPEES * 100);
  });

  it('leaves a payable amount, not a free seat', () => {
    const payable = TEST_FEE_PAISE - STANDARD_COUPON_DISCOUNT_PAISE;
    expect(payable).toBeGreaterThan(0);
    expect(payable).toBe(29_900);
  });

  /**
   * A coupon worth more than the ticket is not a discount, it is a free seat
   * with extra steps. The payment route clamps as well, so a quote can never
   * go negative — this stops the figure being wrong in the first place.
   */
  it('cannot be created for more than the fee', () => {
    expect(MAX_COUPON_DISCOUNT_PAISE).toBe(TEST_FEE_PAISE);
    expect(STANDARD_COUPON_DISCOUNT_PAISE).toBeLessThanOrEqual(MAX_COUPON_DISCOUNT_PAISE);
  });

  it('is a whole number of paise, since Razorpay takes integers', () => {
    expect(Number.isInteger(STANDARD_COUPON_DISCOUNT_PAISE)).toBe(true);
  });
});
