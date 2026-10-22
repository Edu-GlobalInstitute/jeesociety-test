import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AWARD_CAP } from '@jee/shared';
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

  it('sorts the review queue by severity', async () => {
    const weak = await signUp(api);
    const weakAttempt = await startAttempt(api, weak, testId);

    await api.db.pool.query(
      `UPDATE attempts SET needs_review = true, flags = $2 WHERE id = $1`,
      [weakAttempt, JSON.stringify([{ code: 'ip_change', questionId: null, evidence: {}, at: '' }])],
    );
    await api.db.pool.query(
      `UPDATE attempts SET needs_review = true, flags = $2 WHERE id = $1`,
      [
        attemptId,
        JSON.stringify([
          { code: 'burst_appearance', questionId: 'q61', evidence: { from: 0, to: 800 }, at: '' },
          { code: 'low_keystroke_ratio', questionId: 'q61', evidence: {}, at: '' },
        ]),
      ],
    );

    const response = await asAdmin('/admin/review-queue');
    expect(response.status).toBe(200);
    expect(response.body.attempts[0]!.attemptId).toBe(attemptId);
    expect(response.body.attempts[0]!.severity).toBeGreaterThan(
      response.body.attempts[1]!.severity,
    );
  });

  it('shows a reviewer the evidence, not a verdict', async () => {
    await api.db.pool.query(
      `INSERT INTO sync_snapshots (attempt_id, revision, lengths) VALUES ($1, 1, '{"q61":0}'), ($1, 2, '{"q61":800}')`,
      [attemptId],
    );

    const response = await asAdmin(`/admin/attempt/${attemptId}`);
    expect(response.status).toBe(200);
    // The growth curve is what makes a contested zero defensible.
    expect(response.body.growth).toHaveLength(2);
    expect(response.body.growth[1]!.lengths).toEqual({ q61: 800 });
    expect(response.body.flags[0]!.evidence).toMatchObject({ from: 0, to: 800 });
  });
});

describe('POST /admin/override-score', () => {
  it('records the override with the admin identity and reason', async () => {
    await api.db.pool.query(
      `INSERT INTO grading_jobs (attempt_id, question_id, status, raw_score, score)
            VALUES ($1, 'q61', 'done', 1, 1)`,
      [attemptId],
    );

    const response = await request(api.app)
      .post('/admin/override-score')
      .set('Cookie', admin.cookie)
      .send({ attemptId, questionId: 'q61', score: 3, reason: 'Reviewed: method is sound.' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ before: 1, after: 3 });

    const audit = await api.db.pool.query(
      `SELECT admin_id, action, reason, before, after FROM admin_audit WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(audit.rows[0]).toMatchObject({
      admin_id: admin.userId,
      action: 'override_score',
      reason: 'Reviewed: method is sound.',
    });
  });

  it('refuses a score above the cap', async () => {
    const response = await request(api.app)
      .post('/admin/override-score')
      .set('Cookie', admin.cookie)
      .send({ attemptId, questionId: 'q61', score: AWARD_CAP + 1, reason: 'too generous' });
    expect(response.status).toBe(400);
  });

  it('requires a reason', async () => {
    const response = await request(api.app)
      .post('/admin/override-score')
      .set('Cookie', admin.cookie)
      .send({ attemptId, questionId: 'q61', score: 2 });
    expect(response.status).toBe(400);
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
