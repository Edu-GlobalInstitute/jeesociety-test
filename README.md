# JEE Test Portal

An all-India online JEE test portal, built for one event: up to 10,000 students
sitting simultaneously for three hours, 75 questions, objective results the next
day and final ranks within six days.

**The design rationale lives in [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md)** — read
that before changing anything. It carries the decision log, the data flows, the
failure modes and the operational runbook.

## The five things that matter

1. **No student's work may be lost.** A crash at minute 170 costs at most 90
   seconds. Answers write to IndexedDB on every change and sync to the server
   every 90 seconds, always as full state.
2. **The answer key never reaches the client.** Not in the bundle, not in an API
   response, not in a source map.
3. **Nothing auto-penalises a student.** Anti-cheat signals produce flags for a
   human. There is no code path from a flag to a score.
4. **Everything is resumable.** Any process can be killed at any point. State
   lives in Postgres, never in process memory.
5. **The test event cannot be retried.** The boring option wins.

Steady load is ~110 req/s, peaking ~500/s. This system is not hard to scale; it
is hard to make safe.

## Layout

```
apps/exam/      Vite + React SPA — the test interface (static, CDN-served)
apps/web/       Next.js — landing, register, pay, results (static export)
apps/api/       Express 5 — sync, submit, auth, payments, admin
apps/worker/    Node loop — auto-submit, MCQ scoring, grading, flags, backups
packages/shared/  Types, the wire contract, scoring, flags, paper crypto
packages/db/      Migrations, query helpers, pool, test harness
tools/build-paper/  Validates, encrypts and publishes the paper
tools/loadtest/     k6 scripts and a synthetic-student seeder
deploy/             Railway and Cloudflare setup
```

## Getting started

Requires Node 20+, pnpm 9 and Docker (for the local database).

```bash
pnpm install
pnpm db:up                 # Postgres on :5433
pnpm migrate
pnpm seed                  # a test starting in 35 minutes, with a sample paper

cp .env.example .env       # then set SERVE_LOCAL_PAPERS=true for local dev

pnpm dev:api               # :3000
pnpm dev:worker
pnpm dev:exam              # :5173
pnpm dev:web               # :3001
```

`pnpm seed -- --starts-in 2 --duration 10` gives you a 10-minute test starting
in two minutes, which is the fastest way to walk the whole flow.

## Tests

```bash
pnpm db:up && pnpm test
```

202 tests. The database-backed suites provision their own throwaway database per
file, so they run in parallel and need only `DATABASE_URL` pointing at a
Postgres they may create databases on.

They concentrate where correctness is load-bearing:

| Area | What is covered |
| --- | --- |
| Sync | Out-of-order revisions, 20-way concurrency, cross-user rejection, window close, snapshots storing lengths only |
| Submit | Idempotency under concurrent retries, a client behind the server, double-click returning one receipt |
| Auto-submit | A cohort finalised in one statement, a re-run as a no-op, a race against a live submit |
| Scoring | JEE marking, the award cap over every combination of observations, review routing |
| Grading | 20 lanes claiming each job exactly once, permanent failure after 3 attempts, cache-friendly ordering |
| Flags | Burst detection from the growth curve, idempotent re-runs, and that no path touches a score |
| Client | Revision monotonicity, IndexedDB round trip, sync skip/stale decisions, clock offset arithmetic |

## A note on the grading model

The model is never asked for a score. It is asked for nine observations, and the
mark is computed from them in code with the cap applied by `Math.min` — because
a prompt instruction holds *most* of the time, which across 150,000 answers is
not good enough. See D-025.
