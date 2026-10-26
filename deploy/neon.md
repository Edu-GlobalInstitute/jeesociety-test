# Neon Postgres

The database for the event. One Neon project, region **`ap-southeast-1`
(Singapore)** — the same metro as the Railway services, which is what keeps the
query hop to single-digit milliseconds. A Neon project in another region
silently costs latency on every query, and there are several per request.

See SYSTEM_DESIGN.md **D-006** for why this is Neon and what it cost to move.

## The two connection strings

Neon gives you two URLs for the same database. The difference is not cosmetic
and getting it wrong fails quietly:

| Variable | Host | Used by |
| --- | --- | --- |
| `DATABASE_URL` | `ep-xxx-pooler.ap-southeast-1.aws.neon.tech` (**with** `-pooler`) | `api`, `worker` — every query at request time |
| `DATABASE_URL_UNPOOLED` | `ep-xxx.ap-southeast-1.aws.neon.tech` (**without**) | `pnpm migrate`, the worker's `pg_dump` backup |

The pooled host is PgBouncer in **transaction mode**: each transaction may land
on a different backend. Plain parameterised queries do not care, and that is
all the hot path runs. Anything that needs one session's state to survive
across statements does care — session advisory locks, `pg_dump`,
`CREATE DATABASE` — and must use the direct host.

Set **both** in production. The code derives the direct host by dropping
`-pooler` when only `DATABASE_URL` is set, but nothing important should rest on
that guess.

Keep `sslmode=require` in both. TLS certificate verification is on, and the
services refuse to boot with `PGSSL_NO_VERIFY=true` in production: the hop is
now the public internet, where unverified TLS authenticates nobody.

## Branch and compute settings for the event

- **Autosuspend: off.** Neon's default suspends an idle compute, and the first
  connection afterwards pays the wake-up. At 10,000 students arriving in one
  minute that is a self-inflicted outage. Turn it back on after scoring — it is
  most of the saving once the event is over.
- **Compute size:** size it for the event before the load test and leave it
  there through scoring. Scale-to-zero is worth nothing here: the database is
  busy for three hours and then busy for six days.
- **PITR retention:** must cover the whole event plus the days after it. This is
  the main durability win over the old setup; check it rather than assuming it.
- **Branching** is how to run the load test at 2x and the dry run against the
  real schema. Create a branch, point a staging deploy at it, delete it after.
  Never load-test the branch the event will use.

## Migrations

```bash
DATABASE_URL=...            # pooled, or just set both
DATABASE_URL_UNPOOLED=...   # direct
pnpm migrate
```

`pnpm migrate` prints the host it used — read that line. It connects on the
direct endpoint; the runner also takes a transaction-scoped advisory lock and
re-checks `schema_migrations` under it, so concurrent replica boots are safe
either way. Migrations are forward-only.

## Backups

The worker's `pg_dump` job stays, even though Neon's PITR is better at the same
job. It writes a gzipped dump to R2 every 15 minutes: a copy at a different
vendor, restorable with `psql` alone. PITR covers losing data; this covers
losing access to the Neon account.

Two things make it silently do nothing:

- `pg_dump` missing from the image — `nixpacks.toml` installs `postgresql_17`.
- `pg_dump` **older** than Neon's server. It refuses to dump a newer server, so
  a Postgres 16 client against Neon's 17 means no backups at all.

Both are checked at worker boot. The log line to look for is
`"msg":"backups enabled"` with a version of 17 or newer; the failure is
`BACKUPS DISABLED` at error level.

`DATABASE_URL_UNPOOLED` must be set for the worker in production or it refuses
to boot with backups enabled — `pg_dump` through PgBouncer does not work.

## Connections

The old `replicas x PG_POOL_MAX < max_connections` budget is gone: PgBouncer
multiplexes every replica's connections onto the compute. `PG_POOL_MAX` is now
a throughput knob (api 15, worker 5) and is still logged at boot.

That removes the cliff, not the need to look. After any replica-count change,
read Neon's connection graph under load once.

## Local development

Unchanged — docker, no Neon account needed:

```bash
pnpm db:up          # Postgres 17 on :5433
pnpm migrate
pnpm seed
```

`.env.example` points both URLs at the local instance. The test suites create
and drop databases, so they refuse to run against a `neon.tech` host unless
`TEST_DATABASE_URL` is set deliberately.

The local image moved from Postgres 16 to 17 to match Neon. An existing volume
from the 16 image will not start under it:

```bash
docker compose down -v && pnpm db:up && pnpm migrate && pnpm seed
```

## Before the event

The move to Neon happened four weeks out, so the rehearsals that were run
against Railway Postgres no longer prove anything:

- [ ] Load test at 2x against a Neon **branch**, p99 on `POST /attempt/sync`
      compared against the recorded Railway baseline.
- [ ] Full dry run against Neon.
- [ ] Restore rehearsed from an R2 dump, and a PITR restore tried once in the
      console so nobody is learning it during an incident.
- [ ] Autosuspend off, compute sized, PITR retention confirmed.
- [ ] Freeze no later than one week out.

The Railway Postgres service stays stopped rather than deleted until the event
is over: it is the fallback if those rehearsals do not happen in time.
