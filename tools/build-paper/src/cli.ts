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
  type RubricMap,
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
 *   1. validates the paper (75 questions, every subjective one has a rubric,
 *      every MCQ has an answer in the key)
 *   2. encrypts it with a fresh AES-256-GCM key
 *   3. verifies the ciphertext decrypts back to the exact input — the one
 *      check that makes a bad upload impossible to miss
 *   4. uploads the blob to R2 behind the CDN
 *   5. writes paper_url, paper_key, answer_key and rubrics to the tests row
 *
 * The answer key and the rubrics go into the database and never near the blob.
 * The blob is public by design: the secret is the key, not the ciphertext.
 */

interface InputFile {
  paper: Paper;
  answerKey: AnswerKey;
  rubrics: RubricMap;
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

for (const question of input.paper.questions) {
  if (ids.has(question.id)) problems.push(`duplicate question id ${question.id}`);
  ids.add(question.id);
  if (!question.body?.trim()) problems.push(`${question.id} has no body`);
  if (question.kind === 'mcq') {
    if (!question.options?.length) problems.push(`${question.id} has no options`);
    if (!input.answerKey[question.id]) problems.push(`${question.id} has no answer in the key`);
  } else if (!input.rubrics[question.id]) {
    // Without a rubric a subjective question cannot be graded consistently, so
    // enqueueing it would only produce 10,000 jobs that fail.
    problems.push(`${question.id} is subjective but has no rubric`);
  }
}

const mcqCount = input.paper.questions.filter((q) => q.kind === 'mcq').length;
const subjectiveCount = input.paper.questions.filter((q) => q.kind === 'subjective').length;
if (mcqCount !== PAPER.mcqCount) problems.push(`expected ${PAPER.mcqCount} MCQ, found ${mcqCount}`);
if (subjectiveCount !== PAPER.subjectiveCount) {
  problems.push(`expected ${PAPER.subjectiveCount} subjective, found ${subjectiveCount}`);
}

for (const [questionId, rubric] of Object.entries(input.rubrics)) {
  if (!ids.has(questionId)) problems.push(`rubric for unknown question ${questionId}`);
  if ((rubric.examples?.length ?? 0) < 2) {
    // Few-shot anchors do more for consistency across 150,000 calls than any
    // instruction about strictness.
    problems.push(`rubric ${questionId} has fewer than 2 worked examples`);
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
    `questions      ${paper.questions.length} (${mcqCount} mcq, ${subjectiveCount} subjective)`,
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
      SET paper_url = $2, paper_key = $3, answer_key = $4, rubrics = $5
    WHERE id = $1
    RETURNING id`,
  [testId, paperUrl, paperKey, JSON.stringify(input.answerKey), JSON.stringify(input.rubrics)],
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
