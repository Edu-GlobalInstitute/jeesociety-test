# Railway deployment

Two services in **one project**, both in the **Singapore** region. Postgres is
not here: it is a Neon branch in `ap-southeast-1`, the same metro — see
[neon.md](neon.md) and SYSTEM_DESIGN.md D-006. Keep both services in Singapore;
a service in another region pays the latency on every query, and `api` makes
several per request, 1.2M times.

## Services

| Service | Root | Build | Start |
| --- | --- | --- | --- |
| `api` | repo root | `pnpm install --frozen-lockfile && pnpm -r --filter @jee/shared --filter @jee/db --filter @jee/api build` | `node apps/api/dist/server.js` |
| `worker` | repo root | same, with `@jee/worker` | `node apps/worker/dist/worker.js` |

The old managed `postgres` service stays in the project, **stopped, not
deleted**, until the event is over: it is the fallback if the Neon rehearsals
listed in [neon.md](neon.md) do not happen in time.

### Sizing

| Service | Test day | Scoring | Afterwards |
| --- | --- | --- | --- |
| `api` | 4 replicas, 2 vCPU / 2 GB | 1 replica | 1 replica, smallest |
| `worker` | 1 replica | 1 replica | **0 replicas** |

Neon's compute is sized in its own console; autosuspend must be **off** for the
event and back **on** afterwards ([neon.md](neon.md)).

Scoring no longer needs extra workers. The whole paper is objective, so
`mcq_score` is one streaming pass of in-code comparisons over the cohort — about
a second of CPU, bounded by row reads and writes — rather than days of queued
model calls. One worker finishes it in minutes.

**Scale down the day after the test.** The dominant infrastructure cost is idle
RAM held across the month, not test-day compute, and this is the step everyone
forgets — it silently repeats the bill every month until someone notices.

### Connections

The `replicas x PG_POOL_MAX < max_connections` budget retired with the move to
Neon: its pooler multiplexes every replica onto the compute. `PG_POOL_MAX` is a
throughput knob now, not a fuse, and the API still logs it at boot. After any
replica-count change, read Neon's connection graph under load once rather than
doing the arithmetic.

## Health checks

- `GET /health` — liveness. Returns without touching the database.
- `GET /ready` — readiness. Runs `SELECT 1`; an API that cannot reach Postgres
  is not ready to take a student's sync.

Set the Railway healthcheck path to `/ready` and the timeout above 10 s.

## Environment

Set from `.env.example`. These differ per service:

| Variable | api | worker |
| --- | --- | --- |
| `DATABASE_URL` | Neon **pooled** (`-pooler`) | Neon **pooled** |
| `DATABASE_URL_UNPOOLED` | Neon direct | Neon direct — the worker refuses to boot without it when backups are on |
| `PG_POOL_MAX` | 15 | 5 |
| `WORKER_JOBS` | — | `autosubmit,flags,payments,backup` |
| `SERVE_LOCAL_PAPERS` | `false` (refuses to boot otherwise in production) | — |

There is no model API key to set on either service.

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

It must also be **no older than Neon's server** (Postgres 17): `pg_dump`
refuses to dump a newer server, which is a clean error that still means no
backups for the whole event.

`nixpacks.toml` at the repo root handles both:

```toml
# nixpacks.toml
[phases.setup]
nixPkgs = ['nodejs_20', 'postgresql_17']
```

Verify after deploy: the worker's boot log should carry
`"msg":"backups enabled"` with a `pg_dump` version of 17 or newer. The version
is checked at boot, so an old client reports `BACKUPS DISABLED` rather than
failing silently every 15 minutes.
