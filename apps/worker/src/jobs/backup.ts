import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { directConnectionString } from '@jee/db';
import type { Env } from '../env.js';

/**
 * pg_dump every 15 minutes from the start of the lobby until grading completes,
 * gzipped and pushed to R2.
 *
 * Neon's PITR covers the same ground and covers it better — any second inside
 * the retention window, rather than the last 15 minutes. This stays anyway:
 * it is a copy in a different vendor's bucket, restorable with psql alone, and
 * the event cannot be retried. Insurance against losing the database is worth
 * less than insurance against losing access to the account that holds it.
 *
 * It dumps over the DIRECT endpoint. pg_dump takes a repeatable-read snapshot
 * and leans on session state throughout, so through the transaction pooler it
 * fails — or worse, succeeds against a shifting set of backends.
 */

/** Postgres major version Neon serves; pg_dump must be at least this. */
export const REQUIRED_PG_DUMP_MAJOR = 17;

/**
 * `pg_dump` is checked at boot rather than discovered at 02:00 on the day
 * someone needs a restore. Two ways it is wrong: absent from the image, or
 * older than the server — Neon runs Postgres 17, and pg_dump refuses to dump a
 * server newer than itself, which is a clean error that nonetheless means no
 * backups for the whole event.
 */
export function checkPgDumpAvailable(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const probe = spawn('pg_dump', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    probe.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    probe.on('error', () =>
      resolve({
        ok: false,
        detail:
          'pg_dump is not on PATH — install postgresql 17 in the worker image (nixpacks.toml)',
      }),
    );
    probe.on('close', (code) => {
      const detail = out.trim();
      if (code !== 0) {
        resolve({ ok: false, detail: `pg_dump exited ${code}` });
        return;
      }
      const major = Number(/\b(\d+)\./.exec(detail)?.[1] ?? 0);
      if (major && major < REQUIRED_PG_DUMP_MAJOR) {
        resolve({
          ok: false,
          detail:
            `${detail} is older than the Neon server (Postgres ${REQUIRED_PG_DUMP_MAJOR}) ` +
            'and will refuse every dump — install postgresql 17 in the worker image',
        });
        return;
      }
      resolve({ ok: true, detail });
    });
  });
}

export async function runBackup(
  env: Env,
  log: Logger,
): Promise<{ file: string; bytes: number } | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `jee-${stamp}.sql.gz`;
  const dir = env.BACKUP_DIR;
  const path = join(dir, name);

  await mkdir(dir, { recursive: true });

  try {
    await dumpToGzip(
      directConnectionString(env.DATABASE_URL, env.DATABASE_URL_UNPOOLED || undefined),
      path,
    );
    const { size } = await stat(path);

    if (env.R2_BUCKET && env.R2_ACCESS_KEY_ID) {
      await uploadToR2(env, path, `backups/${name}`);
      // Local copy is a staging area only; the container's disk is ephemeral.
      await rm(path, { force: true });
    } else {
      log.warn({ path }, 'R2 not configured — backup kept locally only');
    }

    log.info({ file: name, bytes: size }, 'backup complete');
    return { file: name, bytes: size };
  } catch (error) {
    // A failed backup must never take the worker down: it is insurance, and
    // the grading loop running is more important than the insurance.
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'backup failed',
    );
    return null;
  }
}

function dumpToGzip(databaseUrl: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', ['--no-owner', '--no-acl', databaseUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    dump.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    dump.on('error', reject);

    pipeline(dump.stdout, createGzip(), createWriteStream(destination))
      .then(() => {
        dump.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
        });
      })
      .catch(reject);
  });
}

/**
 * Signed PUT to R2's S3-compatible endpoint. Hand-rolled SigV4 rather than
 * pulling in the AWS SDK for one request on a service that otherwise has no
 * AWS dependency.
 */
async function uploadToR2(env: Env, path: string, key: string): Promise<void> {
  const { createHash, createHmac } = await import('node:crypto');
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${env.R2_BUCKET}/${key}`;

  const body = await streamToBuffer(createReadStream(path));
  const payloadHash = createHash('sha256').update(body).digest('hex');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto';
  const service = 's3';
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const canonicalRequest = [
    'PUT',
    `/${env.R2_BUCKET}/${key}`,
    '',
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
    'host;x-amz-content-sha256;x-amz-date',
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: Buffer | string, data: string) =>
    createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, dateStamp), region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
    body: new Uint8Array(body),
  });

  if (!response.ok) {
    throw new Error(`R2 upload failed: ${response.status} ${await response.text()}`);
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
