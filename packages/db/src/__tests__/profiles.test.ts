import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getProfile, isComplete, upsertProfile } from '../queries/profiles.js';
import { createTestDatabase, type TestDb } from '../testing.js';

/**
 * Student profiles.
 *
 * The cases here are the ones that decide whether a student can pay and
 * whether a minor's consent is recorded honestly. Both are enforced in SQL —
 * a trigger and a CHECK — so they are tested against a real database rather
 * than by reading the query.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDatabase('profiles');
});
afterAll(async () => {
  await db.drop();
});

/** A Better Auth user row, which student_profiles references. */
async function makeUser(id: string): Promise<string> {
  await db.pool.query(
    `INSERT INTO "user"("id","name","email") VALUES ($1,$2,$3)
     ON CONFLICT ("id") DO NOTHING`,
    [id, 'Test Student', `${id}@example.test`],
  );
  return id;
}

beforeEach(async () => {
  await db.pool.query(`DELETE FROM "user"`);
});

const base = {
  phone: '9876500001',
  class: '12' as const,
  targetYear: 2027,
  dob: null,
  state: null,
  city: null,
  school: null,
  guardianName: null,
  guardianPhone: null,
  referralSource: null,
};

describe('upsertProfile', () => {
  it('marks a profile complete from the columns, not from the caller', async () => {
    const userId = await makeUser('u_complete');
    const saved = await upsertProfile({ ...base, userId }, db.pool);
    expect(saved.profile_complete).toBe(true);
    expect(await isComplete(userId, db.pool)).toBe(true);
  });

  it('records a minor’s consent with the guardian beside it', async () => {
    const userId = await makeUser('u_minor');
    const saved = await upsertProfile(
      {
        ...base,
        userId,
        dob: '2009-06-01',
        guardianName: 'A Parent',
        guardianPhone: '9876500999',
      },
      db.pool,
    );
    expect(saved.guardian_name).toBe('A Parent');
    expect(saved.guardian_consent_at).not.toBeNull();
  });

  it('keeps consent when the form is re-saved to fix an unrelated field', async () => {
    const userId = await makeUser('u_resave');
    const minor = {
      ...base,
      userId,
      dob: '2009-06-01',
      guardianName: 'A Parent',
      guardianPhone: '9876500999',
    };
    const first = await upsertProfile(minor, db.pool);
    // Second save corrects the city. The guardian fields are sent again, as
    // the route sends them for any consenting minor, and the original
    // timestamp must survive rather than being re-dated.
    const second = await upsertProfile(
      { ...minor, city: 'Patna' },
      db.pool,
    );
    expect(second.guardian_consent_at).toEqual(first.guardian_consent_at);
  });

  /**
   * The regression this file was written for.
   *
   * A student saves as a minor, then corrects their date of birth to an adult
   * one — so the form sends no guardian fields. Carrying the old consent
   * timestamp across left consent_at set with no name or number beside it,
   * which violates guardian_fields_together and reached the student as a 500
   * on an ordinary correction. Found against the live API, not in a test.
   */
  it('clears consent when a minor is corrected to an adult', async () => {
    const userId = await makeUser('u_becomes_adult');
    await upsertProfile(
      {
        ...base,
        userId,
        dob: '2009-06-01',
        guardianName: 'A Parent',
        guardianPhone: '9876500999',
      },
      db.pool,
    );

    const corrected = await upsertProfile(
      { ...base, userId, dob: '2000-01-01' },
      db.pool,
    );

    expect(corrected.guardian_name).toBeNull();
    expect(corrected.guardian_phone).toBeNull();
    // Consent belongs to a named person: with the guardian gone the timestamp
    // is not a record of anything.
    expect(corrected.guardian_consent_at).toBeNull();
    expect(corrected.profile_complete).toBe(true);
  });

  it('is idempotent on user_id, so a double submit leaves one row', async () => {
    const userId = await makeUser('u_twice');
    await upsertProfile({ ...base, userId }, db.pool);
    await upsertProfile({ ...base, userId, city: 'Patna' }, db.pool);
    const rows = await db.pool.query(
      `SELECT count(*)::int AS n FROM student_profiles WHERE user_id = $1`,
      [userId],
    );
    expect(rows.rows[0].n).toBe(1);
    expect((await getProfile(userId, db.pool))?.city).toBe('Patna');
  });

  it('refuses a second account on the same phone number', async () => {
    const first = await makeUser('u_phone_a');
    const second = await makeUser('u_phone_b');
    await upsertProfile({ ...base, userId: first }, db.pool);
    await expect(
      upsertProfile({ ...base, userId: second }, db.pool),
    ).rejects.toMatchObject({ constraint: 'student_profiles_phone_key' });
  });
});

describe('isComplete', () => {
  it('is false for a user who has no profile row at all', async () => {
    const userId = await makeUser('u_noprofile');
    expect(await isComplete(userId, db.pool)).toBe(false);
  });
});
