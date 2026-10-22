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
**Revisit if:** Agreement with human reviewers on the flagged sample is poor.

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
**Revisit if:** Agreement between repeat runs on the same answer is poor —
measure before changing anything.

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
**Revisit if:** A question needs partial credit finer than one mark.

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
**Revisit if:** Grading ever needs to finish one student at a time.

### D-027: The SDK's own retries are disabled

**Decision:** `maxRetries: 0` on the Anthropic client; the lane owns retries.
**Alternatives considered:** Leaving the SDK default of 2.
**Why:** Retry state belongs on the job row, where `attempts_made` is visible to
the admin view and survives a worker restart. SDK-level retries would multiply
the real attempt count invisibly — three lane attempts would become nine model
calls — and would hide a failing provider behind an apparently healthy queue.
**Cost accepted:** Backoff is implemented here rather than inherited.
**Revisit if:** Never, while job state lives in Postgres.

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

### D-034: The growth curve is one series, with the flagged segment labelled

**Decision:** The review chart plots answer length against sync revision as a
single line, drawing the segment that exceeds the burst threshold in a second
colour **and** stating the threshold in text beneath it.
**Alternatives considered:** Colour-only highlighting; a bar chart of deltas.
**Why:** The question the reviewer is answering is "was this written or
pasted", and that is a shape question — gradual growth looks like writing, a
near-vertical segment does not. A chart of deltas would show the jump but lose
the shape that makes the rest of the answer look normal. The text label exists
because status may never be carried by colour alone, and this chart is read by
someone about to change a student's mark.
**Cost accepted:** Two colours on a one-series chart, which needs the text to
disambiguate.
**Revisit if:** Reviewers ask for several questions on one chart — which would
make it categorical and need a validated palette per series.

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
| `apps/api/src/app.ts` | Express app factory; middleware order | The webhook's `express.raw()` and Better Auth both mount *before* `express.json()`. |
| `apps/api/src/server.ts` | Process entry, graceful shutdown | Logs pool size at boot — the only way to notice a bad replica/pool calculation. |
| `apps/api/src/env.ts` | Validated configuration | Refuses to boot in production without CORS origins or a webhook secret. |
| `apps/api/src/auth.ts` | Better Auth setup | 12-hour sessions, so none expires mid-test. |
| `apps/api/src/routes/attempt.ts` | **register / key / sync / submit** | The hot path. Sync runs 1.2M times/event; a stale revision returns 200. |
| `apps/api/src/routes/status.ts` | `/test/status`, `/test/time` | Drives every client clock. `/time` needs no session so a refresh never jumps the timer. |
| `apps/api/src/routes/payments.ts` | Razorpay order + webhook | Raw-body HMAC, timing-safe, idempotent on `razorpay_payment_id`. |
| `apps/api/src/routes/admin.ts` | Dashboard, review queue, overrides, job triggers | Overrides write `admin_audit` before responding. |
| `apps/api/src/middleware/rateLimit.ts` | In-memory fixed-window limiter | Per replica by design (D-020). |
| `apps/api/src/lib/razorpay.ts` | REST client + signature verification | `verifyWebhookSignature` compares in constant time. |
| `apps/worker/src/worker.ts` | Worker entry; loop selection via `WORKER_JOBS` | No HTTP server. SIGTERM stops claiming; in-flight jobs finish. |
| `apps/worker/src/scheduler.ts` | Claims `job_runs` and dispatches | Auto-submit is scheduled on boot, not at the end of the test. |
| `apps/worker/src/jobs/autoSubmit.ts` | **Finalises unsubmitted attempts** | The core safety net. Tested first. Emits the reconciliation report. |
| `apps/worker/src/jobs/mcqScore.ts` | One-pass objective scoring | Reads the answer key; batched and deterministic, so a crashed pass re-runs. |
| `apps/worker/src/jobs/computeFlags.ts` | The three behavioural signals | Writes flags only. No path from here to a score. |
| `apps/worker/src/jobs/paymentReconcile.ts` | Recovers captured payments with no webhook | Runs every 5 minutes before the test. |
| `apps/worker/src/jobs/backup.ts` | `pg_dump` → gzip → R2 | Never takes the worker down on failure. |
| `apps/worker/src/grading/loop.ts` | Concurrent lanes over the Postgres queue | `SKIP LOCKED` + lease. Computes the score from observations. |
| `apps/worker/src/grading/prompt.ts` | Rubric → cached prefix + answer | Asks for observations, never a score. |
| `apps/worker/src/grading/provider.ts` | The model call | Cached rubric prefix, schema-enforced output, 429 → retryable. |
| `apps/exam/src/App.tsx` | Session state machine: waiting → lobby → exam → submitted | Handles the start instant: key, decrypt, render. |
| `apps/exam/src/lib/idb.ts` | IndexedDB layer | The student's protection against a refresh. Raw IndexedDB, small enough to read in full. |
| `apps/exam/src/lib/store.ts` | Answer state; the only place `revision` advances | Debounced 300 ms. Persists `revision` so a reload's first sync is not ignored. |
| `apps/exam/src/lib/sync.ts` | Sync decisions, submit backoff, jitter | Skips when `revision` has not moved; a stale response is success. |
| `apps/exam/src/lib/clock.ts` | Server-offset clock | Three samples, fastest round trip wins. Nothing reads `Date.now()` directly. |
| `apps/exam/src/lib/paper.ts` | Download, cache, decrypt | Re-downloads once if the cached blob fails to decrypt. |
| `apps/exam/src/screens/Lobby.tsx` | Registration + four environment checks | The sync check is a real sync, not a ping. |
| `apps/exam/src/screens/Submitting.tsx` | Submitting / submitted / pending | The most carefully worded file in the app. |
| `apps/exam/src/components/Navigator.tsx` | The OMR sheet | Status by shape as well as colour. |
| `apps/web/app/register/page.tsx` | Sign up, pay, check in | Polls payment status; the webhook grants access, not the callback. |
| `tools/build-paper/src/cli.ts` | Validate → encrypt → verify round trip → upload → write DB | Refuses to publish if the ciphertext does not decrypt back to the input. |
| `tools/loadtest/sync.js` | k6 at 2× expected load | Realistic ~10 KB payloads; models the 33% of intervals that skip. |
| `tools/loadtest/seed-students.ts` | Synthetic students with real Better Auth hashes | So the load test signs in through the real auth path. |
| `deploy/railway.md` | Services, sizing, pool arithmetic, deploy rules | Includes the scale-down step everyone forgets. |
| `deploy/cloudflare.md` | R2 bucket layout and Pages projects | The paper object is public by design; the key is the secret. |
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

### MCQ scoring

Runs as one pass after auto-submit, in the worker, never in a request.

1. `tests.answer_key` is read server-side through `readAnswerKeyForScoring` —
   one of two deliberately conspicuous functions that touch secret columns.
2. Attempts are streamed in batches of 500, each batch committing as a unit.
3. `scoreMcq` compares in code: +4 correct, −1 wrong, 0 unattempted. Blank and
   whitespace-only answers count as unattempted, never wrong. Comparison is
   case-insensitive and trimmed, so a student is not penalised for how their
   client encoded a click.
4. `attempts.mcq_score` and `total_score` are written.

600,000 comparisons take about a second; the rest is row I/O. The job is
deterministic, so a crashed pass is simply re-run.

### Subjective grading

1. An admin triggers `enqueue_grading`, which inserts one `grading_jobs` row per
   subjective answer **ordered question-major**, so that ids group by question
   and the cached rubric prefix actually hits.
2. Lanes claim jobs with `FOR UPDATE SKIP LOCKED` and a 5-minute lease.
3. For each: build a prompt whose cached prefix is the rubric and whose variable
   part is the answer; call the model asking for **nine observations, never a
   score**; validate the reply against the shared schema.
4. `scoreRubric` computes the mark in code and applies `AWARD_CAP` with
   `Math.min`. Both `raw_score` and `score` are stored, so the cap policy can
   change later without re-grading 150,000 answers.
5. `confidence: "low"` or `off_topic_or_blank` raises `needs_review` — it does
   not change the mark.
6. `rollUpScores` sums completed jobs onto the attempt, tolerating a partially
   graded attempt, so results stay current as the queue drains.

### Flag and review

1. `compute_flags` runs over every attempt that was issued a key.
2. Three signals: keystroke ratio (client-reported), burst appearance
   (server-derived from `sync_snapshots`, and the strong one because it depends
   on no client-side JavaScript), and IP change (weak alone).
3. Flags are merged by `(code, questionId)`, so re-running the job is
   idempotent, and written to `attempts.flags` with `needs_review = true`.
   **No score column is touched by this path, anywhere.**
4. `/admin/review-queue` sorts by severity. `/admin/attempt/:id` shows the
   answer, the flags with their evidence, and the growth curve.
5. A reviewer may override a score. The override writes `admin_audit` with the
   admin's identity and a mandatory reason before the response goes out.

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
| The LLM provider rate-limits | The 429 is translated to a retryable error; the lane backs off with jitter (honouring `Retry-After` when present) and the job returns to `pending`. Other lanes hit the same wall and back off in turn, so throughput self-limits. | None; grading takes longer. |
| The LLM returns a malformed reply | Parsing throws, the job retries, and after 3 attempts it is `failed` and listed in `/admin/grading-status`. It is **never** recorded as a zero. | None. |
| A webhook never arrives | The reconciliation job finds `payments` rows stuck in `created` older than 15 minutes and asks Razorpay directly, then marks them paid through the same code path the webhook uses. | None, within one 5-minute cycle. |
| A webhook arrives twice | `razorpay_payment_id` is UNIQUE and `markPaid` guards on status: the second delivery applies nothing and still returns 200, so Razorpay stops retrying. | None. |
| The DB hits its connection limit | New connections are refused; the API returns 500 and clients retry on their own schedule with their work still held locally. **Prevention is the actual answer**: `replicas × PG_POOL_MAX` is checked before every deploy and logged at boot. | None, if clients reconnect before `ends_at`; otherwise auto-submit covers it. |
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
- [ ] `build-paper --dry-run` passes: 60 MCQ, 15 subjective, every subjective
      question has a rubric with at least two worked examples, every MCQ has an
      answer in the key.
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
- [ ] `api` at 4 replicas; boot log shows `poolMax: 15`. 4 × 15 = 60 < 100.
- [ ] `worker` at 1 replica, `WORKER_JOBS` includes `autosubmit` and `backup`.
- [ ] `GET /ready` returns 200 on every replica.
- [ ] `select * from job_runs where job = 'auto_submit';` exists, `pending`,
      with `run_after` = `ends_at` + 10 minutes.
- [ ] A backup has been written to R2 in the last 15 minutes.
- [ ] Load test run at 2× and its findings fixed.

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
| Connection errors in the API log | `replicas × PG_POOL_MAX` exceeded | Reduce replicas rather than raising `max_connections` mid-event |
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
2. **MCQ scoring** — `POST /admin/run-job {"job":"mcq_score"}`. Deterministic,
   so it is safe to re-run.
3. **Flags** — `POST /admin/run-job {"job":"compute_flags"}`. Expect 300-500
   flagged attempts at 10,000 students. An order of magnitude more means a
   threshold is wrong, not that the cohort cheated.
4. **Publish objective results** (next morning).
5. **Enqueue grading** — `POST /admin/run-job {"job":"enqueue_grading"}`. Then
   scale `worker` to 2-3 replicas and watch `/admin/grading-status`.
   - Start `GRADING_CONCURRENCY` at 10. Raise it only after watching for 429s.
6. **Work the review queue** — `/admin/review-queue`, severity order.
7. **Roll up and publish ranks** — `POST /admin/run-job {"job":"finalise_scores"}`.
8. **Scale down.** `worker` to 0, `api` to 1 replica, `postgres` to the smallest
   tier. This is the most commonly forgotten step and it silently repeats the
   bill every month.

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

### Q-003: `temperature: 0` is no longer accepted by the Messages API

The brief specifies `temperature: 0` for grading. As of 2026-10-21 the Messages
API returns a 400 for `temperature` on every model, so following the brief
literally would make every grading call fail. **Assumption made:** the intent
was a stable, parseable reply, so that is obtained instead from a server-enforced
JSON Schema (D-024), validated again on our side. **Needs a human decision:**
whether to measure run-to-run agreement on a sample before grading 150,000
answers — recommended, and cheap.

### Q-004: Rate limiting is per replica, not per user

The in-memory limiter (D-020) means a user can reach roughly `replicas ×` the
configured rate. **Assumption made:** acceptable, because the limiter exists to
stop a runaway client rather than to meter precisely. **Needs a human
decision:** none unless abuse appears that an approximate limit does not stop.

### Q-005: Gemini Flash-Lite was not implemented

The brief offers "Claude Haiku 5.5 **or** Gemini Flash-Lite". Only the Anthropic
provider is implemented (D-023), behind a `GradingProvider` interface with a
`stub` implementation for tests. **Needs a human decision:** whether a second
provider is wanted as a live fallback for the grading window, which would be a
new class implementing one method rather than a change to the lane.

### Q-006: Results pages show status, not marks

`apps/web/app/results` reports submission status and explains the schedule, but
does not yet render marks or an all-India rank — ranking needs a published
policy for ties and for attempts still in review. **Needs a human decision:**
the tie-break rule and whether a flagged attempt's provisional score is shown
before a reviewer has read it.

     silently chosen. -->
