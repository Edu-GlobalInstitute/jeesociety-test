# Railway deployment

Three services in **one project**, all in the **Singapore** region. A service in
a different region loses private networking and pays the latency on every query
— and `api` makes several per request, 1.2M times.

## Services

| Service | Root | Build | Start |
| --- | --- | --- | --- |
| `api` | repo root | `pnpm install --frozen-lockfile && pnpm -r --filter @jee/shared --filter @jee/db --filter @jee/api build` | `node apps/api/dist/server.js` |
| `worker` | repo root | same, with `@jee/worker` | `node apps/worker/dist/worker.js` |
| `postgres` | — | managed | — |

### Sizing

| Service | Test day | Grading days | After grading |
| --- | --- | --- | --- |
| `api` | 4 replicas, 2 vCPU / 2 GB | 1 replica | 1 replica, smallest |
| `worker` | 1 replica | 2-3 replicas | **0 replicas** |
| `postgres` | 2 vCPU / 4 GB | 1 vCPU / 2 GB | smallest |

**Scale down once grading finishes.** The dominant infrastructure cost is idle
RAM held across the month, not test-day compute, and this is the step everyone
forgets — it silently repeats the bill every month until someone notices.

### Connection pool arithmetic

```
replicas x PG_POOL_MAX  <  max_connections (default 100)
```

Test day: `4 x 15 = 60` for the API, `+5` for the worker, leaving ~35 for
`psql`, backups and the platform. **Recompute this whenever the replica count
changes.** Exceeding it does not degrade — it produces connection refusals in
the middle of the event. The API logs its pool size at boot; read that line
after every deploy.

## Health checks

- `GET /health` — liveness. Returns without touching the database.
- `GET /ready` — readiness. Runs `SELECT 1`; an API that cannot reach Postgres
  is not ready to take a student's sync.

Set the Railway healthcheck path to `/ready` and the timeout above 10 s.

## Environment

Set from `.env.example`. These differ per service:

| Variable | api | worker |
| --- | --- | --- |
| `PG_POOL_MAX` | 15 | 5 |
| `WORKER_JOBS` | — | `autosubmit,flags,payments,grading,backup` |
| `SERVE_LOCAL_PAPERS` | `false` (refuses to boot otherwise in production) | — |
| `GRADING_CONCURRENCY` | — | start at 10, raise after watching for 429s |

`CORS_ORIGINS` must list the exam client and public site origins exactly. The
API refuses to boot in production without it.

## Deploys and rollback

Railway sends `SIGTERM` on every deploy. Both services handle it: the API stops
accepting connections and drains for up to 15 s; the worker stops claiming jobs
and lets in-flight ones finish, and anything still held is released by its lease
within five minutes.

**Do not deploy during the test window.** If you must, deploy `worker` only —
the API draining mid-event costs students their in-flight syncs, which is
survivable but pointless.

Rollback is Railway's "Redeploy" on the previous deployment. Migrations are
forward-only: a rollback that needs a schema change needs a new migration, not
an undo.

## The worker image needs `pg_dump`

The backup job shells out to `pg_dump`, which is **not** in a stock Node image.
Without it the worker starts, logs `BACKUPS DISABLED — pg_dump is unavailable`
at error level, and takes no backups — which is the kind of thing discovered on
the one day someone needs to restore.

Add a `nixpacks.toml` at the repo root, or set the Railway build to install it:

```toml
# nixpacks.toml
[phases.setup]
nixPkgs = ['nodejs_20', 'postgresql_16']
```

Verify after deploy: the worker's boot log should carry
`"msg":"backups enabled"` with a `pg_dump` version string.
