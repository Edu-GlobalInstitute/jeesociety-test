import {
  PAPER,
  decryptPaper,
  encryptPaper,
  generatePaperKey,
  type AnswerKey,
  type Paper,
  type Question,
  type QuestionKind,
} from '@jee/shared';
import { one, rows, type Queryable } from '../query.js';

/**
 * The question bank: the editable source a paper is built from.
 *
 * Two kinds of read live in this file and they must not be confused.
 * `listQuestions` returns `correct_answer` — it backs the designer, which is
 * behind requireAdmin. `compilePaper` reads the answers too, but puts them in
 * `tests.answer_key` and builds the student-facing blob from the other columns
 * only. There is no function here that a student-facing route may call, and no
 * route outside admin.ts imports this module.
 */

export interface QuestionOption {
  key: string;
  body: string;
  imageUrl?: string | null;
}

export interface QuestionRow {
  id: number;
  test_id: number;
  question_ref: string;
  subject: string;
  kind: QuestionKind;
  sort_order: number;
  body: string;
  options: QuestionOption[];
  /** SECRET relative to students. Admin-only reads. */
  correct_answer: string | null;
  image_url: string | null;
  solution_text: string | null;
  solution_image_url: string | null;
  unit: string | null;
  marks_correct: string;
  marks_wrong: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  id, test_id, question_ref, subject, kind, sort_order, body, options,
  correct_answer, image_url, solution_text, solution_image_url, unit,
  marks_correct, marks_wrong, created_at, updated_at
`;

/** Paper order: by subject as the paper lists them, then by position. */
export function listQuestions(testId: number, db?: Queryable): Promise<QuestionRow[]> {
  return rows<QuestionRow>(
    `SELECT ${COLUMNS} FROM questions
      WHERE test_id = $1
      ORDER BY array_position($2::text[], subject), sort_order, id`,
    [testId, PAPER.subjects as readonly string[]],
    db,
  );
}

export function getQuestion(id: number, db?: Queryable): Promise<QuestionRow | null> {
  return one<QuestionRow>(`SELECT ${COLUMNS} FROM questions WHERE id = $1`, [id], db);
}

export interface QuestionInput {
  questionRef: string;
  subject: string;
  kind: QuestionKind;
  /** Order within the subject. Stored in the sort_order column. */
  sortOrder: number;
  body: string;
  options: QuestionOption[];
  correctAnswer: string | null;
  imageUrl: string | null;
  solutionText: string | null;
  solutionImageUrl: string | null;
  unit: string | null;
  marksCorrect: number;
  marksWrong: number;
}

/**
 * Inserts or replaces one question, keyed on (test_id, question_ref).
 *
 * Upsert rather than insert so that re-uploading a corrected spreadsheet
 * updates the paper instead of failing on 75 duplicate refs — which is how a
 * bulk upload is actually used: once to get the questions in, then again after
 * someone spots a typo in question 34.
 */
export function upsertQuestion(
  testId: number,
  input: QuestionInput,
  db?: Queryable,
): Promise<QuestionRow | null> {
  return one<QuestionRow>(
    `INSERT INTO questions
       (test_id, question_ref, subject, kind, sort_order, body, options,
        correct_answer, image_url, solution_text, solution_image_url, unit,
        marks_correct, marks_wrong)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (test_id, question_ref) DO UPDATE SET
       subject = excluded.subject,
       kind = excluded.kind,
       sort_order = excluded.sort_order,
       body = excluded.body,
       options = excluded.options,
       correct_answer = excluded.correct_answer,
       image_url = excluded.image_url,
       solution_text = excluded.solution_text,
       solution_image_url = excluded.solution_image_url,
       unit = excluded.unit,
       marks_correct = excluded.marks_correct,
       marks_wrong = excluded.marks_wrong
     RETURNING ${COLUMNS}`,
    [
      testId,
      input.questionRef,
      input.subject,
      input.kind,
      input.sortOrder,
      input.body,
      JSON.stringify(input.options),
      input.correctAnswer,
      input.imageUrl,
      input.solutionText,
      input.solutionImageUrl,
      input.unit,
      input.marksCorrect,
      input.marksWrong,
    ],
    db,
  );
}

export async function deleteQuestion(id: number, db?: Queryable): Promise<void> {
  await rows(`DELETE FROM questions WHERE id = $1`, [id], db);
}

export interface BankSummary {
  total: number;
  complete: number;
  bySubject: { subject: string; scq: number; integer: number; incomplete: number }[];
}

/**
 * What the designer shows above the question list, and what tells an admin
 * whether this paper can be launched before they try.
 */
export async function bankSummary(testId: number, db?: Queryable): Promise<BankSummary> {
  const perSubject = await rows<{
    subject: string;
    scq: string;
    integer: string;
    incomplete: string;
  }>(
    `SELECT subject,
            count(*) FILTER (WHERE kind = 'scq')     AS scq,
            count(*) FILTER (WHERE kind = 'integer') AS integer,
            count(*) FILTER (WHERE correct_answer IS NULL) AS incomplete
       FROM questions WHERE test_id = $1
      GROUP BY subject
      ORDER BY array_position($2::text[], subject)`,
    [testId, PAPER.subjects as readonly string[]],
    db,
  );

  const bySubject = perSubject.map((row) => ({
    subject: row.subject,
    scq: Number(row.scq),
    integer: Number(row.integer),
    incomplete: Number(row.incomplete),
  }));

  const total = bySubject.reduce((sum, row) => sum + row.scq + row.integer, 0);
  const incomplete = bySubject.reduce((sum, row) => sum + row.incomplete, 0);
  return { total, complete: total - incomplete, bySubject };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every way a question set can be unpublishable, as a list of sentences.
 *
 * These are the same rules tools/build-paper/src/cli.ts enforces, and they are
 * here rather than there because the designer needs to show them continuously
 * while a paper is being written, not once at the end. The CLI stays as it is;
 * both paths therefore refuse the same papers.
 *
 * Each rule exists because of what it costs to get wrong at 09:00 with 25,000
 * students watching — noted per rule, because a validator nobody understands
 * gets bypassed the first time it is inconvenient.
 */
export function validateQuestionSet(
  questions: QuestionRow[],
  options: { strictShape?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const strict = options.strictShape ?? true;

  if (questions.length === 0) {
    return ['This test has no questions yet.'];
  }

  const seenRefs = new Set<string>();
  const bySubject = new Map<string, { scq: number; integer: number }>();

  for (const question of questions) {
    const ref = question.question_ref;

    // Two questions numbered q12 is a paper that cannot be marked: answers are
    // keyed by ref, so one would overwrite the other.
    if (seenRefs.has(ref)) problems.push(`${ref}: duplicate question number.`);
    seenRefs.add(ref);

    if (!question.body?.trim()) problems.push(`${ref}: the question is empty.`);

    // Unanswerable question. Every question is machine-marked against the key,
    // so a missing answer is every student scoring zero on it however well they
    // did — and with negative marking, worse than zero for trying.
    const answer = question.correct_answer?.trim();
    if (!answer) {
      problems.push(`${ref}: no correct answer set.`);
    }

    const counts = bySubject.get(question.subject) ?? { scq: 0, integer: 0 };

    if (question.kind === 'scq') {
      counts.scq += 1;
      const optionList = question.options ?? [];
      if (optionList.length < 2) {
        problems.push(`${ref}: needs at least two options.`);
      }
      const optionKeys = new Set<string>();
      for (const option of optionList) {
        if (!option.key?.trim()) problems.push(`${ref}: an option has no letter.`);
        // An option with no text and no image is a blank a student must choose
        // between. Either alone is fine — a figure-only option is ordinary in
        // physics.
        if (!option.body?.trim() && !option.imageUrl) {
          problems.push(`${ref}: option ${option.key || '?'} is blank.`);
        }
        if (optionKeys.has(option.key)) {
          problems.push(`${ref}: two options are both labelled ${option.key}.`);
        }
        optionKeys.add(option.key);
      }
      // The key must name one of this question's own options. Otherwise the
      // question is unanswerable and every student who attempts it loses a
      // mark — the failure the CLI calls out by name.
      if (answer && !optionKeys.has(answer)) {
        problems.push(
          `${ref}: the correct answer "${answer}" is not one of its options.`,
        );
      }
    } else {
      counts.integer += 1;
      // Scoring compares integer answers numerically, so a non-numeric key can
      // never match anything a student can type.
      if (answer && !Number.isFinite(Number(answer))) {
        problems.push(`${ref}: the answer "${answer}" is not a number.`);
      }
      if ((question.options ?? []).length > 0) {
        problems.push(`${ref}: an integer question must not have options.`);
      }
    }

    bySubject.set(question.subject, counts);

    if (!(PAPER.subjects as readonly string[]).includes(question.subject)) {
      problems.push(`${ref}: "${question.subject}" is not a subject in this paper.`);
    }
  }

  // Shape. Checked per subject as well as in total, because 75 questions that
  // are all physics would pass a total-only check and be the wrong paper.
  //
  // Relaxed for mock tests: a 20-question chemistry-only mock is a legitimate
  // thing to set, and insisting on the full JEE pattern would make the designer
  // refuse most of what mocks are for. The scholarship paper is the one that
  // has to be exactly the advertised shape, because its marks are what the
  // landing page quotes and what the reward bands rank on.
  if (strict) {
    const scq = questions.filter((q) => q.kind === 'scq').length;
    const integer = questions.filter((q) => q.kind === 'integer').length;
    if (scq !== PAPER.scqCount) {
      problems.push(`Expected ${PAPER.scqCount} single-correct questions, found ${scq}.`);
    }
    if (integer !== PAPER.integerCount) {
      problems.push(`Expected ${PAPER.integerCount} integer questions, found ${integer}.`);
    }
    for (const subject of PAPER.subjects) {
      const counts = bySubject.get(subject);
      if (!counts) {
        problems.push(`No ${subject} questions at all.`);
        continue;
      }
      if (counts.scq !== PAPER.scqPerSubject) {
        problems.push(
          `${subject}: expected ${PAPER.scqPerSubject} single-correct, found ${counts.scq}.`,
        );
      }
      if (counts.integer !== PAPER.integerPerSubject) {
        problems.push(
          `${subject}: expected ${PAPER.integerPerSubject} integer, found ${counts.integer}.`,
        );
      }
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Compile                                                                     */
/* -------------------------------------------------------------------------- */

export interface CompiledPaper {
  paper: Paper;
  answerKey: AnswerKey;
  /** The encrypted blob, serialised, ready to be stored or uploaded. */
  body: Buffer;
  paperKey: string;
}

/**
 * Turns the question rows into the two artefacts the event needs: a blob the
 * whole cohort downloads, and an answer key only the server ever sees.
 *
 * This is tools/build-paper's pipeline, called from a request instead of a
 * shell, and it keeps the property that made the CLI safe: the paper handed to
 * students is assembled field by field from the columns that are not secret.
 * `correct_answer` is read in this function and written only into `answerKey`,
 * so there is no object in flight that holds both a question and its answer and
 * could be serialised into a response by accident.
 *
 * The round-trip check is kept too, and it is not ceremony. If the ciphertext
 * did not decrypt back to its input, 25,000 students would reach the start
 * instant, receive the key, and find an unopenable paper — with no way to fix
 * it inside the window. Verifying here costs a few milliseconds once.
 */
export async function compilePaper(
  test: { id: number; name: string; duration_minutes: number },
  questions: QuestionRow[],
): Promise<CompiledPaper> {
  const answerKey: AnswerKey = {};

  const paperQuestions: Question[] = questions.map((row) => {
    // Read here, written only to answerKey. Never onto the object below.
    answerKey[row.question_ref] = (row.correct_answer ?? '').trim();

    if (row.kind === 'scq') {
      return {
        id: row.question_ref,
        kind: 'scq',
        subject: row.subject,
        body: withImage(row.body, row.image_url),
        options: (row.options ?? []).map((option) => ({
          key: option.key,
          body: withImage(option.body, option.imageUrl ?? null),
        })),
      };
    }
    return {
      id: row.question_ref,
      kind: 'integer',
      subject: row.subject,
      body: withImage(row.body, row.image_url),
      ...(row.unit ? { unit: row.unit } : {}),
    };
  });

  const paper: Paper = {
    testId: test.id,
    name: test.name,
    durationMinutes: test.duration_minutes,
    questions: paperQuestions,
  };

  const paperKey = generatePaperKey();
  const blob = await encryptPaper(paper, paperKey);
  const body = Buffer.from(JSON.stringify(blob), 'utf8');

  const roundTrip = await decryptPaper(blob, paperKey);
  if (JSON.stringify(roundTrip) !== JSON.stringify(paper)) {
    throw new Error('Paper round-trip verification failed — refusing to publish.');
  }

  return { paper, answerKey, body, paperKey };
}

/**
 * Figures travel inside the body as Markdown.
 *
 * The exam client renders question bodies and option bodies; it has no field
 * for a separate image, and giving it one would mean changing the client, the
 * `Paper` type and the offline cache for every student. Appending the image as
 * Markdown puts the figure in the one place the client already draws, and keeps
 * `image_url` as its own editable column in the designer.
 */
function withImage(body: string, imageUrl: string | null): string {
  if (!imageUrl) return body;
  return `${body}\n\n![figure](${imageUrl})`;
}

/* -------------------------------------------------------------------------- */
/* Blob storage                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Stores a compiled blob so the API can serve it.
 *
 * Only used when no object store is configured — see the table comment in
 * 006_admin_portal.sql. The ciphertext is public by design, so this row is not
 * secret; the key it needs is on the `tests` row and is released by
 * GET /attempt/key at the start instant and not before.
 */
export async function storePaperBlob(
  params: { testId: number; body: Buffer; sha256: string },
  db?: Queryable,
): Promise<void> {
  await rows(
    `INSERT INTO paper_blobs (test_id, body, sha256, size_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (test_id) DO UPDATE SET
       body = excluded.body,
       sha256 = excluded.sha256,
       size_bytes = excluded.size_bytes,
       created_at = now()`,
    [params.testId, params.body, params.sha256, params.body.length],
    db,
  );
}

export interface PaperBlobRow {
  body: Buffer;
  sha256: string;
  size_bytes: number;
}

export function getPaperBlob(
  testId: number,
  db?: Queryable,
): Promise<PaperBlobRow | null> {
  return one<PaperBlobRow>(
    `SELECT body, sha256, size_bytes FROM paper_blobs WHERE test_id = $1`,
    [testId],
    db,
  );
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

export interface ImageRow {
  id: string;
  mime_type: string;
  size_bytes: number;
  body: Buffer;
}

export async function storeImage(
  params: {
    id: string;
    testId: number | null;
    uploadedBy: string;
    mimeType: string;
    body: Buffer;
  },
  db?: Queryable,
): Promise<void> {
  await rows(
    `INSERT INTO question_images
       (id, test_id, uploaded_by, mime_type, size_bytes, body)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.id,
      params.testId,
      params.uploadedBy,
      params.mimeType,
      params.body.length,
      params.body,
    ],
    db,
  );
}

export function getImage(id: string, db?: Queryable): Promise<ImageRow | null> {
  return one<ImageRow>(
    `SELECT id, mime_type, size_bytes, body FROM question_images WHERE id = $1`,
    [id],
    db,
  );
}

/** The media library for one test, newest first. Bodies are not selected. */
export function listImages(
  testId: number,
  db?: Queryable,
): Promise<{ id: string; mime_type: string; size_bytes: number; created_at: Date }[]> {
  return rows(
    `SELECT id, mime_type, size_bytes, created_at
       FROM question_images WHERE test_id = $1
      ORDER BY created_at DESC LIMIT 500`,
    [testId],
    db,
  );
}
