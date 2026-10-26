import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptPaper, generatePaperKey, CLIENT_TIMING, PAPER } from '@jee/shared';
import { closePool, getPool } from '../pool.js';
import { migrate } from '../migrate.js';
import { one } from '../query.js';
import { samplePaper } from '../samplePaper.js';

/**
 * Seeds a complete, runnable test event for local development.
 *
 *   pnpm seed                      test starts in 35 minutes (lobby open now)
 *   pnpm seed -- --starts-in 2     test starts in 2 minutes
 *   pnpm seed -- --duration 10     10-minute window instead of 180
 *   pnpm seed -- --admin a@b.c     promote an existing user to admin
 *   pnpm seed -- --locked          seed the test as `scheduled`, so the exam
 *                                  client shows its coming-soon screen
 *
 * The encrypted paper is written to tools/build-paper/out/ and served by the API
 * in development at /papers/<file>, standing in for the CDN. The key goes into
 * tests.paper_key and is released only by GET /attempt/key at starts_at —
 * exactly as it will be on the day.
 */

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const startsInMinutes = Number(arg('starts-in', '35'));
const durationMinutes = Number(arg('duration', '180'));
const adminEmail = arg('admin');
/**
 * The seeded test goes in `live` so a local run exercises the whole flow
 * end to end. `--locked` seeds `scheduled` instead, which is how the test sits
 * while it is on sale and the inside is not open — the state the coming-soon
 * screen exists for.
 */
const locked = args.includes('--locked');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const paperOutDir = join(repoRoot, 'tools/build-paper/out');

const pool = getPool();
await migrate(pool, undefined, (m) => console.log(m));

const startsAt = new Date(Date.now() + startsInMinutes * 60_000);
const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
const lobbyOpensAt = new Date(startsAt.getTime() - CLIENT_TIMING.lobbyLeadMs);

const created = await one<{ id: number }>(
  `INSERT INTO tests (name, starts_at, ends_at, lobby_opens_at, status)
        VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
  [
    `Dev Test ${new Date().toISOString().slice(0, 16)}`,
    startsAt,
    endsAt,
    lobbyOpensAt,
    locked ? 'scheduled' : 'live',
  ],
);
const testId = created!.id;

const { paper, answerKey } = samplePaper(testId);
const paperKey = generatePaperKey();
const blob = await encryptPaper(paper, paperKey);

await mkdir(paperOutDir, { recursive: true });
const fileName = `paper-${testId}.json`;
await writeFile(join(paperOutDir, fileName), JSON.stringify(blob), 'utf8');

const paperUrl = `${process.env.PAPER_BASE_URL ?? 'http://localhost:3000/papers'}/${fileName}`;

await pool.query(
  `UPDATE tests SET paper_url = $2, paper_key = $3, answer_key = $4
    WHERE id = $1`,
  [testId, paperUrl, paperKey, JSON.stringify(answerKey)],
);

if (adminEmail) {
  const user = await one<{ id: string }>(`SELECT "id" FROM "user" WHERE "email" = $1`, [
    adminEmail,
  ]);
  if (!user) {
    console.error(`no user with email ${adminEmail}; sign up first, then re-run with --admin`);
  } else {
    await pool.query(
      `INSERT INTO admins (user_id, note) VALUES ($1, 'seeded')
       ON CONFLICT (user_id) DO NOTHING`,
      [user.id],
    );
    console.log(`promoted ${adminEmail} to admin`);
  }
}

console.log(
  [
    '',
    `test id        ${testId}`,
    `status         ${locked ? 'scheduled (locked — exam shows coming soon)' : 'live'}`,
    `lobby opens    ${lobbyOpensAt.toISOString()}`,
    `starts         ${startsAt.toISOString()}`,
    `ends           ${endsAt.toISOString()}`,
    `paper          ${join(paperOutDir, fileName)}`,
    `paper url      ${paperUrl}`,
    `questions      ${paper.questions.length} (${PAPER.scqCount} single-correct, ${PAPER.integerCount} integer)`,
    '',
    'The answer key and paper key are in the tests row and are never served.',
    '',
  ].join('\n'),
);

await closePool();
