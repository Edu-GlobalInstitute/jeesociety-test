import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTest,
  createTestApi,
  markPaid,
  request,
  signUp,
  type Student,
  type TestApi,
} from './helpers.js';

/**
 * Registration, the key release, and submit.
 *
 * The key tests are the ones that matter most in this file: the decryption key
 * must not be obtainable one millisecond before `starts_at`, by anyone, through
 * any route — a leaked key invalidates the entire event.
 */

let api: TestApi;
let student: Student;
let testId: number;
let paperKey: string;

beforeAll(async () => {
  api = await createTestApi('apilobby');
  ({ testId, paperKey } = await createTest(api));
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  student = await signUp(api);
  await markPaid(api, student, testId);
});

async function setWindow(startsInMinutes: number, durationMinutes = 180): Promise<void> {
  await api.db.pool.query(
    `UPDATE tests
        SET starts_at = now() + make_interval(mins => $2),
            ends_at = now() + make_interval(mins => $2 + $3),
            lobby_opens_at = now() + make_interval(mins => $2 - 30)
      WHERE id = $1`,
    [testId, startsInMinutes, durationMinutes],
  );
}

const register = (cookie = student.cookie) =>
  request(api.app).post('/attempt/register').set('Cookie', cookie).send({});

const getKey = (cookie = student.cookie) =>
  request(api.app).get('/attempt/key').set('Cookie', cookie);

describe('POST /attempt/register', () => {
  it('admits a paid student during the lobby window', async () => {
    await setWindow(10);
    const response = await register();
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('registered');
    expect(response.body.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is idempotent across a double-click', async () => {
    await setWindow(10);
    const [a, b] = await Promise.all([register(), register()]);
    expect(a.body.attemptId).toBe(b.body.attemptId);
  });

  it('refuses before the lobby opens', async () => {
    await setWindow(90);
    const response = await register();
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('lobby_closed');
  });

  it('closes registration the moment the test starts', async () => {
    await setWindow(-1);
    const response = await register();
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('registration_closed');
  });

  it('refuses a student who has not paid', async () => {
    await setWindow(10);
    const unpaid = await signUp(api);
    const response = await register(unpaid.cookie);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not_paid');
  });
});

describe('GET /attempt/key', () => {
  it('refuses before starts_at, however close', async () => {
    await setWindow(10);
    await register();
    await api.db.pool.query(
      `UPDATE tests SET starts_at = now() + interval '1 second' WHERE id = $1`,
      [testId],
    );

    const response = await getKey();
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not_started');
    // Nothing resembling the key may appear in a refusal either.
    expect(JSON.stringify(response.body)).not.toContain(paperKey);
  });

  it('releases the key at starts_at to a registered student', async () => {
    await setWindow(10);
    await register();
    await setWindow(-1);

    const response = await getKey();
    expect(response.status).toBe(200);
    expect(response.body.key).toBe(paperKey);
    expect(response.body.endsAt).toBeGreaterThan(response.body.serverTime);
  });

  it('admits a registered student whose key request is slow', async () => {
    // The cutoff is on registration, not on this call: a student who made it
    // into the lobby must get in even if their key request arrives late.
    await setWindow(10);
    await register();
    await setWindow(-45);

    const response = await getKey();
    expect(response.status).toBe(200);
    expect(response.body.key).toBe(paperKey);
  });

  it('refuses a student who never registered', async () => {
    await setWindow(-1);
    const latecomer = await signUp(api);
    await markPaid(api, latecomer, testId);

    const response = await getKey(latecomer.cookie);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not_registered');
    expect(JSON.stringify(response.body)).not.toContain(paperKey);
  });

  it('refuses without a session', async () => {
    await setWindow(-1);
    const response = await request(api.app).get('/attempt/key');
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain(paperKey);
  });

  it('marks the attempt in_progress so the reconciliation report is accurate', async () => {
    await setWindow(10);
    const registered = await register();
    await setWindow(-1);
    await getKey();

    const { rows } = await api.db.pool.query<{ status: string; key_issued_at: Date }>(
      `SELECT status, key_issued_at FROM attempts WHERE id = $1`,
      [registered.body.attemptId],
    );
    expect(rows[0]!.status).toBe('in_progress');
    expect(rows[0]!.key_issued_at).toBeInstanceOf(Date);
  });
});

describe('POST /attempt/submit', () => {
  async function registeredAttempt(): Promise<string> {
    await setWindow(10);
    const response = await register();
    await setWindow(-10);
    await getKey();
    return response.body.attemptId as string;
  }

  it('returns a receipt and finalises the attempt', async () => {
    const attemptId = await registeredAttempt();
    const response = await request(api.app)
      .post('/attempt/submit')
      .set('Cookie', student.cookie)
      .send({ attemptId, revision: 4, answers: { q1: 'A' } });

    expect(response.status).toBe(200);
    expect(response.body.receipt).toMatch(new RegExp(`^JEE-${testId}-\\d{8}-\\d{6}$`));
    expect(response.body.alreadySubmitted).toBe(false);
  });

  it('returns 200 and the same receipt on a double-click', async () => {
    const attemptId = await registeredAttempt();
    const send = () =>
      request(api.app)
        .post('/attempt/submit')
        .set('Cookie', student.cookie)
        .send({ attemptId, revision: 4, answers: { q1: 'A' } });

    const first = await send();
    const second = await send();
    expect(second.status).toBe(200);
    expect(second.body.receipt).toBe(first.body.receipt);
    expect(second.body.alreadySubmitted).toBe(true);
  });

  it('still accepts a jittered submit a little after the window closes', async () => {
    const attemptId = await registeredAttempt();
    await api.db.pool.query(
      `UPDATE tests SET ends_at = now() - interval '30 seconds' WHERE id = $1`,
      [testId],
    );

    const response = await request(api.app)
      .post('/attempt/submit')
      .set('Cookie', student.cookie)
      .send({ attemptId, revision: 4, answers: { q1: 'A' } });
    expect(response.status).toBe(200);
  });

  it('refuses long after the window closed, pointing at auto-submit', async () => {
    const attemptId = await registeredAttempt();
    // Move the whole window back: the schema's CHECK keeps starts_at < ends_at.
    await api.db.pool.query(
      `UPDATE tests SET lobby_opens_at = now() - interval '5 hours',
                        starts_at = now() - interval '4 hours',
                        ends_at = now() - interval '30 minutes'
        WHERE id = $1`,
      [testId],
    );

    const response = await request(api.app)
      .post('/attempt/submit')
      .set('Cookie', student.cookie)
      .send({ attemptId, revision: 4, answers: { q1: 'A' } });
    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/finalised automatically/i);
  });

  it('computes no score', async () => {
    const attemptId = await registeredAttempt();
    await request(api.app)
      .post('/attempt/submit')
      .set('Cookie', student.cookie)
      .send({ attemptId, revision: 4, answers: { q1: 'A' } });

    const { rows } = await api.db.pool.query(
      `SELECT mcq_score, total_score FROM attempts WHERE id = $1`,
      [attemptId],
    );
    expect(rows[0]!.mcq_score).toBeNull();
    expect(rows[0]!.total_score).toBeNull();
  });
});

describe('GET /attempt/state', () => {
  it('hands back last synced state so a replacement machine can resume', async () => {
    await setWindow(10);
    const registered = await register();
    await setWindow(-10);
    await request(api.app)
      .post('/attempt/sync')
      .set('Cookie', student.cookie)
      .send({ attemptId: registered.body.attemptId, revision: 7, answers: { q1: 'A' } });

    const response = await request(api.app).get('/attempt/state').set('Cookie', student.cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ revision: 7, answers: { q1: 'A' } });
    expect(JSON.stringify(response.body)).not.toContain(paperKey);
  });
});

/**
 * The lock. While a test is on sale and the inside is not finished, its row
 * sits at `scheduled` and none of the three routes that open the paper may
 * work — a client-side coming-soon screen would be cosmetic on its own.
 */
describe('the lock on tests.status', () => {
  const lock = () =>
    api.db.pool.query(`UPDATE tests SET status = 'scheduled' WHERE id = $1`, [testId]);
  const unlock = () =>
    api.db.pool.query(`UPDATE tests SET status = 'live' WHERE id = $1`, [testId]);

  afterEach(unlock);

  it('refuses registration while the test is locked', async () => {
    await setWindow(10);
    await lock();
    const response = await register();
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not_open');
  });

  it('refuses the paper key while the test is locked, and leaks nothing', async () => {
    await setWindow(10);
    await register();
    await setWindow(-1);
    await lock();

    const response = await getKey();
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not_open');
    expect(JSON.stringify(response.body)).not.toContain(paperKey);
  });

  it('refuses a sync while the test is locked', async () => {
    await setWindow(10);
    const registered = await register();
    await setWindow(-10);
    await lock();

    const response = await request(api.app)
      .post('/attempt/sync')
      .set('Cookie', student.cookie)
      .send({ attemptId: registered.body.attemptId, revision: 2, answers: { q1: 'A' } });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not_open');
  });

  it('still lets a closed test submit and resume, so a receipt survives the event', async () => {
    // auto_submit moves the row to `closed` ten minutes after the window
    // shuts. A student fetching their receipt after that must not be told the
    // test is shut.
    await setWindow(10);
    const registered = await register();
    await setWindow(-10);
    await api.db.pool.query(`UPDATE tests SET status = 'closed' WHERE id = $1`, [testId]);

    const submitted = await request(api.app)
      .post('/attempt/submit')
      .set('Cookie', student.cookie)
      .send({ attemptId: registered.body.attemptId, revision: 3, answers: { q1: 'A' } });
    expect(submitted.status).toBe(200);

    const state = await request(api.app).get('/attempt/state').set('Cookie', student.cookie);
    expect(state.status).toBe(200);
  });

  it('tells the status endpoint, so the client shows coming soon not a 403', async () => {
    await setWindow(10);
    await lock();
    const locked = await request(api.app).get('/test/status').set('Cookie', student.cookie);
    expect(locked.status).toBe(200);
    expect(locked.body.examOpen).toBe(false);
    // Paid is independent of the lock: the student has paid, they just cannot
    // get in yet, and the register page reads both to choose its copy.
    expect(locked.body.paid).toBe(true);

    await unlock();
    const open = await request(api.app).get('/test/status').set('Cookie', student.cookie);
    expect(open.body.examOpen).toBe(true);
  });
});
