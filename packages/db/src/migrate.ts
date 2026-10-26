import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from './pool.js';

/**
 * Migrations are numbered .sql files applied in filename order, each inside its
 * own transaction, recorded in schema_migrations. No ORM auto-sync: the schema
 * in migrations/ is the schema in production, and both are reviewable in a diff.
 *
 * A Postgres advisory lock serialises concurrent runners, so four API replicas
 * booting at once cannot race each other through the same file. The lock is
 * transaction-scoped (`pg_advisory_xact_lock`) rather than session-scoped: on
 * Neon's pooled endpoint a session lock would be taken on one backend and the
 * next statement would run on another, so it would appear to be held while
 * guarding nothing. A transaction lock is released by the COMMIT that records
 * the migration, which is exactly the span that needs protecting — and it is
 * correct on either endpoint. Because the lock no longer spans the whole run,
 * each file is re-checked against schema_migrations after the lock is acquired,
 * so a runner that waited behind another does not apply the same file twice.
 *
 * Migrations still want the direct endpoint (see cli/migrate.ts); this is
 * defence against the day someone points them at the pooler anyway.
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

/** Runs `fn` in a transaction holding the migration lock, and commits it. */
async function underLock<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
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
    // Under the lock as well: two runners issuing CREATE TABLE IF NOT EXISTS
    // at the same instant can still collide on the catalog.
    await underLock(client, async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name       text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
    });

    for (const file of files) {
      let wasApplied: boolean;
      try {
        wasApplied = await underLock(client, async () => {
          // Re-read inside the lock: another runner may have applied this file
          // while this one was queued behind it.
          const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [
            file,
          ]);
          if (done.rowCount) return false;

          const sql = await readFile(join(dir, file), 'utf8');
          log(`applying ${file}`);
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          return true;
        });
      } catch (error) {
        throw new Error(
          `migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      (wasApplied ? applied : alreadyApplied).push(file);
    }
  } finally {
    client.release();
  }

  return { applied, alreadyApplied };
}
