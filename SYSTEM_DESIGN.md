# JEE Test Portal — System Design

Maintained alongside the code. Every commit that changes behaviour updates this
file in the same commit.

---

## 1. System overview

An all-India online JEE test portal for a single test event. Up to 10,000
students sit simultaneously for 3 hours and answer 75 questions: 60 MCQ, scored
by comparison against a server-held key, and 15 subjective, graded by an LLM
against a per-question rubric. Students register and pay beforehand, enter a
lobby 30 minutes before the start, take the test, and receive objective results
the next day and final ranks within 6 days.

### Load profile

| Phase | Load | Notes |
| --- | --- | --- |
| Lobby (30 min before start) | ~10 req/s | Registration + environment checks, spread across 30 minutes |
| Paper download | 0 req/s at origin | ~1.5 MB x 10,000 served by Cloudflare CDN from R2, not by the API |
| Start instant | ~500 req/s peak | `GET /attempt/key` — a ~200 byte response |
| Steady (3 hours) | ~110 req/s | 10,000 students / 90 s sync interval, minus the 30-40% skipped by the no-change check |
| Submit | ~500 req/s peak | Jittered across 45 s, so in practice closer to 220/s |
| Grading (days after) | ~0 req/s | Worker polls Postgres; no inbound traffic |

Total event traffic is roughly 1.2M sync requests and ~12 GB of ingress. **This
is a small system.** It is not hard to scale; it is hard to make safe. Every
decision below optimises for correctness and recoverability over throughput.

### Hard constraints

1. **No student's work may be lost.** A crash at minute 170 costs at most 90
   seconds of work.
2. **The answer key never reaches the client.** Not in the bundle, not in an API
   response, not in a source map.
3. **Nothing auto-penalises a student.** Cheating signals produce flags for human
   review. The system never auto-zeroes, auto-terminates or auto-deducts.
4. **Everything is resumable.** Any process can be killed at any point without
   data loss or duplicated work. State lives in Postgres, never in process memory.
5. **The test event cannot be retried.** The boring, proven option wins everywhere.

---

## 2. Decision log

Entries are append-only and numbered. Where a reasonable alternative existed, it
is named along with why it lost.

### D-001: TypeScript monorepo with pnpm workspaces

**Decision:** One repository, four apps (`exam`, `web`, `api`, `worker`), two
packages (`shared`, `db`), two tools (`build-paper`, `loadtest`).
**Alternatives considered:** Separate repositories per service; a single
non-workspace package.
**Why:** The sync payload contract is the most critical interface in the system.
With `packages/shared` imported by both the client and the API, a mismatch is a
compile error rather than a silent failure during the event. Separate repos put
that contract behind a version number, which is exactly the wrong failure mode
for a one-shot event.
**Cost accepted:** All services deploy from one repo, so a deploy must name its
service explicitly.
**Revisit if:** A second test product needs independent release cadence.

### D-002: Vite + React static SPA for the exam client, not Next.js

**Decision:** `apps/exam` is a static build, served entirely from the CDN.
**Alternatives considered:** Next.js with SSR, same as the public site.
**Why:** 10,000 students load the exam app inside a 30-minute lobby window. A
static bundle is a CDN object; SSR would make each of those loads an origin
request for no benefit, because the app is authenticated and personalised only
after it boots. SSR buys nothing here and adds an origin dependency at the worst
possible moment.
**Cost accepted:** No SEO on the exam app (it needs none) and two frontend
toolchains in the repo.
**Revisit if:** The exam app ever needs to be indexed or to render per-student
content before hydration.

### D-003: Next.js for the public site, deployed to Cloudflare Pages

**Decision:** `apps/web` is Next.js, hosted on Cloudflare Pages.
**Alternatives considered:** Same static SPA as the exam client; Vercel hosting.
**Why:** The landing, registration and results pages benefit from SEO and
server rendering, and their traffic is low. Vercel's free tier forbids
commercial use, and this portal charges students, so Cloudflare Pages it is —
which also keeps the whole static edge on one provider alongside R2.
**Cost accepted:** Cloudflare's Next.js adapter supports a subset of Next
features; the site stays on static and edge-rendered routes.
**Revisit if:** The public site needs Node-only Next.js features.

### D-004: Express 5 for the API, not Fastify

**Decision:** `apps/api` is Express 5 + TypeScript.
**Alternatives considered:** Fastify.
**Why:** Express 5 handles async errors natively, which removes the single
biggest historical reason to avoid it. Peak load is ~500 req/s on a ~200 byte
response — far below the point where framework benchmarks matter. The operator
is far stronger in Express, and on an event that cannot be retried, the ability
to debug the stack at 2am beats a throughput margin that will never be reached.
**Cost accepted:** Marginally lower requests/second ceiling, irrelevant at this
scale.
**Revisit if:** Steady load exceeds ~5,000 req/s.

### D-005: Plain Node worker with no HTTP framework

**Decision:** `apps/worker` is a Node process that polls Postgres and exposes no
HTTP server.
**Alternatives considered:** An HTTP service with trigger endpoints; in-process
jobs inside the API.
**Why:** Nothing sends the worker requests — it claims work from the database.
An HTTP surface would be an attack surface and an availability requirement for
no gain. Keeping grading out of the API process also means a grading backlog can
never slow down a student's sync.
**Cost accepted:** Admin-triggered jobs go through a database flag rather than a
direct call, adding up to one poll interval of latency.
**Revisit if:** Operators need sub-second job triggering.

### D-006: Postgres on Railway in the same project, not Neon

**Decision:** Managed Postgres in the same Railway project and region as the API.
**Alternatives considered:** Neon serverless Postgres.
**Why:** Same-project private networking gives ~1 ms query latency and free
internal egress, and the sync endpoint runs 1.2M times. Neon's scale-to-zero is
worth nothing here because the database is continuously busy for the whole event
and then continuously busy for six days of grading.
**Cost accepted:** No branching workflow; idle RAM is billed between events.
**Revisit if:** The portal becomes multi-event with long idle periods.

### D-007: Full state on every sync, not diffs

**Decision:** Each sync sends the complete answer state.
**Alternatives considered:** Incremental diffs/patches.
**Why:** A dropped patch silently corrupts server state permanently and is
undetectable until results. Full state makes each sync self-contained; the server
self-heals on the next one.
**Cost accepted:** ~12 GB ingress per event (<$1) vs ~200 MB.
**Revisit if:** Payload exceeds ~50 KB per student.

### D-008: Postgres queue via `FOR UPDATE SKIP LOCKED`, not Redis

**Decision:** `grading_jobs` is the queue; lanes claim rows with `FOR UPDATE SKIP
LOCKED` and a `locked_until` lease.
**Alternatives considered:** Redis + BullMQ.
**Why:** 15,000 jobs over six days does not justify a second datastore with its
own failure modes, backup story and connection budget. The decisive property is
transactional: a job's state and its result commit together, so a crash between
"grade succeeded" and "job marked done" is impossible rather than merely
unlikely.
**Cost accepted:** Polling costs one cheap indexed query per lane per idle
second; throughput ceiling is far above what the LLM provider will allow anyway.
**Revisit if:** Job volume exceeds ~1M per event.

### D-009: Cloudflare R2 + CDN for the paper blob, not S3

**Decision:** The encrypted paper lives in R2 behind the Cloudflare CDN.
**Alternatives considered:** S3 + CloudFront; serving the paper from the API.
**Why:** The paper is byte-identical for all 10,000 students, so it is a cache
object, not a server response. R2 egress is free; S3 would bill for roughly 15 GB
per event. Serving it from the API would turn the start instant into a 15 GB
origin spike on the one service that must stay responsive.
**Cost accepted:** A second cloud provider in the stack, used for two things
(paper blob and backups).
**Revisit if:** Egress ever becomes cheaper at the primary host than at R2.

### D-010: Railway Singapore for all three services, not Fly.io Mumbai

**Decision:** `api`, `worker` and `postgres` all run in Railway's Singapore
region.
**Alternatives considered:** Fly.io, which has a Mumbai region physically closer
to the students.
**Why:** The latency-sensitive payload is the question paper, and that is served
from Cloudflare's Indian edge regardless of where the origin sits. What remains
is a ~10 KB sync every 90 seconds, where an extra 40 ms of RTT is invisible.
Operator familiarity with Railway is worth more than that margin on an event
that cannot be retried. All three services share a region so private networking
holds — a mismatched region silently costs latency on every query.
**Cost accepted:** ~40 ms additional RTT per API call for Indian students; data
residency outside India (see Open questions).
**Revisit if:** The event grows an interactive, latency-sensitive feature, or
data residency becomes a legal requirement.

### D-011: Scoring, flag computation and the wire contract live in `packages/shared`

**Decision:** `scoreMcq`, `scoreRubric` and the flag functions are pure
functions in the shared package, not methods on a service class or SQL.
**Alternatives considered:** Scoring in SQL; scoring inside the worker only.
**Why:** These four paths — sync, submit, auto-submit, scoring — carry
correctness for the whole event, and pure functions are the only version of them
that can be tested exhaustively without a test event. Keeping them in `shared`
also means a disputed score can be recomputed from stored observations by any
process, including a one-off script six months later.
**Cost accepted:** Scoring reads all answers into the worker process rather than
staying in the database. At 10,000 x 75 answers this is seconds of work.
**Revisit if:** Scoring ever needs to run over more rows than fit comfortably in
memory.

<!-- Decision entries are appended here as the code that implements them lands. -->

---

### D-012: Explicit numbered SQL migrations, no ORM auto-sync

**Decision:** `packages/db/migrations/NNN_name.sql`, applied in filename order,
each in its own transaction, recorded in `schema_migrations`, serialised by a
Postgres advisory lock.
**Alternatives considered:** Prisma/Drizzle schema push; an ORM's auto-sync.
**Why:** The schema is the most consequential artefact in the system, and a
reviewer must be able to read exactly what will run. Auto-sync produces a
schema nobody reviewed and a migration nobody can roll back. The advisory lock
matters because four API replicas boot simultaneously on deploy.
**Cost accepted:** Writing SQL by hand; no generated types from the schema.
**Revisit if:** The schema starts changing weekly.

### D-013: One row per attempt, answers as a single JSONB column

**Decision:** `attempts.answers` is one JSONB object, overwritten on every sync.
**Alternatives considered:** One row per answer (`attempt_answers`).
**Why:** 75 rows per student is 750,000 rows, and a submit would become a
multi-row write on the hottest path of the event. A single column makes sync one
UPDATE and submit one UPDATE. The history that would have justified per-answer
rows is served instead by `sync_snapshots`, which stores lengths only.
**Cost accepted:** No per-answer timestamps; a whole-row rewrite per sync
(~10 KB, trivial at this volume).
**Revisit if:** Per-answer audit timestamps become a requirement.

### D-014: `revision` as the concurrency guard, not row locks or timestamps

**Decision:** Every write carries `WHERE revision < $new`; a non-matching write
is a no-op reported as success.
**Alternatives considered:** `SELECT ... FOR UPDATE` around a read-modify-write;
last-write-wins on `updated_at`.
**Why:** The client is the only thing that knows the true order of its own
edits, so a client-supplied monotonic counter is the correct ordering. Server
timestamps would reorder a delayed packet ahead of a newer one. Row locks would
serialise the hottest path in the system for no benefit, since there is nothing
to merge — each sync carries full state. A student with two tabs open, or on a
network that reorders packets, converges on the highest revision.
**Cost accepted:** The client must persist its revision counter alongside its
answers, or a reload could re-use a revision and have its first sync ignored.
**Revisit if:** Answers ever stop being full-state.

### D-015: A stale sync is 200, not 409

**Decision:** A sync whose revision the server has already passed returns
`{ ok: true, revision, stale: true }` with status 200.
**Alternatives considered:** 409 Conflict.
**Why:** Out-of-order delivery is normal on the networks these students are on;
it is not an error and the client has nothing useful to do about it. A 4xx would
be read by every HTTP client, retry wrapper and monitoring dashboard as failure,
producing a retry storm at exactly the moment the network is worst. The response
carries the server's revision so a genuinely confused client can resynchronise.
**Cost accepted:** "Success" covers two outcomes, so the `stale` flag exists to
tell them apart in logs.
**Revisit if:** Clients ever need to block on a conflict.

### D-016: Submit finalises even when the client's revision is behind

**Decision:** If a submit arrives carrying a revision older than the server's,
the server keeps its own newer answers and still marks the attempt submitted.
**Alternatives considered:** Rejecting the submit; overwriting with the client's
payload.
**Why:** Both alternatives harm the student. Rejecting leaves the attempt open
and relying on auto-submit when the student believes they have submitted;
overwriting discards answers a second tab already synced. Keeping the newer
state and closing the attempt is the only option that loses nothing.
**Cost accepted:** The receipt may not correspond to the exact bytes the
submitting tab held — it corresponds to the best state the server has.
**Revisit if:** Students ever need per-device attempts.

### D-017: One-shot jobs are rows in `job_runs`, not timers

**Decision:** Auto-submit, MCQ scoring, enqueue-grading and flag computation are
scheduled by inserting a row with a `run_after`, claimed with `FOR UPDATE SKIP
LOCKED` and a `locked_until` lease.
**Alternatives considered:** `setTimeout` in the worker; an external cron.
**Why:** A timer in process memory dies with the process, and the single most
important job in the system (auto-submit) runs exactly once, ten minutes after
the window closes — precisely when a deploy or a crash would be most costly. As
a row, a restarted worker simply finds the job still due and runs it. UNIQUE
(job, test_id) means a double trigger cannot produce two runs.
**Cost accepted:** Up to one poll interval (5 s) of scheduling latency.
**Revisit if:** Sub-second job triggering is ever needed.

### D-018: Sync snapshots carry the originating IP

**Decision:** `sync_snapshots` has an `ip inet` column in addition to the
lengths.
**Alternatives considered:** A separate `attempt_ips` table; computing the
IP-change flag inline during sync.
**Why:** The IP-change signal needs history, not just the latest address.
Carrying it on the snapshot row costs nothing because that insert already
happens on every sync, whereas a separate table would add a second write to the
hot path and computing it inline would add a read.
**Cost accepted:** One more personal-data column; covered by the retention note
in section 9.
**Revisit if:** The IP signal is dropped as too weak to be worth storing.

### D-019: Sync is permitted for a `registered` attempt, not only `in_progress`

**Decision:** The sync guard accepts `registered` and `in_progress`, and
promotes `registered` to `in_progress` on first write.
**Alternatives considered:** Rejecting any sync before the key is issued, with a
dedicated echo endpoint for the lobby check.
**Why:** The lobby must verify that a real sync round-trip works while there is
still time to fix a problem, and a check that exercises a different code path
than the real thing is not a check. There is no exposure: the paper is encrypted
and the key is not released until `starts_at`, so a student who syncs early can
only store an empty answer set.
**Cost accepted:** `in_progress` means "has written something", which is very
slightly weaker than "has been handed the key". `key_issued_at` remains the
precise signal and is what the reconciliation report counts.
**Revisit if:** The lobby check is ever removed.

## 3. File map

| Path | Responsibility | Notes |
| --- | --- | --- |
| `packages/shared/src/config.ts` | Every tunable constant in the system | `AWARD_CAP`, MCQ marks, timings, flag thresholds. Nothing here may be set from a request body or a prompt. |
| `packages/shared/src/types.ts` | Domain types: attempts, paper, telemetry, rubric | `AnswerKey` is typed here but only ever held server-side. |
| `packages/shared/src/contract.ts` | The wire contract — zod schemas for sync/submit/status/key | Imported by both the exam client and the API. A mismatch is a compile error. |
| `packages/shared/src/scoring.ts` | `scoreMcq`, `scoreRubric`, `totalScore` | Pure. The `AWARD_CAP` is applied here in code, never asked of the model. |
| `packages/shared/src/flags.ts` | Keystroke ratio, burst appearance, IP change | Pure. Returns evidence only; never a score or a penalty. |
| `packages/shared/src/receipt.ts` | Receipt format and parser | `JEE-<testId>-<YYYYMMDD>-<6 digits>`; auto form generated in SQL. |

| `packages/shared/src/paper-crypto.ts` | AES-256-GCM over the paper JSON | WebCrypto, so the Node builder and the browser client run the same code. |
| `packages/db/migrations/001_auth.sql` | Better Auth tables + `admins` | Written out explicitly; verify against `@better-auth/cli generate` after upgrades. |
| `packages/db/migrations/002_core.sql` | `tests`, `payments`, `attempts`, `sync_snapshots`, `grading_jobs` | The event schema. `tests.paper_key` and `tests.answer_key` are the two secret columns. |
| `packages/db/migrations/003_ops.sql` | `job_runs`, `admin_audit` | One-shot job bookkeeping and the append-only override trail. |
| `packages/db/src/pool.ts` | Pool construction and `withTransaction` | `PG_POOL_MAX` x replicas must stay under the connection limit. |
| `packages/db/src/migrate.ts` | Migration runner | Advisory-locked, so concurrent replica boots do not race. |
| `packages/db/src/query.ts` | `rows`/`one`/`count` and `pick` | `pick` is the response whitelist used by every handler. |
| `packages/db/src/queries/tests.ts` | Test reads, with explicit column lists | The only two functions that read key material live here and are named to stand out. |
| `packages/db/src/queries/attempts.ts` | **Sync and submit.** The hot path | `syncAttempt` runs 1.2M times/event; the `revision <` guard is here. |
| `packages/db/src/queries/jobs.ts` | **Auto-submit** and job claiming | `autoSubmitAll` is the core safety net. Tested first. |
| `packages/db/src/queries/grading.ts` | Grading queue: enqueue, claim, complete, roll up | `claimNextGradingJob` is the `SKIP LOCKED` claim. |
| `packages/db/src/queries/payments.ts` | Orders, webhook idempotency, stuck-payment scan | `markPaid` is safe to run on every Razorpay retry. |
| `packages/db/src/queries/admin.ts` | Review queue, audit log, live stats | `liveStats.staleOver4Minutes` is the during-test health number. |
| `packages/db/src/testing.ts` | Per-file test database + fixtures | Real Postgres, because the behaviour under test is `revision <` and `SKIP LOCKED`. |
| `packages/db/src/samplePaper.ts` | Deterministic 75-question dev paper | Not the real paper; feeds the seed and the load test. |
<!-- Appended as files land. -->

---

## 4. Data flow walkthroughs

### The sync loop

1. The client writes every change to IndexedDB (debounced 300 ms) and bumps a
   local `revision`.
2. Every 90 s a timer fires. If `revision` has not advanced since the last
   successful sync, the request is **skipped entirely** — this drops 30-40% of
   traffic from students who are reading or working on paper.
3. Otherwise the client POSTs `/attempt/sync` with full state: every answer,
   every telemetry counter, and the current revision.
4. The API validates with the shared zod schema, confirms the attempt belongs to
   this user, and rejects the request if `now > tests.ends_at`.
5. One guarded UPDATE: `SET answers = $1, ... WHERE id = $5 AND revision < $3
   AND submitted_at IS NULL`. Zero rows matched means the request was stale or
   the attempt is already finalised.
6. A `sync_snapshots` row records **lengths only**, `ON CONFLICT DO NOTHING`.
7. The response is always 200: `{ ok, revision, stale, serverTime }`.

Worst case loss: 90 seconds, bounded by step 2's interval.

### Submit and auto-submit

The submit button is a convenience. Auto-submit is the mechanism.

1. At the timer's zero, or on a manual click, the client picks a random delay in
   `[0, 45s)` and shows `SUBMITTING`. The jitter is what flattens a 10,000-client
   spike into roughly 220 req/s.
2. `POST /attempt/submit` writes one row: answers, `submitted_at`, status,
   receipt. It computes no score and calls no model.
3. `WHERE submitted_at IS NULL` makes it idempotent. A second request — a
   double-click, a retry, a racing auto-submit — reads back the same receipt and
   returns 200.
4. If every retry fails, the client shows "Your answers are saved. We're
   completing your submission." This is *true*: the last sync is on the server.
5. Ten minutes after `ends_at`, the worker claims the `auto_submit` job and runs
   one UPDATE over every attempt still `in_progress` with `submitted_at IS NULL`,
   finalising each from its last synced answers.
6. A reconciliation report follows: registered, started, manually submitted,
   auto-submitted, never-started, zero-answer, stale-at-close. An unusually high
   auto-submit count means sync was failing, and that must be visible on the day
   rather than six days later.

<!-- Appended as flows land. -->

---

## 5. Failure modes

| What fails | System response | Data loss |
| --- | --- | --- |
| Student loses connection mid-test | The client keeps writing to IndexedDB and keeps retrying the sync; the indicator quietly notes the last-saved time. On reconnect the next sync carries full state, so nothing needs replaying. | None beyond the last 90 s, and nothing at all if the connection returns before the window closes. |
| Browser crashes / power cut | On reload the client restores answers from IndexedDB, re-reads `revision`, and continues. | At most the 300 ms IndexedDB debounce. |
| Laptop dies and never returns | Auto-submit finalises the attempt from the last synced answers 10 minutes after `ends_at`. | At most 90 s. |
| Submit fails repeatedly | Client retries 1/2/4/8/16 s, then shows "Your answers are saved. We're completing your submission." Auto-submit finalises the attempt. | None. |
| Two tabs open | Both sync full state; the `revision <` guard means the higher revision wins and neither corrupts the other. | None. |
| Out-of-order sync packets | The stale one matches no rows and returns 200 with the server's revision. | None. |

<!-- Appended as the handling lands. -->

---

## 6. Operational runbook

<!-- Appended as deployment lands. -->

---

## 7. Open questions

<!-- Assumptions that need a human decision are recorded here rather than
### Q-001: Data residency for minors' data

The database is in Singapore (D-010), not India. Most students sitting this test
will be under 18. The DPDP Act does not currently require local storage, but
it does require verifiable parental consent for processing a minor's data, and
cross-border transfer rules are subject to government notification of restricted
countries. **Assumption made:** Singapore is acceptable for this event.
**Needs a human decision before the event:** whether registration must collect
parental consent explicitly, and whether a future event should move the database
to an Indian region.

### Q-002: Session lifetime vs. test duration

Sessions are configured to outlast the test window comfortably (see
`apps/api/src/auth.ts`). **Assumption made:** 12 hours, which covers a 3-hour
test plus a lobby plus a student who logged in the previous evening. **Needs a
human decision:** whether a student should be able to stay logged in across the
results window too, or be forced to re-authenticate to view results.

     silently chosen. -->
