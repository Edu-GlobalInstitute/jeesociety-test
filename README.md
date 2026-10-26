# JEE Test Portal

An all-India online JEE test portal, built for one event: up to 10,000 students
sitting simultaneously for three hours, 75 objective questions for 300 marks,
marks the next day and final ranks the same week.

The paper follows the JEE Main pattern: physics, chemistry and mathematics, each
with 20 single-correct questions and 5 integer-answer ones, every question
marked +4 / −1 / 0. Every mark is a comparison against `tests.answer_key` in
code — there is no model, and no human, anywhere in the scoring path.

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
   lives in Postgres (Neon — see [deploy/neon.md](deploy/neon.md)), never in
   process memory.
5. **The test event cannot be retried.** The boring option wins.

Steady load is ~110 req/s, peaking ~500/s. This system is not hard to scale; it
is hard to make safe.

## Layout

```
apps/exam/      Vite + React SPA — the test interface (static, CDN-served)
apps/web/       Next.js — landing, register, pay, results (static export)
apps/api/       Express 5 — sync, submit, auth, payments, admin
apps/worker/    Node loop — auto-submit, scoring, flags, backups
packages/shared/  Types, the wire contract, scoring, flags, paper crypto
packages/db/      Migrations, query helpers, pool, test harness
tools/build-paper/  Validates, encrypts and publishes the paper
tools/loadtest/     k6 scripts and a synthetic-student seeder
deploy/             Neon, Railway and Cloudflare setup
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

`pnpm seed -- --locked` seeds the test as `scheduled` instead of `live`, which
is how it sits while it is on sale and the paper is not open yet: registration
and payment work, and the exam client shows its coming-soon screen. See
*Selling before the inside is open*, below.

## Selling before the inside is open

The public funnel — landing page, email-and-password sign-up, Razorpay payment —
ships and runs on its own, weeks before the paper exists. What gates the inside
is one column: `tests.status`.

| `tests.status` | Public site | Exam client |
| --- | --- | --- |
| `scheduled` | sells the test, takes payments | coming-soon screen |
| `live` | links to the waiting room | lobby → paper → submit |
| `closed` / `graded` | results | receipt and resume only |

`POST /attempt/register`, `/attempt/key` and `/attempt/sync` answer 403
`not_open` unless the status is `live`, so the lock is on the server and the
coming-soon screen is only its polite face.

**To go live:** sign in as an admin, open `/admin`, and press **Go live** in the
Access panel. It asks for a reason, writes it to `admin_audit`, and refuses if
no paper has been published for the test. The equivalent by hand is
`UPDATE tests SET status = 'live' WHERE id = <id>;` — which skips the audit row
and the paper check, so prefer the button.

## Tests

```bash
pnpm db:up && pnpm test
```

245 tests. The database-backed suites provision their own throwaway database
per file, so they run in parallel and need only `DATABASE_URL` pointing at a
Postgres they may create databases on — the local docker one. They refuse to
run against Neon unless `TEST_DATABASE_URL` says so deliberately, because they
drop what they create.

They concentrate where correctness is load-bearing:

| Area | What is covered |
| --- | --- |
| Sync | Out-of-order revisions, 20-way concurrency, cross-user rejection, window close, snapshots storing lengths only |
| Submit | Idempotency under concurrent retries, a client behind the server, double-click returning one receipt |
| Auto-submit | A cohort finalised in one statement, a re-run as a no-op, a race against a live submit |
| Scoring | JEE marking, numeric comparison for integer answers, a full paper and an untouched one |
| Integer input | That the field's filter never eats an answer that would have scored |
| Flags | The address signal, idempotent re-runs, and that no path touches a score |
| Client | Revision monotonicity, IndexedDB round trip, sync skip/stale decisions, clock offset arithmetic |
| Admin chart | Plot geometry: marks inside the plot, the flagged segment in the flagged colour, the flag also stated in words |
| Invariants | Source-level: no `SELECT *`, secret columns read in one place, no bare `res.json(row)`, no path from a flag to a score, and no AI SDK or model call anywhere |

The invariant tests scan the source tree rather than exercise it, so they hold
for code that has not been written yet. They were verified to fail when a
`SELECT *`, a score-zeroing line and an `openai` reference were deliberately
introduced.

## A note on marking

Every question is machine-marked from `tests.answer_key`, which is read in
exactly one place (`packages/db/src/queries/tests.ts`) by exactly one job
(`mcq_score`), after the window has closed.

Single-correct answers are compared case-insensitively and trimmed, so an option
recorded as `b` by one client and `B` by another is the same choice. Integer
answers are compared **numerically**: `12`, `12.0`, `+12` and ` 12 ` are one
answer. A student is never marked wrong for the formatting their keyboard
produced, which is also why the integer field filters input as they type rather
than rejecting it at submit — see `filterIntegerInput`, tested in pair with
`answerMatches`.

A disputed mark is therefore never about one student: it is a wrong entry in the
answer key. Fix the key and re-run `mcq_score`, which is idempotent and
rescores the whole cohort. There is deliberately no per-student override.
