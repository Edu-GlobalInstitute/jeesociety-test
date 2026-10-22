import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level invariants.
 *
 * These are the rules that cannot be enforced by a type or a constraint, and
 * whose violation would not fail any other test — it would simply leak the
 * answer key during the event. They are checked against the source tree so
 * they hold for code that has not been written yet.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function sourceFiles(...roots: string[]): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.next', 'out', '__tests__'].includes(entry.name)) continue;
        await walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        out.push(path);
      }
    }
  }
  for (const root of roots) await walk(join(repoRoot, root));
  return out;
}

/** Strips comments, so prose about a rule is not mistaken for breaking it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('answer key isolation', () => {
  it('has no SELECT * anywhere in server-side code', async () => {
    const files = await sourceFiles('packages/db/src', 'apps/api/src', 'apps/worker/src');
    const offenders: string[] = [];

    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      if (/select\s+\*/i.test(code)) offenders.push(relative(repoRoot, file));
    }

    // A SELECT * on `tests` pulls paper_key and answer_key into a row object,
    // and from there one careless res.json() invalidates the whole event.
    expect(offenders).toEqual([]);
  });

  it('reads the secret columns in exactly one place each', async () => {
    const files = await sourceFiles('packages/db/src', 'apps/api/src', 'apps/worker/src');
    const readers: string[] = [];

    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      // A read is a SELECT naming the column; the writes in the seed and the
      // paper builder are not reads and are not in these directories.
      if (/select[^;]*\b(paper_key|answer_key)\b/is.test(code)) {
        readers.push(relative(repoRoot, file));
      }
    }

    expect(readers).toEqual(['packages/db/src/queries/tests.ts']);
  });

  it('guards the paper key release on starts_at in SQL, not only in the route', async () => {
    const source = await readFile(join(repoRoot, 'packages/db/src/queries/tests.ts'), 'utf8');
    const release = /readPaperKeyForRelease[\s\S]*?^}/m.exec(source)?.[0] ?? '';

    // Repeating the check in SQL means a bug in the route cannot release the
    // key early.
    expect(release).toMatch(/SELECT paper_key/i);
    expect(release).toMatch(/now\(\)\s*>=\s*starts_at/i);
  });

  it('never hands a bare row to res.json', async () => {
    const files = await sourceFiles('apps/api/src');
    const offenders: string[] = [];

    for (const file of files) {
      const code = stripComments(await readFile(file, 'utf8'));
      for (const match of code.matchAll(/res\.json\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        // Only an object literal, a pick() or an explicitly built value is
        // allowed — never a row straight out of a query.
        offenders.push(`${relative(repoRoot, file)}: res.json(${match[1]})`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('nothing auto-penalises a student', () => {
  it('has no path from flag computation to a score column', async () => {
    const flagJob = await readFile(
      join(repoRoot, 'apps/worker/src/jobs/computeFlags.ts'),
      'utf8',
    );
    const code = stripComments(flagJob);

    expect(code).not.toMatch(/mcq_score|subjective_score|total_score/);
    expect(code).not.toMatch(/UPDATE\s+attempts\s+SET[^;]*score/is);
  });

  it('writes flags only through addFlags, which touches no score', async () => {
    const attemptsQueries = await readFile(
      join(repoRoot, 'packages/db/src/queries/attempts.ts'),
      'utf8',
    );
    const addFlags = /export async function addFlags[\s\S]*?^}/m.exec(attemptsQueries)?.[0] ?? '';

    expect(addFlags).toMatch(/needs_review = true/);
    expect(addFlags).not.toMatch(/score/);
  });
});

describe('answers never reach the logs', () => {
  it('redacts answer content in both services', async () => {
    for (const path of ['apps/api/src/logger.ts', 'apps/worker/src/worker.ts']) {
      const source = await readFile(join(repoRoot, path), 'utf8');
      // Most of these students are minors and their answers are the most
      // sensitive thing in the system.
      expect(source).toMatch(/\*\.answers/);
      expect(source).toMatch(/paper_key/);
      expect(source).toMatch(/answer_key/);
    }
  });
});
