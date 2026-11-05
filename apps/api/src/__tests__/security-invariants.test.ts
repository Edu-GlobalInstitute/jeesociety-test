import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The invariants that must hold however the code is refactored.
 *
 * These read the source rather than making requests, so they need no database
 * and run in CI. That is the point: each one guards something whose failure is
 * silent and expensive — an unguarded admin route, or an answer key reaching a
 * student — and a silent failure is exactly what a test should be asked to
 * notice.
 */

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'routes');

/**
 * Source with comments removed, so these checks read what the code does rather
 * than what it says about itself. Several files deliberately name a secret in
 * prose to explain why they do not touch it.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function routeFiles(): Promise<{ name: string; source: string }[]> {
  const names = (await readdir(routesDir)).filter((name) => name.endsWith('.ts'));
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(join(routesDir, name), 'utf8'),
    })),
  );
}

describe('authorisation', () => {
  /**
   * Every admin router gates itself.
   *
   * Two routers are deliberately ungated and are listed here with the reason,
   * so adding a third means deciding to add it to this list rather than
   * forgetting a guard.
   */
  const UNGATED = new Map([
    // Protected by a timing-safe setup code and refuses once the account
    // exists; it cannot require an admin because it creates the first one.
    ['admin-bootstrap.ts', 'guarded by ADMIN_BOOTSTRAP_SECRET'],
    // Serves the encrypted paper and question figures. The ciphertext is
    // public by design — the secret is the AES key, released by
    // GET /attempt/key at the start instant and never by this router.
    ['papers.ts', 'serves public ciphertext'],
  ]);

  it('gates every route file that is not deliberately public', async () => {
    const ungated: string[] = [];

    for (const file of await routeFiles()) {
      if (UNGATED.has(file.name)) continue;
      const guarded = /requireAdmin|requireUser/.test(file.source);
      if (!guarded) ungated.push(file.name);
    }

    expect(
      ungated,
      'these routers authenticate nobody; add a guard, or list them in UNGATED with a reason',
    ).toEqual([]);
  });

  it('keeps admin-named routers behind requireAdmin', async () => {
    const wrong: string[] = [];

    for (const file of await routeFiles()) {
      if (!file.name.startsWith('admin')) continue;
      if (UNGATED.has(file.name)) continue;
      if (!file.source.includes('requireAdmin')) wrong.push(file.name);
    }

    expect(wrong, 'an admin router that does not call requireAdmin').toEqual([]);
  });
});

describe('the answer key', () => {
  /**
   * The failure this exists to prevent: a question's correct answer reaching a
   * student before — or instead of — their result.
   *
   * The key lives in tests.answer_key and in questions.correct_answer. Only the
   * worker's scoring pass and the admin designer have any business reading
   * either, and the designer is behind requireAdmin.
   */
  it('is never read by a student-facing route', async () => {
    const offenders: string[] = [];

    for (const file of await routeFiles()) {
      // Admin routes may: the designer has to show an answer to let one be set.
      if (file.name.startsWith('admin')) continue;

      if (/readAnswerKeyForScoring|correct_answer|answerKey/.test(file.source)) {
        offenders.push(file.name);
      }
    }

    expect(
      offenders,
      'a non-admin route touches the answer key; scoring belongs in the worker',
    ).toEqual([]);
  });

  /**
   * The paper key decrypts the paper, so releasing it early releases the paper.
   * Exactly one route may hand it out, and only at or after the start instant —
   * the clause is in queries/tests.ts, not here, which is why this checks that
   * nothing else even reads it.
   */
  it('is matched by a paper key that only /attempt/key releases', async () => {
    const offenders: string[] = [];

    for (const file of await routeFiles()) {
      if (file.name === 'attempt.ts') continue;
      // Comments are stripped first. papers.ts explains in prose why its
      // ciphertext is safe without the key, and a test that cannot tell an
      // explanation from a call would have to be silenced to keep the
      // explanation -- which is the wrong way round.
      if (/readPaperKeyForRelease|paper_key/.test(withoutComments(file.source))) {
        offenders.push(file.name);
      }
    }

    expect(offenders, 'only attempt.ts may release the paper key').toEqual([]);
  });
});

describe('results', () => {
  /**
   * Results are launched for everyone at once, so the student-facing route must
   * check the release flag before returning a mark. Without it, every attempt
   * in the database has a score the moment the worker finishes, and anyone
   * refreshing would see the cohort's results early.
   */
  it('checks the release flag before returning a score', async () => {
    const source = await readFile(join(routesDir, 'results.ts'), 'utf8');
    expect(source).toMatch(/results_released_at/);
    expect(source).toMatch(/released/);
  });
});

describe('secrets', () => {
  /** A hard-coded credential in a route is a credential in the repository. */
  it('are not hard-coded in any route', async () => {
    const patterns = [
      /rzp_live_[A-Za-z0-9]{8,}/,
      /npg_[A-Za-z0-9]{12,}/,
      /postgres(?:ql)?:\/\/[^\s'"]*:[^\s'"]+@/,
      /sk_live_[A-Za-z0-9]{8,}/,
    ];
    const offenders: string[] = [];

    for (const file of await routeFiles()) {
      if (patterns.some((pattern) => pattern.test(file.source))) offenders.push(file.name);
    }

    expect(offenders, 'a route contains something that looks like a live credential').toEqual([]);
  });
});
