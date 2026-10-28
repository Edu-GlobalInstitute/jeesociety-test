import { z } from 'zod';

/**
 * The registration fields that are not Better Auth's (BUILD_PLAN s7.1, Q7).
 *
 * One schema, imported by the browser form and by the API route, for the reason
 * the rest of contract.ts gives: a field the form allows and the server rejects
 * is a student stuck on a page with no way forward, discovered on the day.
 *
 * This is also what makes Google sign-in work. Google hands back an email and a
 * name; everything a 300-rupee purchase actually needs — a number to reach the
 * student on, which cohort they are in, a guardian's consent when they are a
 * minor — is collected here, after the OAuth round trip and before checkout.
 */

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
  'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
  'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
] as const;

export const STUDENT_CLASSES = ['11', '12', 'dropper'] as const;
export type StudentClass = (typeof STUDENT_CLASSES)[number];

export const REFERRAL_SOURCES = [
  'A friend or classmate',
  'Instagram',
  'YouTube',
  'WhatsApp',
  'My school or coaching',
  'Google search',
  'Somewhere else',
] as const;

/**
 * Ten digits, 6-9 first. The browser gets the same rule the server applies, but
 * the server re-normalises before storing: this accepts what a student typed,
 * `lib/phone.ts` decides what is written. See its comment on why the two differ.
 */
const phoneField = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number starting 6, 7, 8 or 9.');

export const ProfileSchema = z
  .object({
    phone: phoneField,
    confirmPhone: phoneField,

    class: z.enum(STUDENT_CLASSES),
    targetYear: z.number().int().min(2026).max(2032),

    /** YYYY-MM-DD. Optional, but required in practice to resolve guardian consent. */
    dob: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker.')
      .optional(),

    state: z.enum(INDIAN_STATES).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    school: z.string().trim().min(1).max(160).optional(),

    guardianName: z.string().trim().min(2).max(120).optional(),
    guardianPhone: phoneField.optional(),
    /** The checkbox. Only meaningful alongside the two fields above. */
    guardianConsent: z.boolean().optional(),

    referralSource: z.string().trim().max(80).optional(),
  })
  // Typed twice, because there is no OTP to catch a wrong digit (s7.2).
  .refine((value) => value.phone === value.confirmPhone, {
    path: ['confirmPhone'],
    message: 'The two numbers do not match.',
  })
  // A guardian's number that is the student's own number is not a guardian's
  // number. Worth catching: it is the obvious way to click past this section.
  .refine((value) => !value.guardianPhone || value.guardianPhone !== value.phone, {
    path: ['guardianPhone'],
    message: "Use your parent or guardian's number, not your own.",
  });

export type ProfileInput = z.infer<typeof ProfileSchema>;

/**
 * The same schema, plus the under-18 rule.
 *
 * Minors are most of the intake, so consent is not an edge case — but it is
 * only collected when it applies, and `examDate` rather than today decides,
 * because a student who turns 18 the week before the paper is not a minor on it.
 */
export function profileSchemaFor(examDate: Date, isMinor: (dob: string) => boolean) {
  return ProfileSchema.superRefine((value, ctx) => {
    if (!value.dob) return;
    if (!isMinor(value.dob)) return;

    if (!value.guardianName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianName'],
        message: 'You are under 18 on the test date, so we need a parent or guardian.',
      });
    }
    if (!value.guardianPhone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianPhone'],
        message: "We need a parent or guardian's mobile number.",
      });
    }
    if (!value.guardianConsent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardianConsent'],
        message: 'A parent or guardian needs to consent before you can register.',
      });
    }
  });
}

/** What GET /profile returns. `complete` is what the site routes on. */
export const ProfileStatusSchema = z.object({
  complete: z.boolean(),
  /** Null until the student has filled the form. */
  profile: z
    .object({
      phone: z.string(),
      class: z.enum(STUDENT_CLASSES),
      targetYear: z.number().int(),
      dob: z.string().nullable(),
      state: z.string().nullable(),
      city: z.string().nullable(),
      school: z.string().nullable(),
      guardianName: z.string().nullable(),
      guardianPhone: z.string().nullable(),
      referralSource: z.string().nullable(),
    })
    .nullable(),
  /** Whether this account can sign in with a password, or only with Google. */
  hasPassword: z.boolean(),
  providers: z.array(z.string()),
});
export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;
