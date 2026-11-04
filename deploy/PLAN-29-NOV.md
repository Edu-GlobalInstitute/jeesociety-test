# The plan to 29 November

Written for: you, deciding what gets built and in what order.

The paper opens **29 November 2026, 09:00 IST**. Everything below is ordered so
that the things which cannot be fixed on the day are finished first, and the
things that can wait until December are last.

---

## What already exists

Worth knowing before reading the list, because more is built than it looks.

| | Status |
|---|---|
| Exam client: timer from server clock, OMR palette, mark-for-review, offline cache, 90s sync | **built** |
| Auto-submit, MCQ scoring, flag computation, payment reconcile — as worker jobs | **written, not deployed** |
| Submit route: idempotent, returns a receipt, returns **no score** | **built** |
| Admin: dashboard, CRM, test designer, 2FA, coupons | **built** |
| Paper encryption, key release at start instant, round-trip verification | **built** |
| Student result page | **does not exist** |
| Results release control | **does not exist** |
| Rank and percentile | **does not exist** |

So this is less "build an exam portal" and more "finish the last mile and make
the day safe".

---

## Stage 1 — Exam day cannot fail (do first)

Nothing here is cosmetic. Each item is something that, if missing at 09:00 on
29 November, cannot be repaired while 25,000 students are sitting the paper.

### 1.1 Deploy the worker

The jobs exist (`apps/worker/src/jobs/`) and the service is absent from
`render.yaml`. Today that means:

- **nothing auto-submits** when the window closes — a student who closes their
  laptop is never submitted at all;
- **nothing scores** the paper;
- **nothing reconciles payments**, which is one cause of "I paid and it did not
  show".

This is the single highest-risk gap. One Render service, ~$7/month.

### 1.2 Move off the free API plan before the day

The free instance sleeps after 15 minutes idle and takes 30–60s to wake. That
is the "whole website is lagging" report. On exam morning it is worse than slow:
the lobby opens for everyone within the same two minutes.

Sizing for 25,000 students is in `deploy/railway.md` — roughly 4 replicas of
2 vCPU / 2 GB for the exam hour. It can be scaled back down afterwards.

### 1.3 A dry run with real students

Not optional. Pick a date around **22 November** — a week before, so there is
time to fix what it finds. Fifty students, the real paper flow, on their own
devices. Every problem found in this session so far was found by someone
*using* the thing, not by reading the code.

---

## Stage 2 — Results, held and then released

### 2.1 Hold results until you say so

`tests.status` already has a `graded` value and the attempts table already has
`mcq_score` and `total_score`. What is missing is the switch between "scored"
and "visible".

Adds `tests.results_released_at`. A student's result route refuses until it is
set; the admin presses **Launch result** to set it. Scoring can therefore run
the moment the paper closes, with nobody able to see anything.

### 2.2 What a student sees after submitting

Receipt only. No marks, no answer key, no count of correct answers — nothing
from which a score can be inferred, because results are launched for everyone at
once.

```
✓ Your paper has been submitted

  Receipt    JEE-7F3A-9C2B
  Submitted  29 Nov 2026, 12:00 IST

  Results will be published on <date>.
```

### 2.3 The scorecard

Per subject: correct, wrong, unattempted, marks. Then total, percentile, All
India rank, and the reward band.

Rank and percentile are computed once when results are launched and stored, not
calculated per request — 25,000 students refreshing a page that ranks the whole
cohort on every load is a self-inflicted outage.

### 2.4 Launch result, from the admin portal

One button. It scores anything unscored, computes ranks, sets
`results_released_at`, and writes an audit row. Refuses if any attempt is still
unscored, so it cannot half-release.

---

## Stage 3 — The admin portal you asked for

### 3.1 Dashboard reflects CRM removals

Removing a lead currently hides it from the CRM list but the dashboard counts
carry on including it. Both read the same exclusion so the numbers agree.

### 3.2 CRM split: paid and unpaid

Two sections rather than a filter, because they are two different jobs: unpaid
is a call list, paid is a record. Counts on each.

### 3.3 The attempt list

Every student who sat the paper, with their details, submission time, receipt,
and — after release — their score and rank. Exportable.

---

## Stage 4 — Security audit

A full pass, reported before anything is changed:

- every route checked for missing or wrong authorisation;
- repository history scanned for committed secrets;
- the browser bundle checked for anything that should not be in it;
- the answer key proven unreachable before release;
- rate limits on auth and payment;
- cookie flags, CORS, and the admin 2FA path.

Then automated tests so a future change cannot quietly undo it: the build fails
if an unauthenticated request reaches an admin route, if the answer key appears
in a student-facing response, or if a secret pattern is committed.

**Separately, and urgently:** the Neon password and the Razorpay key secret were
pasted into a chat and must be treated as compromised. I cannot rotate them —
that needs dashboard access — but the steps are short and I will write them out.

---

## Stage 5 — Cross-platform

Windows, macOS, iOS and Android, on the browsers students actually use. The
Safari cookie problem was exactly this class of bug: it worked everywhere the
developer looked and failed on a Mac. Checked on real devices during the dry
run rather than assumed.

---

## What I am not doing unless you ask

- Rebuilding the exam client's look to match NTA's exactly. It already has the
  parts that matter — server clock, palette, mark-for-review, offline cache. If
  you want a specific NTA behaviour I have not listed, name it.
- A question-by-question review screen after results. Worth having, bigger than
  it sounds, and it can ship in December.

---

## The honest risks

**25 days, and the paper has never been sat.** The dry run is what converts that
from a hope into a known quantity.

**The webhook is still unconfirmed.** If Razorpay is not reaching
`/payments/webhook`, every student who pays is left unregistered. This is worth
checking today, not in week three — the diagnostic is in
`deploy/ADMIN-PORTAL.md`.

**There is still no password reset and no email sending.** A student who forgets
their password has no way back in, and that is now the only way in. It also
means no admit card, no receipt and no result notification can be emailed.
