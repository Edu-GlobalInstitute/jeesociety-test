import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Env } from '../env.js';

/**
 * pg_dump every 15 minutes from the start of the lobby until grading completes,
 * gzipped and pushed to R2.
 *
 * The platform takes its own backups, but their cadence and retention are not
 * under our control and the event cannot be retried. Worst case with this
 * running is 15 minutes of data; worst case relying on the platform alone is
 * whatever the platform decides.
 */

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
    await dumpToGzip(env.DATABASE_URL, path);
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
