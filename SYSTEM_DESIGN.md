# JEE Test Portal — System Design

Maintained alongside the code. Every commit that changes behaviour updates this
file in the same commit.

---

## 1. System overview

An all-India online JEE test portal for a single test event. Up to 10,000
students sit simultaneously for 3 hours and answer 75 questions for 300 marks,
on the JEE Main pattern: physics, chemistry and mathematics, each with 20
single-correct questions and 5 integer-answer ones. Every question is scored by
comparison against a server-held key. Students register and pay beforehand,
enter a lobby 30 minutes before the start, take the test, and receive marks the
next day and final ranks the same week.

Until 2026-10-26 a third of the paper was subjective, graded by an LLM against
per-question rubrics. That half of the product is gone — see **D-038**, which
is the entry to read before trying to understand why several decisions below
are marked superseded.

### Load profile

| Phase | Load | Notes |
| --- | --- | --- |
| Lobby (30 min before start) | ~10 req/s | Registration + environment checks, spread across 30 minutes |
| Paper download | 0 req/s at origin | ~1.5 MB x 10,000 served by Cloudflare CDN from R2, not by the API |
| Start instant | ~500 req/s peak | `GET /attempt/key` — a ~200 byte response |
| Steady (3 hours) | ~110 req/s | 10,000 students / 90 s sync interval, minus the large share skipped by the no-change check |
| Submit | ~500 req/s peak | Jittered across 45 s, so in practice closer to 220/s |
| Scoring (the next morning) | ~0 req/s | One worker pass over the cohort; no inbound traffic |

Total event traffic is roughly 1.2M sync requests. Ingress is now a fraction of
the ~12 GB this document used to quote: a full answer map is 75 option keys and
short numbers rather than 15 paragraphs of prose, so a sync body is on the order
of 1 KB instead of ~10 KB. The request *count* is unchanged, and it was always
the count rather than the body size that decided whether the event holds. **This
is a small system.** It is not hard to scale; it is hard to make safe. Every
decision below optimises for correctness and recoverability over throughput.

### Hard constraints

1. **No student's work may be lost.** A crash at minute 170 costs at most 90
   seconds of work.
2. **The answer key never reaches the client.** Not in the bundle, not in an API
   response, not in a source map.
3. **Nothing auto-penalises a student.** Cheating signals produce flags for human
   review. The system never auto-zeroes, auto-terminates or auto-deducts. On an
   all-objective paper this constraint costs almost nothing to keep, because
   there is almost nothing left to signal on (D-038).
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
no gain. Keeping the post-test jobs out of the API process also means that
scoring 10,000 attempts can never slow down a student's sync.
**Cost accepted:** Admin-triggered jobs go through a database flag rather than a
direct call, adding up to one poll interval of latency.
**Revisit if:** Operators need sub-second job triggering.

### D-006: Postgres on Neon, not Railway

**Decision:** Managed Postgres on Neon (`ap-southeast-1`), reached over TLS from
the `api` and `worker` services in Railway's Singapore region. Routine traffic
uses the pooled endpoint; migrations and `pg_dump` use the direct one.
**Alternatives considered:** Railway's managed Postgres in the same project and
region, which is what this ran on until 2026-10-26.
**Why:** The three operational chores Railway leaves with us are this system's
most fragile surfaces, and Neon deletes all three: the
`replicas x PG_POOL_MAX < max_connections` budget (PgBouncer multiplexes onto
the compute instead, so a replica-count change no longer risks connection
refusals mid-event), instance sizing and the scale-down after the event, and the
durability gap that the homegrown `pg_dump` job exists to cover — Neon's PITR
restores to any second in the retention window rather than to the last
15-minute dump. Branching also makes the load test and the dry run runnable
against a copy of the real schema and data volume.
**Cost accepted:** The query hop is no longer ~1 ms of private networking but a
TLS'd internet hop inside the same metro — single-digit milliseconds, paid
1.2M times by the sync endpoint. Session-scoped state no longer works on the
default endpoint, which is a real footgun: `migrate.ts` now takes a
transaction-scoped advisory lock and re-checks `schema_migrations` under it,
and `pg_dump` is pointed at the direct endpoint explicitly. Two connection
strings must be configured instead of one, and getting them the wrong way round
fails quietly rather than loudly.
**Reversal, 2026-10-26, four weeks before the event.** This entry argued on
2026-10-23 that Neon likely wins on merit and lost only on runway: a migration
landing three weeks out trades two known chores for an unrehearsed datastore.
That reasoning was not wrong and the risk it names is now the live risk. It was
overruled deliberately, so the mitigation is scheduling, not argument: **the
load test at 2x and the full dry run must both be re-run against Neon, and the
restore rehearsal repeated, before the stack is frozen.** A load test against
the old stack now proves nothing. The thing to watch in it is p99 on
`POST /attempt/sync`, compared against the Railway numbers already recorded —
if the extra hop shows up anywhere it shows up there. Freeze no later than one
week out; if those rehearsals have not happened by then, the honest call is to
go back to Railway Postgres, which is why the old service is kept (stopped, not
deleted) until the event is over.
**Revisit if:** p99 on sync regresses measurably against the recorded Railway
baseline, or the dry run finds anything the pooled endpoint cannot carry.

### D-007: Full state on every sync, not diffs

**Decision:** Each sync sends the complete answer state.
**Alternatives considered:** Incremental diffs/patches.
**Why:** A dropped patch silently corrupts server state permanently and is
undetectable until results. Full state makes each sync self-contained; the server
self-heals on the next one.
**Cost accepted:** ~12 GB ingress per event (<$1) vs ~200 MB.
**Revisit if:** Payload exceeds ~50 KB per student.

### D-008: Postgres queue via `FOR UPDATE SKIP LOCKED`, not Redis

**Decision:** Postgres is the queue; claimants take rows with `FOR UPDATE SKIP
LOCKED` and a `locked_until` lease.
**Alternatives considered:** Redis + BullMQ.
**Why:** The job volume does not justify a second datastore with its own failure
modes, backup story and connection budget. The decisive property is
transactional: a job's state and its result commit together, so a crash between
"work succeeded" and "job marked done" is impossible rather than merely
unlikely.
**Amended, 2026-10-26 (D-038).** This entry was written for `grading_jobs`,
which held 15,000 model calls over six days and is dropped by migration 004.
The pattern it describes still runs the system — `job_runs` is claimed exactly
this way — and the transactional argument is the reason the one-shot jobs were
never timers (D-017).
**Cost accepted:** Polling costs one cheap indexed query per claimant per idle
second.
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

### D-010: Railway Singapore for the services, not Fly.io Mumbai

**Decision:** `api` and `worker` run in Railway's Singapore region; Postgres is
a Neon branch in `ap-southeast-1`, the same metro (D-006).
**Alternatives considered:** Fly.io, which has a Mumbai region physically closer
to the students.
**Why:** The latency-sensitive payload is the question paper, and that is served
from Cloudflare's Indian edge regardless of where the origin sits. What remains
is a ~10 KB sync every 90 seconds, where an extra 40 ms of RTT is invisible.
Operator familiarity with Railway is worth more than that margin on an event
that cannot be retried. The services and the Neon branch share a metro, which is
what keeps the database hop to single-digit milliseconds — a Neon region that
does not match the Railway one silently costs latency on every query, and there
are several queries per request.
**Cost accepted:** ~40 ms additional RTT per API call for Indian students; data
residency outside India (see Open questions).
**Revisit if:** The event grows an interactive, latency-sensitive feature, or
data residency becomes a legal requirement.

### D-011: Scoring, flag computation and the wire contract live in `packages/shared`

**Decision:** `scoreMcq`, `answerMatches` and the flag functions are pure
functions in the shared package, not methods on a service class or SQL.
**Alternatives considered:** Scoring in SQL; scoring inside the worker only.
**Why:** These four paths — sync, submit, auto-submit, scoring — carry
correctness for the whole event, and pure functions are the only version of them
that can be tested exhaustively without a test event. Keeping them in `shared`
also means a disputed score can be recomputed from the stored answers and key by
any process, including a one-off script six months later.
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

**Decision:** Auto-submit, scoring and flag computation are scheduled by
inserting a row with a `run_after`, claimed with `FOR UPDATE SKIP LOCKED` and a
`locked_until` lease.
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

### D-020: In-memory rate limiting, not Postgres-backed

**Decision:** A fixed-window counter in process memory, per replica.
**Alternatives considered:** A Postgres-backed limiter; Redis.
**Why:** A counter write on `/attempt/sync` would add 1.2M writes to the hottest
path of the event to defend against a problem that does not exist at this scale.
Redis is a second datastore for a counter (see D-008). The cost of keeping it in
memory is that the limit is per replica, so at 4 replicas a user can reach ~4x
the configured rate — which is fine, because the job is to stop a runaway client
from looping, not to meter anyone precisely.
**Cost accepted:** Imprecise limits; counters reset on deploy.
**Revisit if:** Abuse appears that an approximate limit does not stop.

### D-021: Trust proxy is a hop count, never `true`

**Decision:** `app.set('trust proxy', TRUST_PROXY_HOPS)` with a small integer.
**Alternatives considered:** `trust proxy: true`.
**Why:** `true` makes Express believe the left-most `X-Forwarded-For` entry,
which any client can set. That would let one client appear as thousands of
addresses — defeating the rate limiter — and would poison the IP-change signal
with addresses the student never used. A hop count reads the address the
*proxy* appended, which a client cannot forge.
**Cost accepted:** The number must be updated if the number of proxies changes.
**Revisit if:** The deployment gains or loses a proxy layer.

### D-022: Submit is accepted for 5 minutes after `ends_at`

**Decision:** `/attempt/submit` accepts requests until `ends_at + 5 minutes`;
`/attempt/sync` stops exactly at `ends_at`.
**Alternatives considered:** A hard cutoff at `ends_at` for both.
**Why:** The client deliberately spreads submission across 45 seconds of jitter
and then retries with backoff for a further ~31 seconds. A hard cutoff at
`ends_at` would reject precisely the submissions the jitter exists to spread out,
and would do so for the unluckiest students. The grace is comfortably inside the
10-minute auto-submit delay, so nothing can slip between the two.
**Cost accepted:** A student can submit up to 5 minutes late — but they cannot
*change* anything in that window, because sync is already closed.
**Revisit if:** The jitter window changes.

### D-023: Claude Haiku 5.5 for grading, over Gemini Flash-Lite

**Decision:** `claude-haiku-5-5` via the official Anthropic SDK, behind a
`GradingProvider` interface.
**Alternatives considered:** Gemini Flash-Lite (the other candidate); a
frontier-tier model.
**Why:** The task is reading one short answer against an explicit rubric with
worked examples and reporting nine observations — it is bounded and well
specified, not reasoning-heavy, so a frontier model would be paying for headroom
the task cannot use. Haiku-tier at ~150,000 calls is roughly $32. The provider
interface means switching is a new class, not a rewrite, and a `stub` provider
lets the whole lane be tested without spending money.
**Cost accepted:** A provider dependency; a second implementation needed if the
choice is revisited.
**Superseded, 2026-10-26 by D-038.** There is no grading model. The provider interface, both
implementations and the `@anthropic-ai/sdk` dependency are deleted; an
invariant test now fails if any of them comes back. The reasoning above still
holds for the task it described, and is kept because it is the argument to
re-read if a written paper is ever reintroduced.
**Revisit if:** A written section returns to the product.

### D-024: Determinism comes from a structured-output schema, not `temperature: 0`

**Decision:** The grading call passes a JSON Schema in
`output_config.format` and sends no sampling parameters.
**Alternatives considered:** `temperature: 0` with JSON requested in the prompt,
as originally specified.
**Why:** **This is a deliberate deviation from the brief, forced by the API.**
As of 2026-10-21 the Messages API returns a 400 for `temperature`, `top_p` or
`top_k` on every model, so the originally specified `temperature: 0` would make
every grading call fail. The goal behind it — a stable, parseable reply — is met
better by a schema the API enforces server-side: the reply is schema-valid by
construction rather than by instruction. The reply is validated again on our
side with the same zod schema, so the scorer's types are guaranteed.
**Cost accepted:** Sampling is no longer pinned, so two runs over the same
answer may differ in wording; the observations are booleans and an enum, which
is what the score is computed from.
**Superseded, 2026-10-26 by D-038.** Kept for one reason worth carrying forward: the API rejects
sampling parameters, so any future model call cannot obtain determinism that
way. Reach for a server-enforced schema instead.
**Revisit if:** A written section returns to the product.

### D-025: Never ask the model for a score

**Decision:** The prompt requests nine observations. `scoreRubric()` computes
the mark from them, and `AWARD_CAP` is applied in code.
**Alternatives considered:** Asking the model for a 0-3 mark directly.
**Why:** Models are poorly calibrated on absolute numbers and drift across
150,000 calls, so a model-supplied mark would be inconsistent in a way that is
invisible until students compare results. Observations are individually
checkable by a human reviewer, which also makes a contested score explainable.
Enforcing the cap in code is the only way to guarantee it holds on every single
call; a prompt instruction holds *most* of the time, which over 150,000 answers
is not good enough.
**Cost accepted:** The rubric must be expressible as four binary marks.
**Superseded, 2026-10-26 by D-038.** The principle outlived the model. Nothing outside
`tests.answer_key` may decide a mark, and `scoreMcq()` iterating that key is
now the single place a mark is computed — see D-038. The invariant test that
used to check there was no path from a flag to a score also checks that
`scoring.ts` mentions no second source of marks.
**Revisit if:** A written section returns to the product.

### D-026: Grading jobs are enqueued question-major

**Decision:** `enqueueGradingJobs` inserts `ORDER BY question_id, attempt_id`.
**Alternatives considered:** The natural attempt-major order.
**Why:** The rubric is a cached prompt prefix, identical for all 10,000 answers
to one question. Lanes claim in `id` order, so attempt-major insertion would
make consecutive jobs cycle through all 15 rubrics and miss the cache on almost
every call. Question-major insertion keeps every lane on the same cached prefix
at the same time.
**Cost accepted:** Results arrive question by question rather than student by
student, so partial results are not per-student complete until the end.
**Superseded, 2026-10-26 by D-038.** `grading_jobs` is dropped by migration 004. Scoring needs no
queue: it is one streaming pass of in-code comparisons, and re-running it is
free because it is deterministic.
**Revisit if:** A written section returns to the product.

### D-027: The SDK's own retries are disabled

**Decision:** `maxRetries: 0` on the Anthropic client; the lane owns retries.
**Alternatives considered:** Leaving the SDK default of 2.
**Why:** Retry state belongs on the job row, where `attempts_made` is visible to
the admin view and survives a worker restart. SDK-level retries would multiply
the real attempt count invisibly — three lane attempts would become nine model
calls — and would hide a failing provider behind an apparently healthy queue.
**Cost accepted:** Backoff is implemented here rather than inherited.
**Superseded, 2026-10-26 by D-038.** There is no SDK. The principle — retry state belongs on the job
row where it is visible and survives a restart — still governs `job_runs`.
**Revisit if:** A written section returns to the product.

### D-028: Local state wins over server state on resume

**Decision:** On start, the client loads its IndexedDB state if present and uses
it. It only adopts the server's copy when this device has none.
**Alternatives considered:** Always adopting the server's state; merging the two.
**Why:** The local copy is always at least as fresh as the server's — it is
written on a 300 ms debounce and the server is 90 seconds behind by design.
Adopting the server's copy on every load would throw away up to 90 seconds of
work on a simple refresh. Merging has no safe rule: with full-state syncs there
is no way to tell a deletion from a stale omission. The server copy is for the
case it was built for — a student on a replacement machine.
**Cost accepted:** A student who works on two machines sees whichever one they
last used locally; the `revision` guard still prevents corruption.
**Revisit if:** Multi-device sessions become a supported workflow.

### D-029: No webfonts in the exam client

**Decision:** System font stacks only. Serif (Charter/Georgia) for question
text, system UI sans for chrome.
**Alternatives considered:** Google Fonts; self-hosted woff2.
**Why:** 10,000 students load this app inside a 30-minute window, many on poor
connections. A webfont that fails or stalls produces invisible or re-flowing
question text at the worst possible moment, and `font-display: swap` only
narrows the window rather than closing it. Nothing about the typography is worth
that risk, so the design takes its character from structure and colour instead.
**Cost accepted:** Less typographic distinctiveness; rendering differs slightly
across platforms.
**Revisit if:** Fonts can be inlined into the bundle at a trivial size cost.

### D-030: No red in the exam interface

**Decision:** The palette contains no red. Amber is the strongest signal, used
for the last ten minutes and for the "still saving" state.
**Alternatives considered:** Conventional red for the timer's final minutes and
for sync failures.
**Why:** These students are already under as much pressure as they will ever be
under, and a red interface adds to it for no informational gain — the student
already knows time is short. The brief's rule that nothing may imply their work
is at risk extends to colour, not just copy.
**Cost accepted:** Slightly lower urgency signalling, which is the point.
**Revisit if:** Testing shows students miss the end of the window.

### D-031: Status in the navigator is encoded by shape, not colour alone

**Decision:** Answered is a filled cell, seen-but-blank is a dot, marked for
review is a folded corner.
**Alternatives considered:** Colour-only status, as most exam interfaces use.
**Why:** Roughly 1 in 12 male students has a colour vision deficiency, and at
10,000 candidates that is hundreds of people reading the one control that tells
them what they have left to do. Shape costs nothing and works in grayscale, on
a bad projector and on a washed-out screen.
**Cost accepted:** A slightly busier grid.
**Revisit if:** Never.

### D-032: The admin surface lives in the Next.js site, not a separate app

**Decision:** `/admin`, `/admin/review` and `/admin/review/attempt` are routes in
`apps/web`, behind the same `requireAdmin` check on every API call.
**Alternatives considered:** A fourth app; an admin SPA alongside the exam
client.
**Why:** Admin traffic is a handful of people, so it has no scaling story to
speak of and no reason to be a separate deployment. Authorisation lives on the
API — it is checked against the `admins` table on every request, not carried in
a session claim — so the page is a client of the same protected endpoints and
adds no new trust boundary.
**Cost accepted:** The public site's bundle carries admin routes; they are
static shells with no privileged data in them.
**Revisit if:** The admin surface grows enough to want its own release cadence.

### D-033: Admin authorisation is checked per request, not carried in the session

**Decision:** `requireAdmin` queries the `admins` table on every admin request.
**Alternatives considered:** An `isAdmin` claim written into the session cookie
at sign-in.
**Why:** Sessions last 12 hours so that none expires mid-test (D-002's sibling
constraint). A claim in the cookie would mean revoking someone's admin access
takes up to 12 hours to have any effect — during a window where overrides change
students' results. One indexed primary-key lookup per admin request is nothing;
there are a handful of admins.
**Cost accepted:** One extra query per admin request.
**Revisit if:** Never, at this scale.

### D-034: The review chart is one series, with the flagged segment labelled

**Decision:** The review chart plots progress against sync revision as a single
line, drawing the segment that exceeds the jump threshold in a second colour
**and** stating the threshold in text beneath it.
**Alternatives considered:** Colour-only highlighting; a bar chart of deltas.
**Why:** The question the reviewer is answering is a shape question, and a chart
of deltas would show a jump but lose the shape that makes the rest of the
attempt look normal. The text label exists because status may never be carried
by colour alone, and this chart is read by someone deciding whether an attempt
stands.
**Amended, 2026-10-26 (D-038).** The series changed and the geometry did not.
It plotted *answer length for one question*, which read whether prose was
written or pasted; with one-character answers that series is flat and
meaningless. It now plots *how many of the 75 answers the server held* at each
sync, which still answers "did someone actually sit this paper" — a student
working through a paper produces a staircase over three hours. The y-axis is the
whole paper rather than the data's own maximum, so two attempts can be compared
by glancing at their shapes. `GrowthChart` is now `ProgressChart`, and its
geometry tests carried over unchanged.
**Cost accepted:** Two colours on a one-series chart, which needs the text to
disambiguate. The new series is weaker evidence than the old one, because
transcribing 70 answers from paper in the last ten minutes is a thing an honest
student does.
**Revisit if:** Reviewers ask for several attempts on one chart — which would
make it categorical and need a validated palette per series.

### D-035: The public site is a night that becomes a morning

**Decision:** `apps/web` is built on the Penultimate JEE Program's Sunrise
palette — deep navy base, warm orange and golden yellow accents, soft cream for
breathing space, teal used sparingly — and the landing page is sequenced as a
sunrise: a navy hero with a star field and a rising sun, sections that brighten
from cream to white-cream, the reward ladder back in the navy so the gold on it
is the brightest thing on the page, and a closing band that is the sunrise
itself with navy type on it.
**Alternatives considered:** The previous all-bright poster treatment; an
all-light page with warm accents.
**Why:** The palette guide's own argument, and it holds: an all-bright page
reads as a sale, not as hope, and the warm accents only mean anything against
something dark. Rationing them is the whole mechanism — gold and orange appear
on the price, the register button, the top percentile band and the sun, and
nowhere else, so a student reads those four things as one promise.
The hero carries the argument as a picture as well as a headline: a student
climbs the three-band ladder, stalls below the next rung, and a hand from JEE
Society lifts them from the bottom rung to the top, where the prize is
(`components/RescueLadder.tsx`). It is four stacked SVG layers whose
**layers** are what CSS animates, never their contents, so percentage
translates resolve against the stage and the student's feet land on the rungs
at every width.
**Cost accepted:** Two stylesheets instead of one (`app/globals.css` for the
chrome and the quiet pages, `app/landing.css` imported by the landing page), so
that register, results and admin do not download the poster.
**Revisit if:** The brand palette changes, or a second test product needs a
landing page of its own, at which point the landing styles want to move into a
component rather than a page-level import.

### D-036: The landing page gives away five real questions

**Decision:** Before paying, a visitor can answer five questions from a public
past paper (JEE Main 2024, 27 January, Shift 1) inside the page, marked live
with `MCQ_MARKS` — the same constant the server scores an attempt with — and
told the working either way.
**Alternatives considered:** Sample questions from our own paper; a screenshot
of the exam client; nothing at all.
**Why:** "JEE level" is a claim, and a claim about difficulty is the one thing a
student cannot check from a landing page. A past paper can be shown honestly,
costs nothing, and lets them feel the level in forty seconds. Our own questions
could not be used: the paper is unseen, and its key never leaves the server
(hard constraint 2). Marking the taster from the shared constant means the +4 /
−1 a student sees here cannot drift from what an answer is actually worth.
**Cost accepted:** Two of the five were integer-answer questions originally, so
their options are ours; the page says so rather than implying the options were
in the paper.
**Revisit if:** The reward policy changes what an objective answer is worth, in
which case the taster follows automatically — or a student-facing question bank
exists, at which point the taster can be drawn from it.

### D-037: The inside is gated on `tests.status`, not on a build flag

**Decision:** The public funnel — landing page, email-and-password sign-up,
Razorpay payment — ships and runs on its own, weeks before the paper exists. A
test on sale sits at `tests.status = 'scheduled'`; `/attempt/register`, `/key`
and `/sync` answer 403 `not_open` in that state, `/test/status` carries
`examOpen: false`, and the exam client renders a coming-soon screen instead of a
lobby. One admin action — `POST /admin/test-status` with `{status: 'live'}` —
opens the inside.
**Alternatives considered:** An environment flag on the API; a build-time flag
in the exam client; not deploying the exam client at all until the paper is
ready; a new `tests.exam_open` column.
**Why:** Selling before the product is finished is the normal shape of a
one-shot event — registrations have to accumulate for weeks — so the lock is a
permanent part of the system, not a temporary hack, and it belongs in the place
the rest of the event's lifecycle already lives. `tests.status` exists, already
carries `draft`/`scheduled`/`live`/`closed`/`graded`, is already constrained in
SQL, and until now nothing read it; giving it the meaning its own values imply
is cheaper and clearer than a fourth place to look. The decisive property is
that it is per-test data rather than per-deployment config: flipping it is one
audited UPDATE with no restart, no redeploy and no risk of the exam client and
the API disagreeing about whether the test is open — which an env flag on one
service and a build flag on the other both allow. Not deploying the exam client
at all was rejected because the client is what students will be told to
bookmark, and a dead URL during the weeks they are paying is worse than a page
that tells them when to come back.
**Cost accepted:** `status` now means two things at once — where the event is in
its lifecycle, and whether students can get in. Submit and resume therefore
accept `closed` and `graded` as well as `live` (`hasExamOpened`), because
auto-submit moves the row to `closed` ten minutes after the window shuts and a
student fetching their receipt after that must not be told the test is shut.
The admin route accepts only `scheduled` and `live` for the same reason: letting
an operator hand-write `closed` would shut sync on a live cohort, which is
exactly what hard constraint 1 forbids.
**Revisit if:** A second test is ever on sale while a first is live, at which
point "which test is being sold" and "which test is open" stop being the same
question and the column has to split.

### D-038: An all-objective paper, and no model anywhere

**Decision, 2026-10-26, four weeks before the event.** The paper is 75
machine-marked questions for 300 marks: three subjects, each with 20
single-correct and 5 integer-answer questions, every one marked +4 / −1 / 0
against `tests.answer_key`. The subjective section, the LLM grading pipeline and
everything that existed to serve them are deleted, not disabled.
**Alternatives considered:** Keeping the written section with a smaller
question count; keeping the grading code behind a feature flag.
**Why:** This is a product decision, not an engineering one, and it was taken
above this document. What the engineering judgement adds is that a flag would
have been the wrong way to carry it. Dormant code on a one-shot event is a
liability: the schema keeps columns nothing writes, the worker keeps a loop
nothing runs, the dashboard keeps a panel that always reads zero, and the
operator checklist keeps steps whose purpose no one remembers on the morning.
Deleting it makes the system smaller in the way that matters — the number of
things that can be wrong on the day.

Three consequences are worth stating because they are easy to discover late:

- **Marks are final the morning after**, not spread over days. `mcq_score` is
  one streaming pass of in-code comparisons over the cohort, so the "results
  the next day, ranks within six days" split collapses into a single step. The
  post-test runbook and the public copy both changed accordingly, and the worker
  no longer needs extra replicas afterwards.
- **Integer answers are compared numerically**, not as strings: `12`, `12.0`,
  `+12` and ` 12 ` are one answer. A student must never lose four marks for the
  formatting their keyboard produced. The same reasoning drives the client
  filtering the field as it is typed rather than rejecting it at submit, and the
  two are tested as a pair — a filter that tidied an answer into something that
  no longer scores would be worse than no filter.
- **There is no per-student score override any more.** Overriding meant
  correcting one model-graded answer. On an objective paper a disputed mark is a
  wrong entry in the answer key, which is the same wrong entry for all 10,000
  students; the fix is to correct the key and re-run `mcq_score`, which is
  idempotent. Fixing it per student would leave 9,999 others wrong, so the
  endpoint is gone rather than repurposed.

**Cost accepted:** The product can no longer test or reward working-out, which
was its differentiator against every other multiple-choice mock — that cost sits
with the product decision, not here. Technically, the real loss is anti-cheat:
the two behavioural signals that carried the review queue read the growth curve
of typed prose, and a one-character answer has no growth curve. They are
deleted, leaving only the IP-change signal, which mobile networks trip
constantly. **The review queue is now a list to glance down, not ranked
evidence, and it will be long and mean little.** Nothing has replaced those
signals because nothing honest can: there is no way to distinguish a student who
chose (C) themselves from one who was told to, and a detector that guessed would
wrongly accuse hundreds of this cohort — which hard constraint 3 forbids in
spirit as well as in code. If invigilation matters more than it did, it has to
come from outside this system.
**Revisit if:** A written section returns to the product, in which case D-023
through D-027 are the arguments to re-read rather than reinvent — they are kept
in place, marked superseded, for exactly that reason.

## 3. File map

| Path | Responsibility | Notes |
| --- | --- | --- |
| `packages/shared/src/config.ts` | Every tunable constant in the system | `PAPER` shape, MCQ marks, timings, flag weights. Nothing here may be set from a request body. |
| `packages/shared/src/types.ts` | Domain types: attempts, paper, questions | `ScqQuestion` / `IntegerQuestion`. `AnswerKey` is typed here but only ever held server-side. |
| `packages/shared/src/contract.ts` | The wire contract — zod schemas for sync/submit/status/key | Imported by both the exam client and the API. A mismatch is a compile error. |
| `packages/shared/src/scoring.ts` | `scoreMcq`, `answerMatches` | Pure, and the only place a mark is computed. Integer answers compare numerically. |
| `packages/shared/src/flags.ts` | IP change, and the lengths recorded per sync | Pure. Returns evidence only; never a score or a penalty (D-038). |
| `packages/shared/src/receipt.ts` | Receipt format and parser | `JEE-<testId>-<YYYYMMDD>-<6 digits>`; auto form generated in SQL. |

| `packages/shared/src/paper-crypto.ts` | AES-256-GCM over the paper JSON | WebCrypto, so the Node builder and the browser client run the same code. |
| `packages/db/migrations/001_auth.sql` | Better Auth tables + `admins` | Written out explicitly; verify against `@better-auth/cli generate` after upgrades. |
| `packages/db/migrations/002_core.sql` | `tests`, `payments`, `attempts`, `sync_snapshots` | The event schema. `tests.paper_key` and `tests.answer_key` are the two secret columns. |
| `packages/db/migrations/004_mcq_only.sql` | Drops `grading_jobs`, `tests.rubrics`, `attempts.subjective_score` and `attempts.telemetry` | The schema half of D-038. Forward-only, so an already-migrated database reaches the new shape without a reset. |
| `packages/db/migrations/003_ops.sql` | `job_runs`, `admin_audit` | One-shot job bookkeeping and the append-only override trail. |
| `packages/db/src/pool.ts` | Pool construction, TLS, `withTransaction`, and the pooled/direct split | `directConnectionString()` is what session-scoped work must call. `PG_POOL_MAX` is a throughput knob now, not a fuse. |
| `packages/db/src/migrate.ts` | Migration runner | Transaction-scoped advisory lock plus a re-check, so it is correct on either Neon endpoint. |
| `packages/db/src/query.ts` | `rows`/`one`/`count` and `pick` | `pick` is the response whitelist used by every handler. |
| `packages/db/src/queries/tests.ts` | Test reads, with explicit column lists | The only two functions that read key material live here and are named to stand out. |
| `packages/db/src/queries/attempts.ts` | **Sync and submit.** The hot path | `syncAttempt` runs 1.2M times/event; the `revision <` guard is here. |
| `packages/db/src/queries/jobs.ts` | **Auto-submit** and job claiming | `autoSubmitAll` is the core safety net. Tested first. |
| `packages/db/src/queries/payments.ts` | Orders, webhook idempotency, stuck-payment scan | `markPaid` is safe to run on every Razorpay retry. |
| `packages/db/src/queries/admin.ts` | Review queue, audit log, live stats | `liveStats.staleOver4Minutes` is the during-test health number. No score override — see D-038. |
| `packages/db/src/testing.ts` | Per-file test database + fixtures | Real Postgres, because the behaviour under test is `revision <` and `SKIP LOCKED`. |
| `packages/db/src/samplePaper.ts` | Deterministic 75-question dev paper | Laid out 20 scq + 5 integer per subject, as the real one is. Feeds the seed and the load test. |
| `apps/api/src/app.ts` | Express app factory; middleware order | The webhook's `express.raw()` and Better Auth both mount *before* `express.json()`. |
| `apps/api/src/server.ts` | Process entry, graceful shutdown | Logs pool size at boot — the only way to notice a bad replica/pool calculation. |
| `apps/api/src/env.ts` | Validated configuration | Refuses to boot in production without CORS origins or a webhook secret. |
| `apps/api/src/auth.ts` | Better Auth setup | 12-hour sessions, so none expires mid-test. |
| `apps/api/src/routes/attempt.ts` | **register / key / sync / submit** | The hot path. Sync runs 1.2M times/event; a stale revision returns 200. `requireExamOpen` gates all five on `tests.status` (D-037). |
| `apps/api/src/routes/status.ts` | `/test/status`, `/test/time` | Drives every client clock. `/time` needs no session so a refresh never jumps the timer. |
| `apps/api/src/routes/payments.ts` | Razorpay order + webhook | Raw-body HMAC, timing-safe, idempotent on `razorpay_payment_id`. |
| `apps/api/src/routes/admin.ts` | Dashboard, review queue, job triggers, the go-live switch | `test-status` and every job trigger write `admin_audit` before responding. |
| `apps/api/src/middleware/rateLimit.ts` | In-memory fixed-window limiter | Per replica by design (D-020). |
| `apps/api/src/lib/razorpay.ts` | REST client + signature verification | `verifyWebhookSignature` compares in constant time. |
| `apps/worker/src/worker.ts` | Worker entry; loop selection via `WORKER_JOBS` | No HTTP server. SIGTERM stops claiming; in-flight jobs finish. |
| `apps/worker/src/scheduler.ts` | Claims `job_runs` and dispatches | Auto-submit is scheduled on boot, not at the end of the test. |
| `apps/worker/src/jobs/autoSubmit.ts` | **Finalises unsubmitted attempts** | The core safety net. Tested first. Emits the reconciliation report. |
| `apps/worker/src/jobs/mcqScore.ts` | **The whole of scoring**, in one pass | Reads the answer key; batched and deterministic, so a crashed pass simply re-runs. Marks are final when it finishes. |
| `apps/worker/src/jobs/computeFlags.ts` | The one remaining signal: IP change | Writes flags only. No path from here to a score. Expect it to flag a large share of the cohort (D-038). |
| `apps/worker/src/jobs/paymentReconcile.ts` | Recovers captured payments with no webhook | Runs every 5 minutes before the test. |
| `apps/worker/src/jobs/backup.ts` | `pg_dump` → gzip → R2 | Never takes the worker down on failure. |
| `apps/exam/src/App.tsx` | Session state machine: waiting → lobby → exam → submitted | Handles the start instant: key, decrypt, render. |
| `apps/exam/src/lib/idb.ts` | IndexedDB layer | The student's protection against a refresh. Raw IndexedDB, small enough to read in full. |
| `apps/exam/src/lib/store.ts` | Answer state; the only place `revision` advances | Debounced 300 ms. Persists `revision` so a reload's first sync is not ignored. |
| `apps/exam/src/lib/sync.ts` | Sync decisions, submit backoff, jitter | Skips when `revision` has not moved; a stale response is success. |
| `apps/exam/src/lib/clock.ts` | Server-offset clock | Three samples, fastest round trip wins. Nothing reads `Date.now()` directly. |
| `apps/exam/src/lib/paper.ts` | Download, cache, decrypt | Re-downloads once if the cached blob fails to decrypt. |
| `apps/exam/src/screens/ComingSoon.tsx` | What a paid student sees before the test opens | Shown while `examOpen` is false. Reassures first, then says when to come back (D-037). |
| `apps/exam/src/screens/Lobby.tsx` | Registration + four environment checks | The sync check is a real sync, not a ping. |
| `apps/exam/src/screens/Submitting.tsx` | Submitting / submitted / pending | The most carefully worded file in the app. |
| `apps/exam/src/components/Navigator.tsx` | The OMR sheet | Status by shape as well as colour. |
| `apps/web/app/page.tsx` | The landing page: hero, taster, reward ladder, paper, safety net, steps | Every number on it is read from `@jee/shared/config`; the date from `lib/testDate`. |
| `apps/web/app/landing.css` | Landing-only styles: the sunrise, the bands, the taster | Imported by the page, not by the layout, so the quiet pages stay light. |
| `apps/web/components/RescueLadder.tsx` | The hero's looping picture: climb, stall, a hand up, the prize | Four SVG layers; only the layers are transformed, and one 13s clock keeps them in step. |
| `apps/web/components/TryQuestions.tsx` | Five past-paper questions, marked live | `tally` applies `MCQ_MARKS`; the copy never scolds a low score. Covered by tests. |
| `apps/web/lib/tasterQuestions.ts` | The taster's questions, keys and one-line solutions | Public past paper, never our own. Keys pinned by tests. |
| `apps/web/lib/testDate.ts` | `TEST_STARTS_AT` as words | Parsed by hand, so a static build cannot bake in the build machine's locale. |
| `apps/web/app/register/page.tsx` | Sign up, pay, check in | Polls payment status; the webhook grants access, not the callback. |
| `tools/build-paper/src/cli.ts` | Validate → encrypt → verify round trip → upload → write DB | Refuses to publish if the ciphertext does not decrypt back to the input. |
| `tools/loadtest/sync.js` | k6 at 2× expected load | Payloads are now ~1 KB of option keys and numbers; still models the intervals that skip. |
| `tools/loadtest/seed-students.ts` | Synthetic students with real Better Auth hashes | So the load test signs in through the real auth path. |
| `deploy/railway.md` | Services, sizing, pool arithmetic, deploy rules | Includes the scale-down step everyone forgets. |
| `deploy/cloudflare.md` | R2 bucket layout and Pages projects | The paper object is public by design; the key is the secret. |
| `apps/web/app/admin/page.tsx` | During-test dashboard | Leads with stale-sync share, the number that answers "is sync working". |
| `apps/web/app/admin/review/page.tsx` | The review queue | A list to glance down rather than ranked evidence (D-038). |
| `apps/web/app/admin/review/attempt/page.tsx` | One attempt: flags, the sync trail, the answers | Closing a review will not save without a written reason. |
| `apps/web/components/ProgressChart.tsx` | Answers recorded across syncs | Flagged segment coloured **and** labelled; geometry covered by tests (D-034). |
| `nixpacks.toml` | Railway build | Installs `postgresql_17` for `pg_dump`; without it, or with an older major than Neon's, backups silently never run. |
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

### Registration and payment

1. The student signs up on the public site (`apps/web`), which calls Better
   Auth's `/auth/sign-up/email` on the API.
2. `POST /payments/order` creates a Razorpay order and inserts a `payments` row
   with status `created`.
3. The student pays in Razorpay's checkout. **The callback grants nothing** —
   that path is forgeable and also fails silently whenever a student closes the
   tab on the success screen.
4. Razorpay calls `POST /payments/webhook`. The route verifies an HMAC-SHA256
   over the **raw** bytes with a timing-safe comparison, then marks the payment
   paid. `razorpay_payment_id` is UNIQUE and the update is guarded on status, so
   Razorpay's retries apply nothing and still get a 200.
5. If the webhook never arrives, the reconciliation job finds the row stuck in
   `created` after 15 minutes and asks Razorpay directly.

### Lobby entry and key release

1. The lobby opens 30 minutes before `starts_at`. This window exists to find
   problems while they are still fixable, and to spread 10,000 arrivals across
   half an hour rather than one instant.
2. The client calls `POST /attempt/register`. **This is what admits the
   student**, and it is the only cutoff: after `starts_at` it refuses.
3. Four checks run: IndexedDB writable, localStorage available, a **real sync
   round trip**, and the encrypted paper downloaded from the CDN into
   IndexedDB. The sync check is a real sync against a real attempt, because a
   check that exercises a different code path is not a check.
4. A countdown runs on the server offset, not the machine clock.
5. At `starts_at` the client calls `GET /attempt/key`. The route checks the
   clock, checks the student registered, and reads `tests.paper_key` through the
   one function allowed to touch it — which repeats the `starts_at` guard in
   SQL, so a bug in the route cannot release the key early.
6. The client decrypts the blob it already holds and renders. The origin served
   ~200 bytes; the CDN served the 1.5 MB.

A student who registered but whose key call is slow still gets in. The cutoff is
on registration, never on the key.

### Scoring

One pass after auto-submit, in the worker, never in a request. This is the whole
of grading: when it finishes, the cohort has final totals and a rank list can be
published (D-038).

1. `tests.answer_key` is read server-side through `readAnswerKeyForScoring` —
   one of two deliberately conspicuous functions that touch secret columns. It
   holds an entry for all 75 questions.
2. Attempts are streamed in batches of 500, each batch committing as a unit.
3. `scoreMcq` compares in code: +4 correct, −1 wrong, 0 unattempted, for both
   question types. Blank and whitespace-only answers count as unattempted, never
   wrong.
4. The comparison rule is chosen by the **key**, not by the paper, which is why
   scoring needs no access to the paper at all. A key that parses as a number is
   compared numerically, so `12`, `12.0`, `+12` and ` 12 ` all match — that is
   the integer questions. Anything else is compared trimmed and
   case-insensitively — that is the single-correct questions, where an option
   recorded as `b` and one recorded as `B` are the same click.
5. `attempts.mcq_score` and `total_score` are written, and they are equal.

750,000 comparisons take about a second; the rest is row I/O. The job is
deterministic, so a crashed pass is simply re-run — and so is a pass re-run after
correcting a wrong key, which is how a disputed mark is fixed for the whole
cohort at once.

### Flag and review

1. `compute_flags` runs over every attempt that was issued a key.
2. One signal: IP change, derived from the addresses recorded per revision in
   `sync_snapshots`. The two behavioural signals that used to carry this job read
   the growth curve of typed prose and are gone with the written paper (D-038).
   **Expect this to flag a large share of the cohort** — mobile networks rotate
   addresses constantly — so it is a list to glance down beside submission
   times, not ranked evidence.
3. Flags are merged by `(code, questionId)`, so re-running the job is
   idempotent, and written to `attempts.flags` with `needs_review = true`.
   **No score column is touched by this path, anywhere.**
4. `/admin/review-queue` sorts by severity. `/admin/attempt/:id` shows the flags
   with their evidence, the sync trail, and the answers as submitted.
5. A reviewer closes a review with a mandatory written reason, which writes
   `admin_audit` with their identity before the response goes out. They cannot
   change a mark: there is no per-student override (D-038).

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

| A worker dies mid-job | `locked_until` lapses after 5 minutes and another lane claims the job. `attempts_made` has already been incremented, so a job that kills workers repeatedly is marked `failed` after 3 tries rather than cycling forever. | None. |
| A question's answer key is wrong | Correct `tests.answer_key` and re-run `mcq_score`. It is idempotent and deterministic, so it rescores the whole cohort consistently. There is no per-student override to get out of step with (D-038). | None. |
| A webhook never arrives | The reconciliation job finds `payments` rows stuck in `created` older than 15 minutes and asks Razorpay directly, then marks them paid through the same code path the webhook uses. | None, within one 5-minute cycle. |
| A webhook arrives twice | `razorpay_payment_id` is UNIQUE and `markPaid` guards on status: the second delivery applies nothing and still returns 200, so Razorpay stops retrying. | None. |
| The DB hits its connection limit | Largely retired by Neon's pooler, which multiplexes every replica's connections onto the compute (D-006). What remains is the pooler's own client limit, far above `replicas × PG_POOL_MAX`. The API still logs its pool size at boot, and Neon's connection graph is the thing to read after any replica-count change. | None, if clients reconnect before `ends_at`; otherwise auto-submit covers it. |
| **The Postgres instance or its volume is lost** (F-001) | There is no replica and no automatic failover: this is the system's worst case. Recovery is a restore: with PITR the exposure is seconds, and up to 15 minutes only if the fallback R2 dump is what has to be used, against the 90 s that constraint 1 promises. Two independent mechanisms exist so neither is a single point of failure: Neon's PITR, which restores to any second inside the retention window and makes this far less bad than it was on a single instance with a volume, and the worker's `pg_dump` to R2 every 15 minutes — a copy at a different vendor, which is the one that survives losing access to the Neon account itself. Clients hold their own answers in IndexedDB throughout and keep retrying, so a restore completed before `ends_at` + 10 min loses nothing a sync cannot replace — full-state sync (D-007) means a restored-to-stale server self-heals on the next sync from each client rather than needing a replay. **The restore must be rehearsed before the event, not discovered during it.** | Up to 15 min of server-side state, but near zero in practice for any student whose browser is still open, because the next sync carries full state. |
| The API is down for a period | Clients keep writing to IndexedDB and keep retrying. When it returns, the next sync carries full state — there is no queue of missed deltas to replay, because there are no deltas. | None, provided it returns before `ends_at` + 10 min. |
| The paper CDN object is missing or corrupt | The lobby's fourth check fails *before* the test starts, while there is still time to fix it. GCM is authenticated, so a truncated download fails to decrypt rather than rendering a mangled paper; the client re-downloads once before giving up. | None if caught in the lobby. |
| A student's clock is wrong | Every timer runs on a server offset sampled three times at boot, keeping the fastest round trip, and re-sampled every 5 minutes. The key release is checked against the database clock, so an early request is simply refused. | None. |
| Two students share an account | `UNIQUE (user_id, test_id)` means one attempt. Both tabs sync against the same row and the `revision` guard keeps the highest. The IP-change flag raises it for review. | None, but the attempt is flagged. |

<!-- Appended as the handling lands. -->

---

## 6. Operational runbook

Deployment specifics are in `deploy/railway.md` and `deploy/cloudflare.md`. This
section is the sequence to follow on the day.

### Pre-test checklist

Run through this the **day before**, not on the morning.

**The paper**
- [ ] `build-paper --dry-run` passes: 20 single-correct and 5 integer per
      subject, 75 in all; every question has an answer in the key; every
      single-correct key names one of that question's own options; every
      integer key is a number.
- [ ] `build-paper --upload` run, and the round-trip verification passed.
- [ ] `curl -I` the paper URL twice: 200, and `cf-cache-status: HIT` the second
      time.
- [ ] `select paper_url, paper_key is not null, answer_key is not null from
      tests where id = N;` — all true.
- [ ] **Fetch the paper URL in a private window and confirm it is ciphertext.**
      It should be, and it is worth seeing with your own eyes once.

**The database**
- [ ] Migrations applied: `select name from schema_migrations order by name;`
- [ ] `tests` row has the right `starts_at`, `ends_at`, `lobby_opens_at` —
      in UTC, checked against a second clock.
- [ ] `select count(*) from payments where status = 'paid';` matches the number
      of students you expect.
- [ ] Reconciliation has run recently and recovered nothing outstanding.

**The services**
- [ ] `api` at 4 replicas; boot log shows `poolMax: 15`. Neon's pooler absorbs
      the total, but read its connection graph once under load anyway.
- [ ] Both services have `DATABASE_URL` on the **`-pooler`** host and
      `DATABASE_URL_UNPOOLED` on the direct one. Swapped, nothing fails until
      the first backup or migration.
- [ ] `worker` at 1 replica, `WORKER_JOBS` includes `autosubmit` and `backup`.
- [ ] `GET /ready` returns 200 on every replica.
- [ ] `select * from job_runs where job = 'auto_submit';` exists, `pending`,
      with `run_after` = `ends_at` + 10 minutes.
- [ ] A backup has been written to R2 in the last 15 minutes.
- [ ] Neon **autosuspend is disabled** on this branch and the compute is sized
      for the event, not for the default. A cold start at the moment 10,000
      students connect is a self-inflicted outage.
- [ ] Neon's PITR retention covers the whole event plus the days after it, and
      is enabled independently of the worker's `pg_dump` job.
- [ ] The worker's boot log shows `backups enabled` with a `pg_dump` version of
      **17 or newer**. Older than Neon's server and every dump is refused.
- [ ] **A restore has been rehearsed**: the latest R2 dump loaded into a scratch
      Postgres and verified. An untested backup is not a backup (F-001).
- [ ] Load test run at 2× and its findings fixed.

**The lock (D-037)**
- [ ] `select status from tests where id = N;` is `live`. Until it is, every
      student sees the coming-soon screen and `/attempt/register` answers 403
      `not_open`, however correct the clock and the paper are.
- [ ] Set it from `/admin` → Access → **Go live**, which requires a reason and
      writes `admin_audit`. It refuses if no paper is published.
- [ ] Confirm from a student account: `GET /test/status` returns
      `examOpen: true`, and the exam client shows the waiting room rather than
      the coming-soon screen.

**Dry run**
- [ ] One real account: register, enter the lobby, pass all four checks, start,
      answer, sync, submit, see a receipt.

### During the test

Watch `GET /admin/dashboard`. The number that matters is **`staleOver4Minutes`**
— it answers "is sync working across the whole cohort" with a count rather than
a guess.

| What you see | What it means | What to do |
| --- | --- | --- |
| `staleOver4Minutes` climbing past ~1% of `inProgress` | Sync is failing for part of the cohort | Check API error rate and DB connections **before** touching anything |
| `syncsLastMinute` far below `inProgress`/1.5 | Clients are not syncing at all | Check CORS, check the API is reachable from outside |
| Connection errors in the API log | The pooler's client limit, or a compute that is undersized | Read Neon's connection graph; reduce replicas rather than resizing the compute mid-event |
| `registered` far below paid count | Students cannot get into the lobby | Check payments: run the reconciliation job by hand |

**Do not deploy during the window.** If something must change, change the
worker, not the API.

**Do not restart Postgres.** Every client holds its answers locally and will
re-sync; an API blip costs nothing, but a database restart during the event is
the one thing with no recovery path.

### Post-test sequence

Run these in order, reading the output of each before starting the next.

1. **Wait for auto-submit** (fires 10 minutes after `ends_at`, on its own).
   Read the reconciliation report in the worker log.
   - `autoSubmitted` above ~10% of `started` means sync was failing. Investigate
     before publishing anything.
   - `zeroAnswer` above a handful means the paper did not render for some
     students. Investigate before publishing anything.
2. **Scoring** — `POST /admin/run-job {"job":"mcq_score"}`. This is the whole of
   grading (D-038): it marks all 75 questions and writes final totals, in about
   a second of compute. Deterministic, so it is safe to re-run.
   - Read its summary before going further. `totalUnattempted` far above what
     the cohort plausibly skipped means answers did not reach the server, not
     that 10,000 students left the paper blank.
3. **Spot-check the marking before anyone sees a number.** Take three attempts —
   a high scorer, a middling one and a near-blank — and recompute by hand from
   `attempts.answers` and `tests.answer_key`. In particular check one integer
   answer that was typed with a trailing `.0` or a leading `+`: it must score,
   and this is the one marking rule that is new this event.
4. **Flags** — `POST /admin/run-job {"job":"compute_flags"}`. Expect a large
   share of the cohort to be flagged for an address change; that is the only
   signal left and mobile networks trip it constantly (D-038). It means "worth a
   glance", not "cheated".
5. **Work the review queue** — `/admin/review-queue`. Closing a review needs a
   written reason. No mark can be changed from here; if the queue surfaces a
   question whose key is wrong, fix `tests.answer_key` and go back to step 2,
   which rescores everyone consistently.
6. **Publish marks and ranks** (next morning). Both are ready together now —
   there is no second grading pass to wait for, which is why the public copy
   says "the same week" rather than "within six days".
7. **Scale down.** `worker` to 0, `api` to 1 replica, and the Neon compute back
   to its smallest size with autosuspend re-enabled. Neon bills compute-hours,
   so re-enabling autosuspend is most of the saving; this is the most commonly
   forgotten step and it silently repeats the bill every month.

### Rolling back a deploy

Railway's "Redeploy" on the previous deployment. Migrations are forward-only: a
rollback needing a schema change needs a new migration, not an undo. Never roll
back the API during the test window — draining replicas mid-event costs students
their in-flight syncs for no gain.

### Restoring from backup

Backups are `pg_dump` every 15 minutes, gzipped, in R2 under `backups/`.

```bash
aws s3 cp s3://jee-papers/backups/jee-<timestamp>.sql.gz . --endpoint-url https://<acct>.r2.cloudflarestorage.com
gunzip -c jee-<timestamp>.sql.gz | psql "$DATABASE_URL"
```

Worst case this costs 15 minutes of answers, against "everything" if the
platform's own backups turn out not to be what you assumed.

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

### Q-003: `temperature: 0` is no longer accepted by the Messages API — closed

**Closed 2026-10-26 by D-038: there is no model call to configure.** Kept because
the underlying fact outlives the decision — the Messages API returns a 400 for
`temperature` on every model, so determinism has to come from a server-enforced
schema rather than a sampling parameter. Anyone reintroducing a model call will
hit this on their first request.

### Q-004: Rate limiting is per replica, not per user

The in-memory limiter (D-020) means a user can reach roughly `replicas ×` the
configured rate. **Assumption made:** acceptable, because the limiter exists to
stop a runaway client rather than to meter precisely. **Needs a human
decision:** none unless abuse appears that an approximate limit does not stop.

### Q-005: Which grading model to use — closed

**Closed 2026-10-26 by D-038: the paper is machine-marked and no model is
involved.** The provider interface and its implementations are deleted, and an
invariant test fails if an AI SDK reappears in a manifest or a model call
reappears in the source tree.

### Q-006: Results pages show status, not marks

`apps/web/app/results` reports submission status and explains the schedule, but
does not yet render marks or an all-India rank — ranking needs a published
policy for ties. **This is now the largest open gap in the product**, and it got
more urgent with D-038: marks are final the morning after the test rather than
six days later, so the page has something real to show much sooner, and the
rank list is what the reward bands are defined against.

**Needs a human decision:** the tie-break rule. With a 300-mark objective paper
and 10,000 students, ties at the top are not a corner case — they are
near-certain, and the first three percentile bands carry mentorship seats worth
₹10,000, ₹10,000 and ₹5,000. Decide it before publishing, not after someone contests it. The
usual JEE rules (fewer wrong answers first, then subject-wise, then age) are the
obvious precedent and all of them are computable from what is already stored.

     silently chosen. -->
