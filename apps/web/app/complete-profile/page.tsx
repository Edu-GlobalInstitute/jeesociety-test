'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  INDIAN_STATES,
  REFERRAL_SOURCES,
  STUDENT_CLASSES,
  TEST_STARTS_AT,
} from '@jee/shared';
import '../auth.css';
import { ApiError, api } from '../../lib/api';
import { getProfile } from '../../lib/auth';

/**
 * Step two: the details Better Auth does not collect.
 *
 * This page is the reason Google sign-in works at all. Google returns an email
 * and a name, and a ₹300 purchase needs a number to reach the student on, the
 * cohort they are in, and a guardian's consent when they are a minor — so there
 * has to be one place to finish, reached the same way from both routes in.
 *
 * It is mandatory rather than skippable: POST /payments/order refuses an
 * incomplete profile, so there is no path to checkout around this form.
 *
 * Validation here mirrors packages/shared/src/profile.ts, which the API applies
 * to the same request. The duplication is the point — the student is told before
 * the round trip, and the server does not trust what the browser decided.
 */

const EXAM_DATE = new Date(TEST_STARTS_AT);
const THIS_YEAR = EXAM_DATE.getFullYear();
/** 2026…2032, matching the CHECK on student_profiles.target_year. */
const TARGET_YEARS = [THIS_YEAR, THIS_YEAR + 1, THIS_YEAR + 2];

/** Under 18 on the exam date, not today: the rule the server applies. */
function isMinorOn(dob: string, on: Date): boolean {
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return false;
  let age = on.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = on.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age < 18;
}

const digits = (value: string) => value.replace(/\D/g, '').slice(0, 10);

type Errors = Record<string, string>;

export default function CompleteProfile() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});

  const [phone, setPhone] = useState('');
  const [confirmPhone, setConfirmPhone] = useState('');
  const [klass, setKlass] = useState<'' | (typeof STUDENT_CLASSES)[number]>('');
  const [targetYear, setTargetYear] = useState<number | ''>('');
  const [dob, setDob] = useState('');
  const [state, setState] = useState('');
  const [city, setCity] = useState('');
  const [school, setSchool] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [referralSource, setReferralSource] = useState('');

  const minor = useMemo(() => (dob ? isMinorOn(dob, EXAM_DATE) : false), [dob]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const profile = await getProfile().catch(() => null);
      if (!live) return;
      if (!profile) {
        window.location.href = '/login';
        return;
      }
      // Prefill when they are editing rather than filling it the first time.
      if (profile.profile) {
        const existing = profile.profile;
        setPhone(existing.phone);
        setConfirmPhone(existing.phone);
        setKlass(existing.class);
        setTargetYear(existing.targetYear);
        setDob(existing.dob ?? '');
        setState(existing.state ?? '');
        setCity(existing.city ?? '');
        setSchool(existing.school ?? '');
        setGuardianName(existing.guardianName ?? '');
        setGuardianPhone(existing.guardianPhone ?? '');
        // Consent already recorded server-side; the box reflects that.
        setGuardianConsent(Boolean(existing.guardianName));
        setReferralSource(existing.referralSource ?? '');
      }
      setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, []);

  function validate(): Errors {
    const found: Errors = {};
    if (!/^[6-9]\d{9}$/.test(phone)) {
      found.phone = 'Enter a 10-digit mobile number starting 6, 7, 8 or 9.';
    }
    if (confirmPhone !== phone) found.confirmPhone = 'The two numbers do not match.';
    if (!klass) found.class = 'Choose your class.';
    if (!targetYear) found.targetYear = 'Choose the year you sit JEE.';

    if (minor) {
      if (guardianName.trim().length < 2) {
        found.guardianName = "Enter your parent or guardian's name.";
      }
      if (!/^[6-9]\d{9}$/.test(guardianPhone)) {
        found.guardianPhone = "Enter your parent or guardian's 10-digit mobile number.";
      } else if (guardianPhone === phone) {
        found.guardianPhone = "Use your parent or guardian's number, not your own.";
      }
      if (!guardianConsent) {
        found.guardianConsent = 'A parent or guardian needs to consent before you can register.';
      }
    }
    return found;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Move focus to the first problem rather than leaving the student to
      // hunt for it on a form this long.
      document.getElementById(Object.keys(found)[0]!)?.focus();
      return;
    }

    setBusy(true);
    setBanner(null);
    try {
      await api('/profile', {
        method: 'POST',
        body: JSON.stringify({
          phone,
          confirmPhone,
          class: klass,
          targetYear: Number(targetYear),
          dob: dob || undefined,
          state: state || undefined,
          city: city.trim() || undefined,
          school: school.trim() || undefined,
          guardianName: minor ? guardianName.trim() : undefined,
          guardianPhone: minor ? guardianPhone : undefined,
          guardianConsent: minor ? guardianConsent : undefined,
          referralSource: referralSource || undefined,
        }),
      });
      window.location.href = '/register';
    } catch (caught) {
      setBusy(false);
      if (caught instanceof ApiError && caught.code === 'phone_taken') {
        setErrors({ phone: caught.message });
        document.getElementById('phone')?.focus();
        return;
      }
      setBanner(
        caught instanceof ApiError
          ? caught.message
          : 'We could not save your details. Try again in a moment.',
      );
    }
  }

  if (loading) {
    return (
      <main className="auth">
        <div className="auth__card">
          <p className="auth__sub">Loading…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth">
      <div className="auth__card auth__card--wide">
        <h1 className="auth__title">A few details</h1>
        <p className="auth__sub">
          This is how we reach you about the paper, and how your rank is placed in the right
          cohort. It takes a minute.
        </p>

        <p className="auth__steps">
          <span className="auth__step auth__step--done">
            <b>✓</b> Account
          </span>
          <span aria-hidden="true">→</span>
          <span className="auth__step auth__step--now">
            <b>2</b> Your details
          </span>
          <span aria-hidden="true">→</span>
          <span className="auth__step">
            <b>3</b> Pay
          </span>
        </p>

        <div className="auth__panel">
          {banner ? (
            <div className="notice" role="alert">
              {banner}
            </div>
          ) : null}

          <form onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="phone">Mobile number</label>
              <div className="field__phone">
                <span className="field__prefix">+91</span>
                <input
                  id="phone"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  value={phone}
                  onChange={(event) => setPhone(digits(event.target.value))}
                  aria-invalid={errors.phone ? 'true' : undefined}
                  required
                />
              </div>
              {errors.phone ? (
                <span className="field__error">{errors.phone}</span>
              ) : (
                <span className="field__hint">
                  We use this only if something about the test day changes.
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor="confirmPhone">Type your number again</label>
              <div className="field__phone">
                <span className="field__prefix">+91</span>
                <input
                  id="confirmPhone"
                  inputMode="numeric"
                  value={confirmPhone}
                  onChange={(event) => setConfirmPhone(digits(event.target.value))}
                  aria-invalid={errors.confirmPhone ? 'true' : undefined}
                  required
                />
              </div>
              {errors.confirmPhone ? (
                <span className="field__error">{errors.confirmPhone}</span>
              ) : (
                <span className="field__hint">
                  There is no OTP, so a wrong digit here is a number we cannot reach.
                </span>
              )}
            </div>

            <div className="auth__row">
              <div className="field">
                <label htmlFor="class">Class</label>
                <select
                  id="class"
                  value={klass}
                  onChange={(event) =>
                    setKlass(event.target.value as (typeof STUDENT_CLASSES)[number])
                  }
                  aria-invalid={errors.class ? 'true' : undefined}
                  required
                >
                  <option value="">Choose…</option>
                  <option value="11">Class 11</option>
                  <option value="12">Class 12</option>
                  <option value="dropper">Dropper</option>
                </select>
                {errors.class ? <span className="field__error">{errors.class}</span> : null}
              </div>

              <div className="field">
                <label htmlFor="targetYear">You sit JEE in</label>
                <select
                  id="targetYear"
                  value={targetYear}
                  onChange={(event) => setTargetYear(Number(event.target.value))}
                  aria-invalid={errors.targetYear ? 'true' : undefined}
                  required
                >
                  <option value="">Choose…</option>
                  {TARGET_YEARS.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
                {errors.targetYear ? (
                  <span className="field__error">{errors.targetYear}</span>
                ) : null}
              </div>
            </div>

            <div className="field">
              <label htmlFor="dob">Date of birth</label>
              <input
                id="dob"
                type="date"
                value={dob}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(event) => setDob(event.target.value)}
              />
              <span className="field__hint">
                Most of our students are under 18, who need a parent&rsquo;s consent to register.
              </span>
            </div>

            {/* Appears only when the date of birth says it applies, so an adult
                candidate is never shown three fields that do not concern them. */}
            {minor ? (
              <div className="auth__guardian">
                <h3>Parent or guardian</h3>
                <p>
                  You are under 18 on the test date, so we need a parent or guardian&rsquo;s
                  consent before you can register.
                </p>

                <div className="field">
                  <label htmlFor="guardianName">Parent or guardian&rsquo;s name</label>
                  <input
                    id="guardianName"
                    value={guardianName}
                    onChange={(event) => setGuardianName(event.target.value)}
                    aria-invalid={errors.guardianName ? 'true' : undefined}
                  />
                  {errors.guardianName ? (
                    <span className="field__error">{errors.guardianName}</span>
                  ) : null}
                </div>

                <div className="field">
                  <label htmlFor="guardianPhone">Their mobile number</label>
                  <div className="field__phone">
                    <span className="field__prefix">+91</span>
                    <input
                      id="guardianPhone"
                      inputMode="numeric"
                      value={guardianPhone}
                      onChange={(event) => setGuardianPhone(digits(event.target.value))}
                      aria-invalid={errors.guardianPhone ? 'true' : undefined}
                    />
                  </div>
                  {errors.guardianPhone ? (
                    <span className="field__error">{errors.guardianPhone}</span>
                  ) : null}
                </div>

                <label className="auth__check" htmlFor="guardianConsent">
                  <input
                    id="guardianConsent"
                    type="checkbox"
                    checked={guardianConsent}
                    onChange={(event) => setGuardianConsent(event.target.checked)}
                    aria-invalid={errors.guardianConsent ? 'true' : undefined}
                  />
                  <span>
                    I am the parent or guardian, and I consent to JEE Society processing this
                    student&rsquo;s details for this test.
                  </span>
                </label>
                {errors.guardianConsent ? (
                  <span className="field__error">{errors.guardianConsent}</span>
                ) : null}
              </div>
            ) : null}

            <div className="auth__row">
              <div className="field">
                <label htmlFor="state">State</label>
                <select id="state" value={state} onChange={(event) => setState(event.target.value)}>
                  <option value="">Choose…</option>
                  {INDIAN_STATES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="city">City or town</label>
                <input
                  id="city"
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                  autoComplete="address-level2"
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="school">School or coaching</label>
              <input
                id="school"
                value={school}
                onChange={(event) => setSchool(event.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="field">
              <label htmlFor="referralSource">How did you hear about us?</label>
              <select
                id="referralSource"
                value={referralSource}
                onChange={(event) => setReferralSource(event.target.value)}
              >
                <option value="">Prefer not to say</option>
                {REFERRAL_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
            </div>

            <button className="btn btn--mark auth__submit" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save and continue to payment'}
            </button>
          </form>
        </div>

        <p className="auth__fine">
          Nothing is charged on this screen. We do not sell or share your details.
        </p>
      </div>
    </main>
  );
}
