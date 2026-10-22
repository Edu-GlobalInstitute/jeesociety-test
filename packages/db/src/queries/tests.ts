import type { AnswerKey, RubricMap, TestStatus } from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

/**
 * Every query in this file names its columns.
 *
 * `SELECT *` on `tests` is the single worst failure mode in the system: it pulls
 * `paper_key` and `answer_key` into a row object, and from there one careless
 * res.json() leaks them and invalidates the entire event. There is no SELECT *
 * on this table anywhere in the codebase, and the two secret columns are only
 * ever read by the two functions at the bottom of this file, both named so that
 * their use stands out in a diff.
 */

/** Safe columns: no key material. Anything a handler may see. */
const PUBLIC_COLUMNS = `
  id, name, starts_at, ends_at, lobby_opens_at, paper_url, status, created_at
`;

export interface TestRow {
  id: number;
  name: string;
  starts_at: Date;
  ends_at: Date;
  lobby_opens_at: Date;
  paper_url: string | null;
  status: TestStatus;
  created_at: Date;
}

export function getTest(testId: number, db?: Queryable): Promise<TestRow | null> {
  return one<TestRow>(`SELECT ${PUBLIC_COLUMNS} FROM tests WHERE id = $1`, [testId], db);
}

/**
 * The one test this deployment is running. The portal is built for a single
 * event; this returns the soonest test that has not finished, falling back to
 * the most recent one so the results pages keep working afterwards.
 */
export function getCurrentTest(db?: Queryable): Promise<TestRow | null> {
  return one<TestRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM tests
      WHERE status <> 'draft'
      ORDER BY (ends_at < now()), starts_at ASC
      LIMIT 1`,
    [],
    db,
  );
}

export function listTests(db?: Queryable): Promise<TestRow[]> {
  return rows<TestRow>(`SELECT ${PUBLIC_COLUMNS} FROM tests ORDER BY starts_at DESC`, [], db);
}

/* -------------------------------------------------------------------------- */
/* Secret material — two functions, both deliberately conspicuous.             */
/* -------------------------------------------------------------------------- */

/**
 * SECRET. Reads the paper decryption key. Called from exactly one place:
 * GET /attempt/key, after it has checked that now >= starts_at and that this
 * user holds a registered attempt. The returned string goes into a response
 * body; nothing else from this row may.
 */
export async function readPaperKeyForRelease(
  testId: number,
  db?: Queryable,
): Promise<string | null> {
  const row = await one<{ paper_key: string | null }>(
    `SELECT paper_key FROM tests WHERE id = $1 AND now() >= starts_at`,
    [testId],
    db,
  );
  return row?.paper_key ?? null;
}

/**
 * SECRET. Reads the answer key. Called from exactly one place: the worker's MCQ
 * scoring pass, which runs after the test window has closed. The API process
 * never calls this.
 */
export async function readAnswerKeyForScoring(
  testId: number,
  db?: Queryable,
): Promise<AnswerKey | null> {
  const row = await one<{ answer_key: AnswerKey | null }>(
    `SELECT answer_key FROM tests WHERE id = $1`,
    [testId],
    db,
  );
  return row?.answer_key ?? null;
}

/** SECRET-adjacent: rubrics shape the grading prompt and never reach a client. */
export async function readRubricsForGrading(
  testId: number,
  db?: Queryable,
): Promise<RubricMap | null> {
  const row = await one<{ rubrics: RubricMap | null }>(
    `SELECT rubrics FROM tests WHERE id = $1`,
    [testId],
    db,
  );
  return row?.rubrics ?? null;
}

export async function setTestStatus(
  testId: number,
  status: TestStatus,
  db?: Queryable,
): Promise<void> {
  await rows(`UPDATE tests SET status = $2 WHERE id = $1`, [testId, status], db);
}
