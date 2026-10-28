/**
 * Indian mobile numbers, normalised to exactly ten digits.
 *
 * No OTP is sent (BUILD_PLAN s7.2, D-042), so this and the UNIQUE index on
 * student_profiles.phone are the only checks that exist. That makes the
 * normalisation the load-bearing part: "+91 98765 43210", "098765 43210" and
 * "9876543210" are one number, and if they are stored as three the UNIQUE
 * index guards nothing and three students arrive with one contact number.
 */

/** Digits only, with the country code and a trunk zero taken off. */
export function normalisePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  // +91 98765 43210 -> 9876543210. Only when the remainder is a plausible
  // mobile: 91 is also a legitimate opening for nothing in particular, so the
  // length check is what makes this safe to strip.
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(3);
  // A trunk zero, as dialled from a landline.
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/**
 * Numbers that are the right shape but obviously not real. A student who mashes
 * the keypad to get past the form is a student we cannot reach on the morning of
 * the test, so it is worth one cheap pass.
 *
 * Deliberately narrow: every rejection here is a real student locked out of a
 * ₹300 purchase, so it only catches patterns no issued number uses.
 */
const FAKE_PATTERNS: RegExp[] = [
  /^(\d)\1{9}$/, // 9999999999
  /^9{5}\d{5}$/, // 99999xxxxx — the lazy prefix
];

/** Strict ascending or descending runs: 9876543210, 6789012345. */
function isSequential(value: string): boolean {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < value.length; i += 1) {
    const step = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (step !== 1) ascending = false;
    if (step !== -1) descending = false;
  }
  return ascending || descending;
}

export type PhoneCheck =
  | { ok: true; phone: string; suspicious: boolean }
  | { ok: false; reason: string };

/**
 * Validates a number for storage.
 *
 * `suspicious` is the deliberate middle ground: 9876543210 is a descending run
 * and also a real, issued number, so it is accepted and flagged for admin
 * rather than rejected. Rejecting it would turn a working number into a lost
 * sale; accepting it silently would hide the one case worth a human glance.
 */
export function checkPhone(input: string): PhoneCheck {
  const phone = normalisePhone(input);

  if (phone.length !== 10) {
    return { ok: false, reason: 'Enter a 10-digit Indian mobile number.' };
  }
  // Indian mobile numbers start 6, 7, 8 or 9. Anything else is a landline, a
  // service code, or a typo.
  if (!/^[6-9]/.test(phone)) {
    return { ok: false, reason: 'An Indian mobile number starts with 6, 7, 8 or 9.' };
  }
  if (FAKE_PATTERNS.some((pattern) => pattern.test(phone))) {
    return { ok: false, reason: 'Enter the mobile number you actually use — we may need to reach you.' };
  }

  return { ok: true, phone, suspicious: isSequential(phone) };
}

/** True when the student is under 18 on `on`. Guardian consent turns on this. */
export function isMinorOn(dob: string, on: Date): boolean {
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = on.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age < 18;
}
