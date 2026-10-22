import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

/**
 * Migrations are numbered .sql files applied in filename order, each inside its
 * own transaction, recorded in schema_migrations. No ORM auto-sync: the schema
 * in migrations/ is the schema in production, and both are reviewable in a diff.
 *
 * A Postgres advisory lock serialises concurrent runners, so four API replicas
 * booting at once cannot race each other through the same file.
 */

const MIGRATION_LOCK = 4_815_162_342;

export const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

async function listMigrations(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

export async function migrate(
  pool: Pool,
  dir: string = migrationsDir,
  log: (message: string) => void = () => {},
): Promise<MigrationResult> {
  const files = await listMigrations(dir);
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    for (const file of files) {
      if (done.has(file)) {
        alreadyApplied.push(file);
        continue;
      }
      const sql = await readFile(join(dir, file), 'utf8');
      log(`applying ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }

  return { applied, alreadyApplied };
}
