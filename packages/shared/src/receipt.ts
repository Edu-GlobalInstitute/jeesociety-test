/**
 * Receipts are shown to the student at submit and are the thing they screenshot
 * and quote in a support email, so the format is fixed and parseable:
 *   JEE-<testId>-<YYYYMMDD>-<6 digits>   manual submit
 *   JEE-<testId>-AUTO-<6 hex>            server-side auto-submit
 * The auto form is generated in SQL (see worker/autoSubmit.ts) so that the sweep
 * stays a single statement; this module owns the manual form and the parser.
 */

export function formatDatePart(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * The 6 digits are random, not sequential: a receipt should not disclose how
 * many students have submitted, and the uniqueness that matters is enforced by
 * the UNIQUE constraint on attempts.receipt plus submit's idempotency.
 */
export function generateReceipt(
  testId: number | string,
  now: Date = new Date(),
  random: () => number = Math.random,
): string {
  const digits = String(Math.floor(random() * 1_000_000)).padStart(6, '0');
  return `JEE-${testId}-${formatDatePart(now)}-${digits}`;
}

export interface ParsedReceipt {
  testId: string;
  auto: boolean;
  suffix: string;
}

export function parseReceipt(receipt: string): ParsedReceipt | null {
  const match = /^JEE-(\d+)-(AUTO|\d{8})-([0-9a-f]{6}|\d{6})$/i.exec(receipt);
  if (!match) return null;
  return {
    testId: match[1]!,
    auto: match[2]!.toUpperCase() === 'AUTO',
    suffix: match[3]!,
  };
}
