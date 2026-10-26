# Cloudflare

Two things live here: the encrypted paper in R2, and the two static frontends on
Pages.

## R2 bucket

```
jee-papers/
└── papers/test-<id>-<sha12>.json    the encrypted paper blob
└── backups/jee-<timestamp>.sql.gz   pg_dump every 15 minutes
```

Published by `tools/build-paper` with `--upload`. The object is **public by
design**: it is AES-256-GCM ciphertext, and the secret is the key, which lives
in `tests.paper_key` and is released by `GET /attempt/key` at `starts_at` and
not one millisecond before.

`Cache-Control: public, max-age=31536000, immutable` is what keeps 10,000
downloads at the edge. The content hash in the filename makes that safe — a
rebuilt paper is a different object, never a stale cached one.

Backups are **not** public. Put them in a separate bucket, or scope the public
custom domain to the `papers/` prefix only.

### Verify before the event

```bash
# Served, cacheable, and the right size.
curl -sI https://cdn.example.org/papers/test-1-<sha>.json | grep -iE 'cache-control|content-length|cf-cache-status'

# Fetch it twice — the second must say HIT.
```

## Pages

| Project | Build | Output |
| --- | --- | --- |
| `jee-web` | `pnpm install && pnpm --filter @jee/web build` | `apps/web/out` |
| `jee-exam` | `pnpm install && pnpm --filter @jee/exam build` | `apps/exam/dist` |

Not Vercel: its free tier forbids commercial use and this portal charges
students (D-003).

Set `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_EXAM_URL` and `VITE_API_URL` to the
production API origin, `VITE_WEB_URL` to the public site's origin (the exam
client links back to it for sign-in and registration), and add both Pages
origins to the API's `CORS_ORIGINS`.

The exam client is a static SPA, so add a redirect so deep links boot the app:

```
/*    /index.html   200
```
