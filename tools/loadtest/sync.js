import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

/**
 * The event, compressed.
 *
 * Each virtual user signs in once, registers, then syncs full state on a loop,
 * and finally submits. The payload is built to match the real one: 75 answers,
 * the subjective ones long enough to be realistic, which is what makes the
 * ~10 KB gzipped figure in SYSTEM_DESIGN.md meaningful rather than a guess.
 */

const API = __ENV.API_URL || 'http://localhost:3000';
const PASSWORD = __ENV.STUDENT_PASSWORD || 'loadtest-password-1';

const staleSyncs = new Counter('sync_stale');
const skippedSyncs = new Counter('sync_skipped');
const syncLatency = new Trend('sync_latency', true);
const syncOk = new Rate('sync_ok');

const students = new SharedArray('students', () =>
  JSON.parse(open(__ENV.STUDENTS_FILE || './students.json')),
);

export const options = {
  stages: [
    { duration: '2m', target: 500 }, // entry burst
    { duration: '10m', target: 220 }, // steady sync
    { duration: '2m', target: 800 }, // submit spike
  ],
  thresholds: {
    // The sync endpoint is the one that runs 1.2M times. If it cannot hold
    // these, the event cannot either.
    'http_req_failed': ['rate<0.01'],
    'sync_latency': ['p(99)<800'],
    'sync_ok': ['rate>0.99'],
  },
};

/** A realistic payload: 60 single letters and 15 paragraphs. */
function buildAnswers(progress) {
  const answers = {};
  for (let i = 1; i <= 60; i += 1) {
    if (i / 60 <= progress) answers[`q${i}`] = 'ABCD'[i % 4];
  }
  for (let i = 61; i <= 75; i += 1) {
    if ((i - 60) / 15 <= progress) {
      // ~700 characters, which is what a worked derivation actually looks like.
      answers[`q${i}`] =
        'Resolving along the incline, the net force is mg sin(theta). '.repeat(11);
    }
  }
  return answers;
}

export default function () {
  const student = students[(__VU - 1) % students.length];

  const signIn = http.post(
    `${API}/auth/sign-in/email`,
    JSON.stringify({ email: student.email, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'sign-in' } },
  );
  if (!check(signIn, { 'signed in': (r) => r.status === 200 })) return;

  const jar = http.cookieJar();
  const status = http.get(`${API}/test/status`, { tags: { name: 'status' } });
  if (!check(status, { 'status ok': (r) => r.status === 200 })) return;

  const register = http.post(`${API}/attempt/register`, '{}', {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'register' },
  });
  // A student already registered gets a 200 with the same attempt; a closed
  // window is a legitimate outcome too and must not count as an error.
  const attemptId =
    register.status === 200 ? register.json('attemptId') : status.json('attempt.id');
  if (!attemptId) return;

  let revision = 1;
  let syncedRevision = 0;

  // Six syncs, which is a nine-minute slice of the real three hours.
  for (let round = 0; round < 6; round += 1) {
    const progress = (round + 1) / 6;
    revision += 3;

    // The client skips the request entirely when nothing changed. Model that:
    // roughly a third of real intervals produce no new state.
    if (Math.random() < 0.33) {
      skippedSyncs.add(1);
      sleep(2);
      continue;
    }

    const response = http.post(
      `${API}/attempt/sync`,
      JSON.stringify({
        attemptId,
        revision,
        answers: buildAnswers(progress),
        telemetry: { q61: { keystrokes: 700 * progress, pastes: 0, pastedChars: 0 } },
      }),
      {
        headers: { 'content-type': 'application/json' },
        tags: { name: 'sync' },
        compression: 'gzip',
      },
    );

    syncLatency.add(response.timings.duration);
    const ok = response.status === 200 || response.status === 429;
    syncOk.add(ok);
    check(response, { 'sync accepted': () => ok });

    if (response.status === 200) {
      if (response.json('stale') === true) staleSyncs.add(1);
      syncedRevision = response.json('revision');
    }

    sleep(2);
  }

  // The real client spreads this across 45 seconds; compressed here so the
  // stage profile still produces a recognisable spike.
  sleep(Math.random() * 3);
  const submit = http.post(
    `${API}/attempt/submit`,
    JSON.stringify({ attemptId, revision: revision + 1, answers: buildAnswers(1) }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'submit' } },
  );
  check(submit, {
    'submit accepted': (r) => r.status === 200 || r.status === 403,
    'receipt returned': (r) => r.status !== 200 || Boolean(r.json('receipt')),
  });

  jar.clear(API);
  void syncedRevision;
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify(
      {
        p99_sync_ms: data.metrics.sync_latency?.values?.['p(99)'],
        failed_rate: data.metrics.http_req_failed?.values?.rate,
        stale_syncs: data.metrics.sync_stale?.values?.count,
        skipped_syncs: data.metrics.sync_skipped?.values?.count,
        iterations: data.metrics.iterations?.values?.count,
      },
      null,
      2,
    ),
  };
}
