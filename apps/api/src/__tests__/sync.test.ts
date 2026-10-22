import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTest,
  createTestApi,
  markPaid,
  request,
  signUp,
  startAttempt,
  type Student,
  type TestApi,
} from './helpers.js';

/**
 * The hot path over HTTP. The query-level guarantees are covered in
 * packages/db; what is tested here is everything the route adds — the session
 * check, zod validation, the window check, the payload ceiling, and above all
 * that a stale revision comes back as 200.
 */

let api: TestApi;
let student: Student;
let testId: number;
let attemptId: string;

beforeAll(async () => {
  api = await createTestApi('apisync');
  // One test row for the file: the portal is built for a single event, and
  // getCurrentTest picks one test, so creating several would be unlike
  // production in a way that teaches nothing.
  ({ testId } = await createTest(api));
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  await restoreWindow();
  student = await signUp(api);
  await markPaid(api, student, testId);
  attemptId = await startAttempt(api, student, testId);
});

/** Puts the window back to "open, started 10 minutes ago". */
async function restoreWindow(): Promise<void> {
  await api.db.pool.query(
    `UPDATE tests SET starts_at = now() - interval '10 minutes',
                      ends_at = now() + interval '170 minutes',
                      lobby_opens_at = now() - interval '40 minutes'
      WHERE id = $1`,
    [testId],
  );
}

const sync = (body: unknown, cookie = student.cookie) =>
  request(api.app).post('/attempt/sync').set('Cookie', cookie).send(body as object);

describe('POST /attempt/sync', () => {
  it('accepts full state and reports the new revision', async () => {
    const response = await sync({
      attemptId,
      revision: 1,
      answers: { q1: 'A', q61: 'my working' },
      telemetry: { q61: { keystrokes: 120, pastes: 0, pastedChars: 0 } },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, revision: 1, stale: false });
    expect(response.body.serverTime).toBeGreaterThan(0);
  });

  it('returns 200 — not 409 — for an out-of-order sync', async () => {
    await sync({ attemptId, revision: 5, answers: { q1: 'newest' } });
    const response = await sync({ attemptId, revision: 2, answers: { q1: 'older' } });

    // A 4xx here would be read as failure by every retry wrapper on 10,000
    // clients at once, exactly when the network is worst.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, revision: 5, stale: true });
  });

  it('requires a session', async () => {
    const response = await request(api.app)
      .post('/attempt/sync')
      .send({ attemptId, revision: 1, answers: {} });
    expect(response.status).toBe(401);
  });

  it('rejects another student\'s attempt without touching it', async () => {
    const intruder = await signUp(api);
    const response = await sync({ attemptId, revision: 99, answers: { q1: 'X' } }, intruder.cookie);

    // The guard is in the UPDATE's WHERE clause, so this is a stale no-op.
    expect(response.status).toBe(200);
    expect(response.body.stale).toBe(true);

    const { rows } = await api.db.pool.query(`SELECT answers FROM attempts WHERE id = $1`, [
      attemptId,
    ]);
    expect(rows[0]!.answers).toEqual({});
  });

  it('rejects a malformed body with paths only, never the answer text', async () => {
    const response = await sync({
      attemptId,
      revision: 'soon',
      answers: { q1: 'a secret answer about thermodynamics' },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('thermodynamics');
  });

  it('rejects an answer over the per-answer ceiling', async () => {
    const response = await sync({
      attemptId,
      revision: 1,
      answers: { q61: 'x'.repeat(5_001) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects an oversized body before parsing it', async () => {
    const response = await request(api.app)
      .post('/attempt/sync')
      .set('Cookie', student.cookie)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ attemptId, revision: 1, answers: { q1: 'x'.repeat(400_000) } }));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a sync after the window has closed', async () => {
    await api.db.pool.query(
      `UPDATE tests SET ends_at = now() - interval '1 minute' WHERE id = $1`,
      [testId],
    );
    const response = await sync({ attemptId, revision: 1, answers: {} });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('window_closed');
  });

  it('records a snapshot of lengths, never the text', async () => {
    await sync({ attemptId, revision: 3, answers: { q61: 'a secret answer', q62: '' } });

    const { rows } = await api.db.pool.query(
      `SELECT revision, lengths, ip FROM sync_snapshots WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(rows[0]!.lengths).toEqual({ q61: 15, q62: 0 });
    expect(JSON.stringify(rows)).not.toContain('secret answer');
  });

  it('rate-limits a looping client without losing its work', async () => {
    await sync({ attemptId, revision: 1, answers: { q1: 'A' } });
    await sync({ attemptId, revision: 2, answers: { q1: 'B' } });
    const third = await sync({ attemptId, revision: 3, answers: { q1: 'C' } });

    expect(third.status).toBe(429);
    // The message must never suggest the student's work is at risk.
    expect(third.body.message).toMatch(/saved/i);

    const { rows } = await api.db.pool.query(`SELECT revision FROM attempts WHERE id = $1`, [
      attemptId,
    ]);
    expect(rows[0]!.revision).toBe(2);
  });
});

describe('GET /test/status', () => {
  it('drives the clock and never leaks key material', async () => {
    const response = await request(api.app).get('/test/status').set('Cookie', student.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ testId, paid: true });
    expect(response.body.serverTime).toBeGreaterThan(0);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain('paper_key');
    expect(body).not.toContain('answer_key');
    expect(response.body.answerKey).toBeUndefined();
    expect(response.body.paperKey).toBeUndefined();
  });

  it('serves an unauthenticated clock reference', async () => {
    const response = await request(api.app).get('/test/time');
    expect(response.status).toBe(200);
    expect(response.body.serverTime).toBeGreaterThan(0);
  });
});
