import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  PAPER,
  encryptPaper,
  generatePaperKey,
  decryptPaper,
  type Paper,
  type AnswerKey,
} from '@jee/shared';
import { closePool, getPool, one } from '@jee/db';
import { putObject, type R2Config } from './r2.js';

/**
 * Builds the question paper for an event.
 *
 *   pnpm --filter @jee/build-paper build-paper -- \
 *     --input paper.json --test 1 [--upload] [--dry-run]
 *
 * What it does, in order:
 *   1. validates the paper: 75 questions in the 20-single-correct-plus-5-integer
 *      shape per subject, every one of them with an answer in the key
 *   2. encrypts it with a fresh AES-256-GCM key
 *   3. verifies the ciphertext decrypts back to the exact input — the one
 *      check that makes a bad upload impossible to miss
 *   4. uploads the blob to R2 behind the CDN
 *   5. writes paper_url, paper_key and answer_key to the tests row
 *
 * The answer key goes into the database and never near the blob. The blob is
 * public by design: the secret is the key, not the ciphertext.
 */

interface InputFile {
  paper: Paper;
  answerKey: AnswerKey;
}

const args = process.argv.slice(2);
function flag(name: string): boolean {
  return args.includes(`--${name}`);
}
function value(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const inputPath = value('input');
const testId = Number(value('test'));
const dryRun = flag('dry-run');
const upload = flag('upload');

if (!inputPath || !Number.isFinite(testId)) {
  console.error(
    'usage: build-paper --input <paper.json> --test <testId> [--upload] [--dry-run]',
  );
  process.exit(1);
}

const input = JSON.parse(await readFile(resolve(inputPath), 'utf8')) as InputFile;

/* ------------------------------------------------------------ validate -- */

const problems: string[] = [];
const ids = new Set<string>();

const bySubject = new Map<string, { scq: number; integer: number }>();

for (const question of input.paper.questions) {
  if (ids.has(question.id)) problems.push(`duplicate question id ${question.id}`);
  ids.add(question.id);
  if (!question.body?.trim()) problems.push(`${question.id} has no body`);

  // Every question is machine-marked, so every question needs a key entry.
  // A missing one is 10,000 students scoring zero on a question they answered.
  const expected = input.answerKey[question.id];
  if (expected === undefined || String(expected).trim() === '') {
    problems.push(`${question.id} has no answer in the key`);
  }

  const counts = bySubject.get(question.subject) ?? { scq: 0, integer: 0 };
  if (question.kind === 'scq') {
    counts.scq += 1;
    if (!question.options?.length) problems.push(`${question.id} has no options`);
    else if (expected !== undefined && !question.options.some((o) => o.key === expected)) {
      // The key must name one of this question's own options, or the question
      // is unanswerable and every student gets −1 for trying.
      problems.push(`${question.id}: key "${expected}" is not one of its options`);
    }
  } else {
    counts.integer += 1;
    // Scoring compares integer answers numerically (scoring.ts), so a key that
    // is not a number can never be matched by anything a student can type.
    if (expected !== undefined && !Number.isFinite(Number(String(expected).trim()))) {
      problems.push(`${question.id} is an integer question but its key "${expected}" is not a number`);
    }
  }
  bySubject.set(question.subject, counts);
}

const scqCount = input.paper.questions.filter((q) => q.kind === 'scq').length;
const integerCount = input.paper.questions.filter((q) => q.kind === 'integer').length;
if (scqCount !== PAPER.scqCount) {
  problems.push(`expected ${PAPER.scqCount} single-correct, found ${scqCount}`);
}
if (integerCount !== PAPER.integerCount) {
  problems.push(`expected ${PAPER.integerCount} integer, found ${integerCount}`);
}

// Per subject as well as in total: 75 questions that are all physics would
// pass a total-only check and be the wrong paper.
for (const subject of PAPER.subjects) {
  const counts = bySubject.get(subject);
  if (!counts) {
    problems.push(`no questions for subject ${subject}`);
    continue;
  }
  if (counts.scq !== PAPER.scqPerSubject) {
    problems.push(
      `${subject}: expected ${PAPER.scqPerSubject} single-correct, found ${counts.scq}`,
    );
  }
  if (counts.integer !== PAPER.integerPerSubject) {
    problems.push(
      `${subject}: expected ${PAPER.integerPerSubject} integer, found ${counts.integer}`,
    );
  }
}
for (const subject of bySubject.keys()) {
  if (!(PAPER.subjects as readonly string[]).includes(subject)) {
    problems.push(`unknown subject ${subject}`);
  }
}

for (const questionId of Object.keys(input.answerKey)) {
  if (!ids.has(questionId)) problems.push(`answer key entry for unknown question ${questionId}`);
}

if (problems.length > 0) {
  console.error('The paper did not validate:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

/* ------------------------------------------------------------- encrypt -- */

const paper: Paper = { ...input.paper, testId };
const paperKey = generatePaperKey();
const blob = await encryptPaper(paper, paperKey);
const body = Buffer.from(JSON.stringify(blob), 'utf8');

// Decrypt what we are about to publish, with the key we are about to store,
// and compare it byte for byte against the input. If this ever fails, 10,000
// students would have been handed an unopenable paper at the start instant.
const roundTrip = await decryptPaper(blob, paperKey);
if (JSON.stringify(roundTrip) !== JSON.stringify(paper)) {
  console.error('round-trip verification failed — refusing to publish');
  process.exit(1);
}

const digest = createHash('sha256').update(body).digest('hex');
const key = `papers/test-${testId}-${digest.slice(0, 12)}.json`;

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
await mkdir(outDir, { recursive: true });
const localPath = join(outDir, `paper-${testId}.json`);
await writeFile(localPath, body);

console.log(
  [
    '',
    `questions      ${paper.questions.length} (${scqCount} single-correct, ${integerCount} integer)`,
    `marks          ${PAPER.maxMarks}`,
    `blob           ${(body.length / 1024).toFixed(1)} KB`,
    `sha256         ${digest}`,
    `local copy     ${localPath}`,
    `round trip     verified`,
    '',
  ].join('\n'),
);

if (dryRun) {
  console.log('dry run — nothing uploaded, nothing written to the database');
  process.exit(0);
}

/* -------------------------------------------------------------- upload -- */

let paperUrl = `file://${localPath}`;

if (upload) {
  const config: R2Config = {
    accountId: process.env.R2_ACCOUNT_ID ?? '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    bucket: process.env.R2_BUCKET ?? '',
  };
  if (!config.accountId || !config.accessKeyId || !config.bucket) {
    console.error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must be set');
    process.exit(1);
  }
  await putObject(config, key, body, 'application/json');
  const base = process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
  paperUrl = `${base}/${key}`;
  console.log(`uploaded       ${paperUrl}`);
}

/* ------------------------------------------------------------ database -- */

const pool = getPool();
const updated = await one<{ id: number }>(
  `UPDATE tests
      SET paper_url = $2, paper_key = $3, answer_key = $4
    WHERE id = $1
    RETURNING id`,
  [testId, paperUrl, paperKey, JSON.stringify(input.answerKey)],
);
await closePool();

if (!updated) {
  console.error(`no test with id ${testId}`);
  process.exit(1);
}

console.log(
  [
    `test ${testId} updated.`,
    '',
    'The key and answer key are in the database and are not printed here.',
    'Verify before the event:',
    `  select paper_url, paper_key is not null as has_key,`,
    `         jsonb_array_length(coalesce(to_jsonb(answer_key), '[]')) is not null as has_answers`,
    `    from tests where id = ${testId};`,
    '',
  ].join('\n'),
);
