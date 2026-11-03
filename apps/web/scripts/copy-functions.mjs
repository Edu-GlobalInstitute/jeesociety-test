import { cp, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copies `functions/` into the export directory after `next build`.
 *
 * Cloudflare Pages looks for Functions inside the build output directory, which
 * for this project is `apps/web/out`. `next build` empties that directory on
 * every run, so the Function cannot simply live there — it is kept in
 * `apps/web/functions` (where it is editable and reviewable) and copied in as
 * the last build step.
 *
 * Written as a Node script rather than `cp -r` in the npm script because the
 * build runs on Windows locally and on Linux in Cloudflare's builder, and `cp`
 * is not a command on the former.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'functions');
const destination = join(here, '..', 'out', 'functions');

try {
  await readdir(source);
} catch {
  // No Functions to ship. Not an error: the static export is still valid, and
  // failing the build here would be worse than deploying without a proxy.
  console.log('no functions/ directory — nothing to copy');
  process.exit(0);
}

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

const copied = await readdir(destination, { recursive: true });
console.log(`copied ${copied.length} entries into out/functions`);
