import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listMigrations, migrationsDir } from '../migrate.js';

/**
 * Properties of the migration set itself, checked without a database.
 *
 * The migration runner applies files in filename order and records each by
 * name, so the filenames are not cosmetic — they are the schedule and the
 * ledger. Two of these cases come from real near-misses in this repo:
 *
 *   Two different branches each added an `008_`. Merging them would have put
 *   two files at the same position with no defined order between them, and a
 *   database that had already recorded one `008_...sql` would skip neither and
 *   apply both out of sequence.
 *
 *   A migration edited after being applied is invisible: the runner sees the
 *   name in schema_migrations and never opens the file again, so the change
 *   reaches no environment that has already run it. That cannot be caught here,
 *   but the numbering rules that make it likely can be.
 */

describe('migration files', () => {
  it('are numbered uniquely', async () => {
    const files = await listMigrations(migrationsDir);
    const byNumber = new Map<string, string[]>();

    for (const file of files) {
      const prefix = /^(\d+)_/.exec(file)?.[1];
      expect(prefix, `${file} does not start with a number`).toBeDefined();
      byNumber.set(prefix!, [...(byNumber.get(prefix!) ?? []), file]);
    }

    const duplicates = [...byNumber.entries()].filter(([, names]) => names.length > 1);
    expect(
      duplicates.map(([number, names]) => `${number}: ${names.join(', ')}`),
      'two migrations share a number, so their apply order is undefined',
    ).toEqual([]);
  });

  it('are numbered consecutively from 001', async () => {
    const files = await listMigrations(migrationsDir);
    const numbers = files.map((file) => Number(/^(\d+)_/.exec(file)![1]));

    // A gap is not fatal, but it usually means a file was deleted after being
    // applied somewhere — which leaves that environment holding a row in
    // schema_migrations for a migration no longer in the tree.
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it('are not empty and end in .sql', async () => {
    const files = await listMigrations(migrationsDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      expect(file.endsWith('.sql'), `${file} is not a .sql file`).toBe(true);
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      expect(sql.trim().length, `${file} is empty`).toBeGreaterThan(0);
    }
  });

  /**
   * The whole file is sent to Postgres as one string, inside one transaction.
   * An unbalanced dollar-quote silently swallows the rest of the file as part
   * of a function body, so the statements after it never run and nothing
   * reports an error.
   */
  it('have balanced dollar quotes', async () => {
    const files = await listMigrations(migrationsDir);

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const markers = sql.match(/\$\$/g)?.length ?? 0;
      expect(markers % 2, `${file} has an unbalanced $$ quote`).toBe(0);
    }
  });
});
