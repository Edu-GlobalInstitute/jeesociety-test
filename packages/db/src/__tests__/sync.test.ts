import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { answerLengths } from '@jee/shared';
import {
  getAttempt,
  listSnapshots,
  recordSnapshot,
  registerAttempt,
  syncAttempt,
} from '../queries/attempts.js';
import { createTestDatabase, seedFixture, type Fixture, type TestDb } from '../testing.js';

/**
 * The sync path. This runs 1.2 million times per event and is the only thing
 * standing between a dropped connection and a student's lost work, so it is
 * tested against a real Postgres rather than a mock: the behaviour under test is
 * the `revision <` guard under genuine concurrency.
 */

let db: TestDb;
let fixture: Fixture;

beforeAll(async () => {
  db = await createTestDatabase('sync');
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  fixture = await seedFixture(db.pool);
});

const sync = (over: Partial<Parameters<typeof syncAttempt>[0]> = {}) =>
  syncAttempt(
    {
      attemptId: fixture.attemptId,
      userId: fixture.userId,
      revision: 1,
      answers: {},
      telemetry: {},
      ip: '203.0.113.1',
      ...over,
    },
    db.pool,
  );

describe('syncAttempt', () => {
  it('stores full state and advances the revision', async () => {
    const result = await sync({ revision: 3, answers: { q1: 'A', q61: 'an answer' } });
    expect(result).toEqual({ updated: true, revision: 3 });

    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.answers).toEqual({ q1: 'A', q61: 'an answer' });
    expect(attempt!.revision).toBe(3);
    expect(attempt!.last_sync_at).toBeInstanceOf(Date);
  });

  it('replaces state wholesale rather than merging', async () => {
    // Full state on every sync (D-007): a question the client no longer sends
    // has been cleared by the student, and the server must reflect that.
    await sync({ revision: 1, answers: { q1: 'A', q2: 'B' } });
    await sync({ revision: 2, answers: { q1: 'A' } });

    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.answers).toEqual({ q1: 'A' });
  });

  it('ignores an out-of-order sync without touching state', async () => {
    await sync({ revision: 5, answers: { q1: 'newest' } });
    const stale = await sync({ revision: 2, answers: { q1: 'older' } });

    // Not an error: a late packet on a flaky network. The caller answers 200
    // with the revision the server holds so the client does not retry-storm.
    expect(stale).toEqual({ updated: false, revision: 5 });
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.answers).toEqual({ q1: 'newest' });
  });

  it('ignores a replay of the revision it already holds', async () => {
    await sync({ revision: 4, answers: { q1: 'A' } });
    expect(await sync({ revision: 4, answers: { q1: 'B' } })).toEqual({
      updated: false,
      revision: 4,
    });
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.answers).toEqual({ q1: 'A' });
  });

  it('keeps the highest revision when syncs race', async () => {
    // Two tabs, or a retry overlapping its original. Whichever order Postgres
    // runs them in, the newest state must survive.
    const results = await Promise.all([
      sync({ revision: 7, answers: { q1: 'seven' } }),
      sync({ revision: 6, answers: { q1: 'six' } }),
      sync({ revision: 8, answers: { q1: 'eight' } }),
      sync({ revision: 5, answers: { q1: 'five' } }),
    ]);

    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.revision).toBe(8);
    expect(attempt!.answers).toEqual({ q1: 'eight' });
    expect(results.filter((r) => r.updated).length).toBeGreaterThanOrEqual(1);
  });

  it('survives twenty concurrent syncs without losing the newest', async () => {
    const revisions = Array.from({ length: 20 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    await Promise.all(
      revisions.map((revision) => sync({ revision, answers: { q1: `rev-${revision}` } })),
    );
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.revision).toBe(20);
    expect(attempt!.answers).toEqual({ q1: 'rev-20' });
  });

  it('refuses a sync for an attempt belonging to another user', async () => {
    const result = await sync({ userId: 'someone-else', revision: 9 });
    expect(result).toEqual({ updated: false, revision: 0 });
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.revision).toBe(0);
  });

  it('cannot reopen a submitted attempt', async () => {
    await db.pool.query(
      `UPDATE attempts SET submitted_at = now(), status = 'submitted', receipt = 'JEE-1-20261025-000001'
        WHERE id = $1`,
      [fixture.attemptId],
    );
    const result = await sync({ revision: 99, answers: { q1: 'after the fact' } });
    expect(result.updated).toBe(false);
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.answers).toEqual({});
  });

  it('promotes a registered attempt to in_progress on its first sync', async () => {
    // The lobby's round-trip check is a real sync against a registered attempt.
    const registered = await seedFixture(db.pool, { attemptStatus: 'registered' });
    await syncAttempt(
      {
        attemptId: registered.attemptId,
        userId: registered.userId,
        revision: 1,
        answers: {},
        telemetry: {},
        ip: null,
      },
      db.pool,
    );
    const attempt = await getAttempt(registered.attemptId, db.pool);
    expect(attempt!.status).toBe('in_progress');
  });

  it('records telemetry as counters', async () => {
    await sync({
      revision: 2,
      answers: { q61: 'x'.repeat(300) },
      telemetry: { q61: { keystrokes: 310, pastes: 0, pastedChars: 0 } },
    });
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.telemetry).toEqual({ q61: { keystrokes: 310, pastes: 0, pastedChars: 0 } });
  });

  it('stores the originating address for the IP-change signal', async () => {
    await sync({ revision: 2, ip: '198.51.100.7' });
    const attempt = await getAttempt(fixture.attemptId, db.pool);
    expect(attempt!.last_ip).toBe('198.51.100.7');
  });
});

describe('recordSnapshot', () => {
  it('stores lengths and never the answer text', async () => {
    const answers = { q61: 'a secret answer about thermodynamics', q62: '' };
    await recordSnapshot(fixture.attemptId, 1, answerLengths(answers), '203.0.113.1', db.pool);

    const snapshots = await listSnapshots(fixture.attemptId, db.pool);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.lengths).toEqual({ q61: 36, q62: 0 });
    expect(JSON.stringify(snapshots)).not.toContain('thermodynamics');
  });

  it('is idempotent for a repeated revision', async () => {
    await recordSnapshot(fixture.attemptId, 1, { q61: 10 }, null, db.pool);
    await recordSnapshot(fixture.attemptId, 1, { q61: 999 }, null, db.pool);

    const snapshots = await listSnapshots(fixture.attemptId, db.pool);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.lengths).toEqual({ q61: 10 });
  });

  it('builds the growth curve the burst signal reads', async () => {
    for (const [revision, length] of [[1, 0], [2, 120], [3, 310], [4, 480]] as const) {
      await recordSnapshot(fixture.attemptId, revision, { q61: length }, null, db.pool);
    }
    const snapshots = await listSnapshots(fixture.attemptId, db.pool);
    expect(snapshots.map((s) => s.lengths.q61)).toEqual([0, 120, 310, 480]);
  });
});

describe('registerAttempt', () => {
  it('is idempotent across a double-click or two tabs', async () => {
    const fresh = await seedFixture(db.pool, { attemptStatus: null });
    const [a, b, c] = await Promise.all([
      registerAttempt(fresh.userId, fresh.testId, db.pool),
      registerAttempt(fresh.userId, fresh.testId, db.pool),
      registerAttempt(fresh.userId, fresh.testId, db.pool),
    ]);
    expect(a!.id).toBe(b!.id);
    expect(b!.id).toBe(c!.id);

    const all = await db.pool.query(`SELECT count(*) AS n FROM attempts WHERE user_id = $1`, [
      fresh.userId,
    ]);
    expect(Number(all.rows[0]!.n)).toBe(1);
  });

  it('does not reset an attempt already in progress', async () => {
    await sync({ revision: 4, answers: { q1: 'A' } });
    const again = await registerAttempt(fixture.userId, fixture.testId, db.pool);
    expect(again!.revision).toBe(4);
    expect(again!.answers).toEqual({ q1: 'A' });
    expect(again!.status).toBe('in_progress');
  });
});
