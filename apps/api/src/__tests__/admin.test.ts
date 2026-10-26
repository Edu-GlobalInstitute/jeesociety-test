import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLAG_SEVERITY } from '@jee/shared';
import {
  createTest,
  createTestApi,
  makeAdmin,
  markPaid,
  request,
  signUp,
  startAttempt,
  type Student,
  type TestApi,
} from './helpers.js';

let api: TestApi;
let admin: Student;
let student: Student;
let testId: number;
let attemptId: string;

beforeAll(async () => {
  api = await createTestApi('apiadmin');
  ({ testId } = await createTest(api));
  admin = await signUp(api);
  await makeAdmin(api, admin);
  student = await signUp(api);
  await markPaid(api, student, testId);
  attemptId = await startAttempt(api, student, testId);
});
afterAll(async () => {
  await api.close();
});

const asAdmin = (path: string) => request(api.app).get(path).set('Cookie', admin.cookie);

describe('admin authorization', () => {
  it('refuses an anonymous request', async () => {
    expect((await request(api.app).get('/admin/dashboard')).status).toBe(401);
  });

  it('refuses a signed-in student', async () => {
    const response = await request(api.app)
      .get('/admin/dashboard')
      .set('Cookie', student.cookie);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not_admin');
  });

  it('checks the admins table per request, not a session claim', async () => {
    expect((await asAdmin('/admin/dashboard')).status).toBe(200);

    // Revoking must take effect immediately, not when a 12-hour session
    // happens to expire.
    await api.db.pool.query(`DELETE FROM admins WHERE user_id = $1`, [admin.userId]);
    expect((await asAdmin('/admin/dashboard')).status).toBe(403);
    await makeAdmin(api, admin);
  });
});

describe('admin reads', () => {
  it('reports live cohort health', async () => {
    const response = await asAdmin('/admin/dashboard');
    expect(response.status).toBe(200);
    expect(response.body.stats).toMatchObject({ inProgress: 1 });
    // The number that answers "is sync working across the whole cohort".
    expect(response.body.stats).toHaveProperty('staleOver4Minutes');
  });

  it('never leaks key material through the dashboard', async () => {
    const body = JSON.stringify((await asAdmin('/admin/dashboard')).body);
    expect(body).not.toContain('paper_key');
    expect(body).not.toContain('answer_key');
  });

  it('scores the review queue from the configured flag weights', async () => {
    const unflagged = await signUp(api);
    const unflaggedAttempt = await startAttempt(api, unflagged, testId);

    // Flagged but with no recognised code: the SQL weights and FLAG_SEVERITY
    // must agree, so an unknown code has to score zero rather than crash.
    await api.db.pool.query(
      `UPDATE attempts SET needs_review = true, flags = $2 WHERE id = $1`,
      [unflaggedAttempt, JSON.stringify([{ code: 'unknown_code', questionId: null, evidence: {}, at: '' }])],
    );
    await api.db.pool.query(
      `UPDATE attempts SET needs_review = true, flags = $2 WHERE id = $1`,
      [
        attemptId,
        JSON.stringify([
          { code: 'ip_change', questionId: null, evidence: { distinctIps: 3 }, at: '' },
        ]),
      ],
    );

    const response = await asAdmin('/admin/review-queue');
    expect(response.status).toBe(200);
    expect(response.body.attempts[0]!.attemptId).toBe(attemptId);
    expect(response.body.attempts[0]!.severity).toBe(FLAG_SEVERITY.ip_change);
    expect(response.body.attempts[1]!.severity).toBe(0);
  });

  it('shows a reviewer the evidence, not a verdict', async () => {
    await api.db.pool.query(
      `INSERT INTO sync_snapshots (attempt_id, revision, lengths, ip)
            VALUES ($1, 1, '{"q1":1}', '203.0.113.1'),
                   ($1, 2, '{"q1":1,"q2":1}', '198.51.100.7')`,
      [attemptId],
    );
    await api.db.pool.query(
      `UPDATE attempts SET needs_review = true, flags = $2 WHERE id = $1`,
      [
        attemptId,
        JSON.stringify([
          {
            code: 'ip_change',
            questionId: null,
            evidence: { distinctIps: 2, ips: ['203.0.113.1', '198.51.100.7'] },
            at: '',
          },
        ]),
      ],
    );

    const response = await asAdmin(`/admin/attempt/${attemptId}`);
    expect(response.status).toBe(200);
    // The sync trail is what makes a contested attempt defensible.
    expect(response.body.growth).toHaveLength(2);
    expect(response.body.growth[1]!.lengths).toEqual({ q1: 1, q2: 1 });
    expect(response.body.flags[0]!.evidence).toMatchObject({ distinctIps: 2 });
  });

  it('serves no model output or per-question grade — there is none', async () => {
    const response = await asAdmin(`/admin/attempt/${attemptId}`);
    expect(response.status).toBe(200);
    expect(response.body.grading).toBeUndefined();
    expect(response.body.telemetry).toBeUndefined();
    expect(response.body.scores).not.toHaveProperty('subjective');
  });
});

describe('POST /admin/override-score', () => {
  it('no longer exists — a wrong key is fixed for the whole cohort', async () => {
    // Overriding one student's mark was a subjective-grading affordance. On an
    // all-objective paper a disputed mark means the answer key is wrong, and
    // fixing it per student would leave every other student wrong.
    const response = await request(api.app)
      .post('/admin/override-score')
      .set('Cookie', admin.cookie)
      .send({ attemptId, questionId: 'q1', score: 3, reason: 'Reviewed.' });

    expect(response.status).toBe(404);
  });
});

describe('POST /admin/run-job', () => {
  it('schedules a job rather than running it in the request', async () => {
    const response = await request(api.app)
      .post('/admin/run-job')
      .set('Cookie', admin.cookie)
      .send({ job: 'mcq_score', testId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ job: 'mcq_score', status: 'pending' });

    // Nothing was scored: the worker claims this on its next poll.
    const { rows } = await api.db.pool.query(
      `SELECT mcq_score FROM attempts WHERE id = $1`,
      [attemptId],
    );
    expect(rows[0]!.mcq_score).toBeNull();
  });

  it('rejects an unknown job name', async () => {
    const response = await request(api.app)
      .post('/admin/run-job')
      .set('Cookie', admin.cookie)
      .send({ job: 'drop_everything', testId });
    expect(response.status).toBe(400);
  });
});

describe('POST /admin/test-status', () => {
  const setStatus = (body: unknown) =>
    request(api.app).post('/admin/test-status').set('Cookie', admin.cookie).send(body);

  const statusOf = async (): Promise<string> => {
    const { rows } = await api.db.pool.query<{ status: string }>(
      `SELECT status FROM tests WHERE id = $1`,
      [testId],
    );
    return rows[0]!.status;
  };

  it('locks and reopens the test, and audits both', async () => {
    const locked = await setStatus({ status: 'scheduled', reason: 'inside not finished', testId });
    expect(locked.status).toBe(200);
    expect(await statusOf()).toBe('scheduled');

    const live = await setStatus({ status: 'live', reason: 'paper ready', testId });
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'live', changed: true });
    expect(await statusOf()).toBe('live');

    const { rows } = await api.db.pool.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM admin_audit WHERE action LIKE 'test_status:%' ORDER BY id`,
    );
    expect(rows.map((row) => row.action)).toEqual([
      'test_status:scheduled',
      'test_status:live',
    ]);
    expect(rows[1]!.reason).toBe('paper ready');
  });

  it('requires a reason, because the row is written to admin_audit', async () => {
    expect((await setStatus({ status: 'live', testId })).status).toBe(400);
    expect((await setStatus({ status: 'live', reason: 'x', testId })).status).toBe(400);
  });

  it('refuses to accept closed or graded — those belong to the worker', async () => {
    expect((await setStatus({ status: 'closed', reason: 'end it', testId })).status).toBe(400);
    expect(await statusOf()).toBe('live');
  });

  it('refuses to go live without a published paper', async () => {
    await api.db.pool.query(
      `UPDATE tests SET status = 'scheduled', paper_url = NULL WHERE id = $1`,
      [testId],
    );
    const response = await setStatus({ status: 'live', reason: 'ship it', testId });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('no_paper');
    expect(await statusOf()).toBe('scheduled');

    await api.db.pool.query(
      `UPDATE tests SET status = 'live', paper_url = $2 WHERE id = $1`,
      [testId, 'https://cdn.example.org/paper.json'],
    );
  });

  it('refuses a student', async () => {
    const response = await request(api.app)
      .post('/admin/test-status')
      .set('Cookie', student.cookie)
      .send({ status: 'scheduled', reason: 'let me in', testId });
    expect(response.status).toBe(403);
  });
});
