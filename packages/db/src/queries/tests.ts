import type { AnswerKey, TestKind, TestStatus } from '@jee/shared';
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
  id, name, kind, requires_payment, duration_minutes,
  starts_at, ends_at, lobby_opens_at, paper_url, status, created_at
`;

export interface TestRow {
  id: number;
  name: string;
  kind: TestKind;
  /**
   * Whether /attempt/register demands a paid payments row. Read instead of
   * `kind` everywhere authorisation is decided — see the column comment in
   * 006_admin_portal.sql.
   */
  requires_payment: boolean;
  duration_minutes: number;
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
      -- Soonest test that has not finished, falling back to the most recent
      -- one so the results pages keep working afterwards. The id tiebreak
      -- makes the choice deterministic when two rows share a window, which
      -- happens when a dev environment is re-seeded.
      ORDER BY (ends_at < now()), starts_at ASC, id DESC
      LIMIT 1`,
    [],
    db,
  );
}

export function listTests(db?: Queryable): Promise<TestRow[]> {
  return rows<TestRow>(`SELECT ${PUBLIC_COLUMNS} FROM tests ORDER BY starts_at DESC`, [], db);
}

/**
 * The scholarship test: the one being sold.
 *
 * `getCurrentTest` above answers "which test is this deployment running", and
 * now that mocks exist it would happily return one of those — a mock opening
 * tomorrow is sooner than the scholarship test in November. Payment, results
 * and the landing page all mean the scholarship test specifically, so they ask
 * for it by name rather than by date.
 */
export function getScholarshipTest(db?: Queryable): Promise<TestRow | null> {
  return one<TestRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM tests
      WHERE kind = 'scholarship' AND status <> 'draft'
      ORDER BY (ends_at < now()), starts_at ASC, id DESC
      LIMIT 1`,
    [],
    db,
  );
}

/**
 * What a student sees on their dashboard: every published test of either kind.
 *
 * `draft` is excluded — a test still being written in the designer must not
 * appear to students. Ordered so the next thing to sit is first.
 */
export function listPublishedTests(db?: Queryable): Promise<TestRow[]> {
  return rows<TestRow>(
    `SELECT ${PUBLIC_COLUMNS} FROM tests
      WHERE status <> 'draft'
      ORDER BY (ends_at < now()), starts_at ASC, id DESC`,
    [],
    db,
  );
}

export interface CreateTestParams {
  name: string;
  kind: TestKind;
  requiresPayment: boolean;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
  lobbyOpensAt: string;
}

/**
 * Creates a test in `draft`.
 *
 * Draft is the only status a new test may have: it has no questions yet, and
 * any other status would put an empty paper in front of students. The designer
 * promotes it with `launch`, which is the step that checks there is a paper to
 * open.
 */
export function createTest(
  params: CreateTestParams,
  db?: Queryable,
): Promise<TestRow | null> {
  return one<TestRow>(
    `INSERT INTO tests
       (name, kind, requires_payment, duration_minutes,
        starts_at, ends_at, lobby_opens_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      params.name,
      params.kind,
      params.requiresPayment,
      params.durationMinutes,
      params.startsAt,
      params.endsAt,
      params.lobbyOpensAt,
    ],
    db,
  );
}

export interface UpdateTestParams {
  name: string;
  requiresPayment: boolean;
  durationMinutes: number;
  startsAt: string;
  endsAt: string;
  lobbyOpensAt: string;
}

/**
 * Edits a test's settings. `kind` is not updatable: flipping a scholarship test
 * to a mock would make a paid event free with one request, and the students who
 * already paid for it would have no way to be told. Create the other test.
 */
export function updateTest(
  testId: number,
  params: UpdateTestParams,
  db?: Queryable,
): Promise<TestRow | null> {
  return one<TestRow>(
    `UPDATE tests
        SET name = $2, requires_payment = $3, duration_minutes = $4,
            starts_at = $5, ends_at = $6, lobby_opens_at = $7
      WHERE id = $1
      RETURNING ${PUBLIC_COLUMNS}`,
    [
      testId,
      params.name,
      params.requiresPayment,
      params.durationMinutes,
      params.startsAt,
      params.endsAt,
      params.lobbyOpensAt,
    ],
    db,
  );
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
 * SECRET. Reads the answer key. Called from exactly one place: the worker's
 * scoring pass, which runs after the test window has closed. The API process
 * never calls this. It holds an entry for all 75 questions — single-correct and
 * integer alike — because every question in this paper is machine-marked.
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

export async function setTestStatus(
  testId: number,
  status: TestStatus,
  db?: Queryable,
): Promise<void> {
  await rows(`UPDATE tests SET status = $2 WHERE id = $1`, [testId, status], db);
}

/**
 * SECRET (writes). Publishes a compiled paper onto the test row.
 *
 * The third of the three functions in this file that touch key material, and
 * the only one that writes it. It exists so that the admin designer can do what
 * tools/build-paper does from a shell: store the blob's URL, the AES key that
 * opens it, and the answer key that marks it.
 *
 * Nothing is validated here — by the time this is called the caller has already
 * validated the question set, encrypted the paper and verified the ciphertext
 * decrypts back to its input. See `compilePaper` in queries/questions.ts, which
 * is the only caller.
 */
export async function publishPaper(
  params: {
    testId: number;
    paperUrl: string;
    paperKey: string;
    answerKey: AnswerKey;
  },
  db?: Queryable,
): Promise<void> {
  await rows(
    `UPDATE tests
        SET paper_url = $2, paper_key = $3, answer_key = $4
      WHERE id = $1`,
    [params.testId, params.paperUrl, params.paperKey, JSON.stringify(params.answerKey)],
    db,
  );
}
