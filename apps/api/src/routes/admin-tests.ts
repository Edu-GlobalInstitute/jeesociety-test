import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PAPER } from '@jee/shared';
import { admin, questions, tests, type Pool } from '@jee/db';
import type { Auth } from '../auth.js';
import { currentUser, requireAdmin } from '../middleware/session.js';
import { badRequest, notFound } from '../middleware/errors.js';
import type { Logger } from '../logger.js';

/**
 * The test designer: create tests, fill a question bank, launch.
 *
 * The one route here that matters is POST /launch. Everything else edits rows
 * that no student can see; launch is what compiles those rows into the blob
 * 25,000 students download and the answer key their marks come from. It
 * refuses, rather than warns, on anything that would reach a student as a
 * broken paper — the validator in queries/questions.ts says why, rule by rule.
 *
 * `correct_answer` is returned by these routes. That is correct and deliberate:
 * this router is behind requireAdmin, which checks the `admins` table on every
 * request, and an editor that cannot show the answer cannot be used to set it.
 * No route outside this file selects that column.
 */
export function adminTestRoutes({
  pool,
  auth,
  log,
}: {
  pool: Pool;
  auth: Auth;
  log: Logger;
}): Router {
  const router = Router();
  // Bigger than the 64kb the other admin routes take: a bulk upload is 75
  // questions of prose, and a paste from a spreadsheet carries more than it
  // looks like. Images do not come through here — they are uploaded separately
  // and referenced by URL.
  router.use(express.json({ limit: '4mb' }));
  router.use(requireAdmin(auth, pool));

  /* ---------------------------------------------------------------------- */
  /* Tests                                                                   */
  /* ---------------------------------------------------------------------- */

  router.get('/tests', async (_req, res) => {
    const list = await tests.listTests(pool);
    // One summary query per test. The list is short — a handful of mocks and
    // one scholarship test — so this is a few queries, not an N+1 on a table
    // that grows with students.
    const withBanks = await Promise.all(
      list.map(async (test) => ({
        ...serialiseTest(test),
        bank: await questions.bankSummary(test.id, pool),
      })),
    );
    res.json({ tests: withBanks, paperShape: paperShape() });
  });

  const DatesSchema = {
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    lobbyOpensAt: z.string().datetime(),
  };

  const CreateTestSchema = z.object({
    name: z.string().trim().min(3).max(200),
    kind: z.enum(['mock', 'scholarship']),
    requiresPayment: z.boolean().optional(),
    durationMinutes: z.number().int().min(5).max(600).default(180),
    ...DatesSchema,
  });

  /**
   * Creates a test in `draft`.
   *
   * `requiresPayment` defaults from `kind` — a mock is free, a scholarship test
   * is paid — so the ordinary case needs no decision. It is still settable, for
   * the free re-run case the column comment describes.
   */
  router.post('/tests', async (req, res) => {
    const me = currentUser(req);
    const body = CreateTestSchema.parse(req.body);
    checkWindow(body);

    const created = await tests.createTest(
      {
        name: body.name,
        kind: body.kind,
        requiresPayment: body.requiresPayment ?? body.kind === 'scholarship',
        durationMinutes: body.durationMinutes,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        lobbyOpensAt: body.lobbyOpensAt,
      },
      pool,
    );
    if (!created) throw badRequest('create_failed', 'Could not create the test.');

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'test_create',
        attemptId: null,
        questionId: null,
        before: null,
        after: { testId: created.id, kind: created.kind, name: created.name },
        reason: 'created in the designer',
      },
      pool,
    );

    res.status(201).json({ test: serialiseTest(created) });
  });

  const UpdateTestSchema = z.object({
    name: z.string().trim().min(3).max(200),
    requiresPayment: z.boolean(),
    durationMinutes: z.number().int().min(5).max(600),
    ...DatesSchema,
  });

  router.post('/tests/:testId', async (req, res) => {
    const me = currentUser(req);
    const testId = parseTestId(req.params.testId);
    const body = UpdateTestSchema.parse(req.body);
    checkWindow(body);

    const before = await tests.getTest(testId, pool);
    if (!before) throw notFound('no_test', 'No such test.');

    // Moving the window of a test that is already open would change the clock
    // under students who are sitting it — every timer in the exam app is
    // computed from these three timestamps.
    if (before.status === 'live') {
      throw badRequest(
        'test_live',
        'This test is live. Its timings cannot be changed while students are in it.',
      );
    }

    const updated = await tests.updateTest(
      testId,
      {
        name: body.name,
        requiresPayment: body.requiresPayment,
        durationMinutes: body.durationMinutes,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        lobbyOpensAt: body.lobbyOpensAt,
      },
      pool,
    );
    if (!updated) throw notFound('no_test', 'No such test.');

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'test_update',
        attemptId: null,
        questionId: null,
        before: { name: before.name, startsAt: before.starts_at.toISOString() },
        after: { name: updated.name, startsAt: updated.starts_at.toISOString() },
        reason: 'edited in the designer',
      },
      pool,
    );

    res.json({ test: serialiseTest(updated) });
  });

  /* ---------------------------------------------------------------------- */
  /* Questions                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * The question list, with the validation problems beside it.
   *
   * Problems are computed on every read rather than cached, so the designer can
   * show "this paper cannot be launched, and here is why" continuously instead
   * of only when someone presses the button and is told no.
   */
  router.get('/tests/:testId/questions', async (req, res) => {
    const testId = parseTestId(req.params.testId);
    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');

    const list = await questions.listQuestions(testId, pool);
    res.json({
      test: serialiseTest(test),
      questions: list.map(serialiseQuestion),
      summary: await questions.bankSummary(testId, pool),
      // Only the scholarship paper must match the advertised JEE shape — see
      // validateQuestionSet.
      problems: questions.validateQuestionSet(list, {
        strictShape: test.kind === 'scholarship',
      }),
      paperShape: paperShape(),
    });
  });

  const OptionSchema = z.object({
    key: z.string().trim().min(1).max(4),
    body: z.string().max(4000).default(''),
    imageUrl: z.string().url().max(2000).nullable().optional(),
  });

  const QuestionSchema = z.object({
    questionRef: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,32}$/, 'Use letters, numbers, dashes or underscores.'),
    subject: z.enum(PAPER.subjects as unknown as [string, ...string[]]),
    kind: z.enum(['scq', 'integer']),
    position: z.number().int().min(1).max(500),
    body: z.string().trim().min(1).max(20000),
    options: z.array(OptionSchema).max(8).default([]),
    // Nullable: a half-written question is a legitimate state to save. `launch`
    // is what refuses to publish one.
    correctAnswer: z.string().trim().max(64).nullable().default(null),
    imageUrl: z.string().url().max(2000).nullable().default(null),
    solutionText: z.string().max(20000).nullable().default(null),
    solutionImageUrl: z.string().url().max(2000).nullable().default(null),
    unit: z.string().trim().max(32).nullable().default(null),
    marksCorrect: z.number().min(0).max(100).default(4),
    marksWrong: z.number().min(-100).max(0).default(-1),
  });

  router.post('/tests/:testId/questions', async (req, res) => {
    const testId = parseTestId(req.params.testId);
    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');
    const body = QuestionSchema.parse(req.body);

    const saved = await questions.upsertQuestion(testId, toQuestionInput(body), pool);
    if (!saved) throw badRequest('save_failed', 'Could not save the question.');
    res.json({ question: serialiseQuestion(saved) });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /tests/:testId/questions/bulk — the bulk uploader.                 */
  /* ---------------------------------------------------------------------- */
  /**
   * Validates the whole batch before writing any of it, then writes it in one
   * transaction.
   *
   * All-or-nothing because a partial upload is the worst outcome: 60 of 75
   * questions in, no record of which 15 failed, and a bank that looks nearly
   * complete. Reporting every bad row at once also means one round of
   * corrections to the spreadsheet rather than fifteen.
   *
   * `replace` clears the bank first, which is what re-uploading a corrected
   * sheet means. Without it, questions deleted from the sheet would survive in
   * the bank and the paper would have more questions than the sheet does.
   */
  const BulkSchema = z.object({
    questions: z.array(QuestionSchema).min(1).max(500),
    replace: z.boolean().default(false),
  });

  router.post('/tests/:testId/questions/bulk', async (req, res) => {
    const me = currentUser(req);
    const testId = parseTestId(req.params.testId);
    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');
    if (test.status === 'live') {
      throw badRequest(
        'test_live',
        'This test is live. Editing its questions now would change the paper under students sitting it.',
      );
    }

    const body = BulkSchema.parse(req.body);

    // Refs must be unique within the batch. Two rows numbered q12 would upsert
    // onto each other and silently drop one — the batch would report 75 saved
    // and the bank would hold 74.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const question of body.questions) {
      if (seen.has(question.questionRef)) duplicates.push(question.questionRef);
      seen.add(question.questionRef);
    }
    if (duplicates.length > 0) {
      throw badRequest(
        'duplicate_refs',
        `These question numbers appear more than once in the upload: ${[...new Set(duplicates)].join(', ')}.`,
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (body.replace) {
        await client.query('DELETE FROM questions WHERE test_id = $1', [testId]);
      }
      for (const question of body.questions) {
        await questions.upsertQuestion(testId, toQuestionInput(question), client);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // A CHECK constraint rejecting one row is a content problem, not a bug,
      // and the admin needs to be told which rule it broke rather than "500".
      throw asContentError(error);
    } finally {
      client.release();
    }

    const list = await questions.listQuestions(testId, pool);
    await admin.logAdminAction(
      {
        adminId: me.id,
        action: 'questions_bulk_upload',
        attemptId: null,
        questionId: null,
        before: null,
        after: { testId, count: body.questions.length, replaced: body.replace },
        reason: 'bulk upload in the designer',
      },
      pool,
    );

    log.info({ testId, count: body.questions.length }, 'bulk question upload');
    res.json({
      ok: true,
      saved: body.questions.length,
      summary: await questions.bankSummary(testId, pool),
      problems: questions.validateQuestionSet(list, {
        strictShape: test.kind === 'scholarship',
      }),
    });
  });

  router.delete('/questions/:questionId', async (req, res) => {
    const questionId = z.coerce.number().int().positive().parse(req.params.questionId);
    const question = await questions.getQuestion(questionId, pool);
    if (!question) throw notFound('no_question', 'No such question.');

    const test = await tests.getTest(question.test_id, pool);
    if (test?.status === 'live') {
      throw badRequest('test_live', 'This test is live. Its questions cannot be deleted.');
    }

    await questions.deleteQuestion(questionId, pool);
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------------------- */
  /* POST /tests/:testId/launch — compiles and publishes the paper.          */
  /* ---------------------------------------------------------------------- */
  /**
   * The one irreversible-feeling action in the designer, in four steps:
   * validate, compile, store, promote.
   *
   * It refuses an invalid paper outright. Publishing a paper with a missing
   * answer means every student who attempts that question loses a mark for
   * trying, and there is no way to fix it inside the window — so this is a hard
   * no rather than a confirmation dialog.
   *
   * Re-launching is allowed and is the normal way to correct a paper before it
   * opens: it mints a fresh AES key and a fresh blob. It is refused once the
   * test is live, because a student who already downloaded the blob holds one
   * encrypted with the old key.
   */
  const LaunchSchema = z.object({
    reason: z.string().trim().min(3).max(1000).default('launched from the designer'),
    /** Promote to `scheduled` (on sale, inside locked) or straight to `live`. */
    status: z.enum(['scheduled', 'live']).default('scheduled'),
  });

  router.post('/tests/:testId/launch', async (req, res) => {
    const me = currentUser(req);
    const testId = parseTestId(req.params.testId);
    const body = LaunchSchema.parse(req.body);

    const test = await tests.getTest(testId, pool);
    if (!test) throw notFound('no_test', 'No such test.');
    if (test.status === 'live') {
      throw badRequest(
        'already_live',
        'This test is live. Students hold a paper encrypted with the current key, so it cannot be re-published.',
      );
    }
    if (test.status === 'closed' || test.status === 'graded') {
      throw badRequest('test_finished', `This test is ${test.status}.`);
    }

    const list = await questions.listQuestions(testId, pool);
    const problems = questions.validateQuestionSet(list, {
      strictShape: test.kind === 'scholarship',
    });
    if (problems.length > 0) {
      throw badRequest(
        'paper_invalid',
        `This paper cannot be published yet: ${problems.length} problem${problems.length === 1 ? '' : 's'} to fix.`,
        { problems },
      );
    }

    const compiled = await questions.compilePaper(
      { id: test.id, name: test.name, duration_minutes: test.duration_minutes },
      list,
    );
    const digest = createHash('sha256').update(compiled.body).digest('hex');

    // The digest is in the path so that a re-launch produces a different URL.
    // The blob is immutable and served with a long max-age; reusing the URL
    // would let a student's cache hand them the previous paper.
    const paperUrl = `/papers/test-${testId}-${digest.slice(0, 12)}.json`;

    // One transaction: a blob stored without the key that opens it, or a key
    // stored without the blob, is a test that cannot be sat.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await questions.storePaperBlob(
        { testId, body: compiled.body, sha256: digest },
        client,
      );
      await tests.publishPaper(
        { testId, paperUrl, paperKey: compiled.paperKey, answerKey: compiled.answerKey },
        client,
      );
      await tests.setTestStatus(testId, body.status, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    await admin.logAdminAction(
      {
        adminId: me.id,
        action: `test_launch:${body.status}`,
        attemptId: null,
        questionId: null,
        before: { status: test.status, paperPublished: Boolean(test.paper_url) },
        after: {
          status: body.status,
          questions: list.length,
          sha256: digest,
          // Neither key is logged. The audit row records that a paper was
          // published and which one; the key itself belongs only on the test
          // row, and admin_audit is read far more casually than that column.
        },
        reason: body.reason,
      },
      pool,
    );

    log.info(
      { testId, questions: list.length, status: body.status, sha256: digest.slice(0, 12) },
      'paper launched',
    );

    res.json({
      ok: true,
      status: body.status,
      questions: list.length,
      maxMarks: list.reduce((sum, row) => sum + Number(row.marks_correct), 0),
      paperUrl,
      sha256: digest,
      sizeBytes: compiled.body.length,
    });
  });

  return router;
}

/* -------------------------------------------------------------------------- */

function parseTestId(value: string | undefined): number {
  return z.coerce.number().int().positive().parse(value);
}

/** The shape the designer draws its progress bars against. */
function paperShape() {
  return {
    subjects: PAPER.subjects,
    scqPerSubject: PAPER.scqPerSubject,
    integerPerSubject: PAPER.integerPerSubject,
    totalCount: PAPER.totalCount,
    maxMarks: PAPER.maxMarks,
  };
}

/**
 * The window has to be ordered, and the database says so too
 * (tests_window_ordered). Checked here as well so the designer gets a sentence
 * rather than a constraint name.
 */
function checkWindow(body: {
  startsAt: string;
  endsAt: string;
  lobbyOpensAt: string;
}): void {
  const lobby = new Date(body.lobbyOpensAt).getTime();
  const start = new Date(body.startsAt).getTime();
  const end = new Date(body.endsAt).getTime();
  if (!(lobby <= start)) {
    throw badRequest('bad_window', 'The lobby must open at or before the start time.');
  }
  if (!(start < end)) {
    throw badRequest('bad_window', 'The test must end after it starts.');
  }
}

function toQuestionInput(body: {
  questionRef: string;
  subject: string;
  kind: 'scq' | 'integer';
  position: number;
  body: string;
  options: { key: string; body: string; imageUrl?: string | null }[];
  correctAnswer: string | null;
  imageUrl: string | null;
  solutionText: string | null;
  solutionImageUrl: string | null;
  unit: string | null;
  marksCorrect: number;
  marksWrong: number;
}) {
  return {
    questionRef: body.questionRef,
    subject: body.subject,
    kind: body.kind,
    sortOrder: body.position,
    body: body.body,
    // An integer question must have no options — the CHECK enforces it, and
    // normalising here means a client that sends a stale options array for a
    // question whose kind was just changed gets a save rather than a 400.
    options:
      body.kind === 'integer'
        ? []
        : body.options.map((option) => ({
            key: option.key,
            body: option.body,
            imageUrl: option.imageUrl ?? null,
          })),
    correctAnswer: body.correctAnswer?.trim() ? body.correctAnswer.trim() : null,
    imageUrl: body.imageUrl,
    solutionText: body.solutionText,
    solutionImageUrl: body.solutionImageUrl,
    unit: body.kind === 'integer' ? body.unit : null,
    marksCorrect: body.marksCorrect,
    marksWrong: body.marksWrong,
  };
}

function serialiseTest(test: {
  id: number;
  name: string;
  kind: string;
  requires_payment: boolean;
  duration_minutes: number;
  starts_at: Date;
  ends_at: Date;
  lobby_opens_at: Date;
  paper_url: string | null;
  status: string;
}) {
  return {
    id: test.id,
    name: test.name,
    kind: test.kind,
    requiresPayment: test.requires_payment,
    durationMinutes: test.duration_minutes,
    startsAt: test.starts_at.toISOString(),
    endsAt: test.ends_at.toISOString(),
    lobbyOpensAt: test.lobby_opens_at.toISOString(),
    paperPublished: Boolean(test.paper_url),
    status: test.status,
  };
}

function serialiseQuestion(question: {
  id: number;
  question_ref: string;
  subject: string;
  kind: string;
  sort_order: number;
  body: string;
  options: { key: string; body: string; imageUrl?: string | null }[];
  correct_answer: string | null;
  image_url: string | null;
  solution_text: string | null;
  solution_image_url: string | null;
  unit: string | null;
  marks_correct: string | number;
  marks_wrong: string | number;
  updated_at: Date;
}) {
  return {
    id: question.id,
    questionRef: question.question_ref,
    subject: question.subject,
    kind: question.kind,
    // The API keeps calling this `position`; the column is sort_order, because
    // `position` is a reserved word in SQL.
    position: question.sort_order,
    body: question.body,
    options: question.options ?? [],
    // Admin-only. See the header comment.
    correctAnswer: question.correct_answer,
    imageUrl: question.image_url,
    solutionText: question.solution_text,
    solutionImageUrl: question.solution_image_url,
    unit: question.unit,
    marksCorrect: Number(question.marks_correct),
    marksWrong: Number(question.marks_wrong),
    updatedAt: question.updated_at?.toISOString() ?? null,
  };
}

/**
 * Turns the two CHECK constraints a bulk upload can trip into the sentence that
 * says which row is wrong and why.
 */
function asContentError(error: unknown): unknown {
  const constraint = (error as { constraint?: string } | null)?.constraint;
  const code = (error as { code?: string } | null)?.code;
  if (code !== '23514') return error;

  if (constraint === 'questions_options_match_kind') {
    return badRequest(
      'options_mismatch',
      'A single-correct question needs at least two options, and an integer question must have none.',
    );
  }
  if (constraint === 'questions_integer_answer_numeric') {
    return badRequest(
      'answer_not_numeric',
      'An integer question’s answer must be a number.',
    );
  }
  return error;
}
