import { TEST_STARTS_AT } from '@jee/shared/config';

/**
 * The test date, as words.
 *
 * Every label on the public site is derived from TEST_STARTS_AT rather than
 * typed out, so moving the event is a one-line change in @jee/shared and not a
 * hunt for stale dates across the poster, the seal and the ticker.
 *
 * The fields are read out of the ISO string by hand instead of going through
 * Date#toLocaleString, for two reasons: this app is a static export, so a
 * label formatted with the build machine's locale and timezone would be baked
 * into the HTML; and the offset in the constant (+05:30) is the timezone the
 * test actually runs in, which is the one a student needs to read.
 */

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const MATCH = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(TEST_STARTS_AT);
if (!MATCH) {
  // A malformed constant would otherwise reach the page as "NaN November".
  throw new Error(`TEST_STARTS_AT is not an ISO-8601 datetime: ${TEST_STARTS_AT}`);
}

const [year, month, day, hour, minute] = MATCH.slice(1).map(Number) as [
  number, number, number, number, number,
];

/** The wall-clock fields above are already in +05:30, so UTC maths on them
 *  gives the weekday in the test's own timezone. */
const WEEKDAY = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;

const MONTH_LONG = MONTHS_LONG[month - 1]!;

/** "10 November 2026" */
export const TEST_DATE_LONG = `${day} ${MONTH_LONG} ${year}`;

/** "10 Nov 2026" — for tickers, tags and the seal, where width is scarce. */
export const TEST_DATE_SHORT = `${day} ${MONTH_LONG.slice(0, 3)} ${year}`;

/** "Tuesday" */
export const TEST_WEEKDAY = WEEKDAY;

/** "9:00 AM IST" — 12-hour, because that is how the time will be read aloud. */
export const TEST_TIME_LABEL = (() => {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, '0')} ${suffix} IST`;
})();

/** "Tuesday, 10 November 2026 · 9:00 AM IST" */
export const TEST_WHEN = `${TEST_WEEKDAY}, ${TEST_DATE_LONG} · ${TEST_TIME_LABEL}`;
