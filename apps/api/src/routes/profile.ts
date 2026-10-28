import { Router } from 'express';
import { profileSchemaFor, TEST_STARTS_AT } from '@jee/shared';
import { profiles, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireUser } from '../middleware/session.js';
import { badRequest, conflict } from '../middleware/errors.js';
import { checkPhone, isMinorOn } from '../lib/phone.js';
import type { Logger } from '../logger.js';

/**
 * The registration fields Better Auth does not collect (BUILD_PLAN s7.1).
 *
 * This route exists because of Google sign-in. An email-and-password student
 * could in principle submit everything in one form, but a Google student
 * arrives back from the OAuth round trip with an account, a session, and no
 * phone number — so there has to be a place to finish, and one place is better
 * than two code paths that drift.
 *
 * `/payments/order` refuses an incomplete profile, which is what makes this
 * mandatory rather than a form students can skip past.
 */
export function profileRoutes({
  pool,
  auth,
  log,
}: {
  pool: Pool;
  auth: Auth;
  log: Logger;
}): Router {
  const router = Router();

  router.use(requireUser(auth));

  /** What the site routes on: whether to show the form or the pay button. */
  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const [profile, providers] = await Promise.all([
      profiles.getProfile(me.id, pool),
      profiles.authProviders(me.id, pool),
    ]);

    res.json({
      complete: profile?.profile_complete ?? false,
      profile: profile
        ? {
            phone: profile.phone,
            class: profile.class,
            targetYear: profile.target_year,
            // date, not timestamptz: toISOString would shift it a day
            // for anyone east of UTC, which is everyone sitting this paper.
            dob: profile.dob ? toDateString(profile.dob) : null,
            state: profile.state,
            city: profile.city,
            school: profile.school,
            guardianName: profile.guardian_name,
            guardianPhone: profile.guardian_phone,
            referralSource: profile.referral_source,
          }
        : null,
      // A Google-only account has no password row, so "forgot password" would
      // send an email that can never arrive. The site reads this to say so.
      hasPassword: providers.includes('credential'),
      providers,
    });
  });

  router.post('/', async (req, res) => {
    const me = currentUser(req);
    const examDate = new Date(TEST_STARTS_AT);

    // Minority is decided on the exam date, not today: a student who turns 18
    // the week before the paper is not a minor when they sit it.
    const schema = profileSchemaFor(examDate, (dob) => isMinorOn(dob, examDate));
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('invalid_profile', firstMessage(parsed.error.issues));
    }
    const input = parsed.data;

    // The browser validated the shape; this decides what is stored. "+91 98765
    // 43210" and "09876543210" are one number, and storing them as two would
    // make the UNIQUE index guard nothing.
    const phone = checkPhone(input.phone);
    if (!phone.ok) throw badRequest('invalid_phone', phone.reason);

    let guardianPhone: string | null = null;
    if (input.guardianPhone) {
      const checked = checkPhone(input.guardianPhone);
      if (!checked.ok) throw badRequest('invalid_guardian_phone', checked.reason);
      guardianPhone = checked.phone;
    }

    // Checked before the insert so the student gets advice ("log in instead")
    // rather than a constraint name. The insert still races, and the catch
    // below is what actually holds — this is for the message, not the rule.
    if (await profiles.phoneTakenByOther(phone.phone, me.id, pool)) {
      throw conflict(
        'phone_taken',
        'That mobile number is already registered. Log in to that account instead.',
      );
    }

    const isMinor = input.dob ? isMinorOn(input.dob, examDate) : false;

    try {
      const saved = await profiles.upsertProfile(
        {
          userId: me.id,
          phone: phone.phone,
          class: input.class,
          targetYear: input.targetYear,
          dob: input.dob ?? null,
          state: input.state ?? null,
          city: input.city ?? null,
          school: input.school ?? null,
          guardianName: input.guardianName ?? null,
          guardianPhone,
          // Only a minor's consent is recorded. Storing a timestamp for an
          // adult who happened to tick a box would misstate the record.
          guardianConsent: isMinor && input.guardianConsent === true,
          referralSource: input.referralSource ?? null,
        },
        pool,
      );

      if (phone.suspicious) {
        // Accepted and logged rather than rejected: 9876543210 is a descending
        // run and also a real number. See lib/phone.ts.
        log.warn({ userId: me.id }, 'profile saved with a sequential phone number');
      }

      res.json({ ok: true, complete: saved.profile_complete });
    } catch (error) {
      if (isUniqueViolation(error, 'student_profiles_phone_key')) {
        throw conflict(
          'phone_taken',
          'That mobile number is already registered. Log in to that account instead.',
        );
      }
      throw error;
    }
  });

  return router;
}

/** `date` columns come back as a Date at local midnight; keep the calendar day. */
function toDateString(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * One message, not a list. The form shows errors per field from its own copy of
 * the schema; this is the fallback for a request that bypassed it, so it needs
 * to be readable rather than complete.
 */
function firstMessage(issues: { path: (string | number)[]; message: string }[]): string {
  const first = issues[0];
  if (!first) return 'Check the form and try again.';
  return first.message;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { code?: string }).code === '23505'
    && (error as { constraint?: string }).constraint === constraint
  );
}
