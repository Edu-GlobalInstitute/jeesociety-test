# Deploying, start to finish

The order below is the order that works. Each step's output is the next step's
input, so skipping ahead mostly produces a service that boots and then fails on
the one request that matters.

Four places get something:

| Where | What | Cost |
| --- | --- | --- |
| **Neon** | Postgres (`ap-southeast-1`) | free tier to start; paid compute for the event |
| **Railway** | `api` + `worker` services (Singapore) | ~$5/mo idle, more on test day |
| **Cloudflare Pages** | `jee-web`, `jee-exam` static sites | free |
| **Cloudflare R2** | the encrypted paper + backups | ~free at this size |

Plus **Razorpay** (per-transaction).

The detail for each lives in [neon.md](neon.md), [railway.md](railway.md),
[cloudflare.md](cloudflare.md). This file
is the sequence and the things that bite.

---

## 0. Before you start

You need: a GitHub account with this repo pushed to it, a card for Railway and
Neon and a Razorpay account.

**Push the repo first.** Railway and Pages both deploy from GitHub, so nothing
below works until the code is on a branch they can see.

```bash
git add -A
git commit -m "Add login and signup"
git push origin main
```

---

## 1. Neon — the database

1. <https://console.neon.tech> → **New project**.
2. Region: **AWS ap-southeast-1 (Singapore)**. Not us-east. The Railway
   services are in Singapore and every request makes several queries; a
   different region silently taxes all of them.
3. Postgres version **17** (matches `docker-compose.yml`, so local and
   production share a planner).
4. Copy **both** connection strings from the dashboard:
   - with `-pooler` in the host → this is `DATABASE_URL`
   - without `-pooler` → this is `DATABASE_URL_UNPOOLED`

   They are not interchangeable. [neon.md](neon.md) explains which breaks how.

Leave autosuspend on for now. It must be **off** for the event — see step 9.

### Run the migrations

From your machine, against the **direct** (unpooled) URL:

PowerShell (Windows) — set the variable on its own line. PowerShell has no
inline `VAR=value command` prefix; writing one makes it try to run the whole
string as a program name:

```powershell
$env:DATABASE_URL = "<the UNPOOLED url>"
npx --yes pnpm@9.15.4 migrate
Remove-Item Env:\DATABASE_URL
```

bash / zsh:

```bash
DATABASE_URL='<the UNPOOLED url>' npx pnpm@9.15.4 migrate
```

Expect `applied 5: 001_auth.sql … 005_student_profile.sql`. The fifth is the
student-profile table the new sign-up flow needs; without it `/profile` 500s and
nobody can pay.

> **Do not run `pnpm seed` against Neon.** It has no production guard: it
> inserts a fake test with a sample paper and marks it `live`. It is a
> local-development tool. The real test row is created in step 8.

---

## 2. Razorpay — so the site can take money

1. <https://dashboard.razorpay.com> → **Settings → API keys** → generate
   **test mode** keys first. `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`.
2. **Settings → Webhooks → Add new webhook**:
   - URL: `https://<your-api-domain>/payments/webhook` — you get this domain in
     step 3, so come back and fill it in.
   - Secret: generate a long random string. This is `RAZORPAY_WEBHOOK_SECRET`.
   - Events: `payment.captured`, `payment.failed`, `order.paid`,
     `refund.processed`.
3. Turn **auto-capture** on.

The webhook is what actually grants a student access — not the browser
callback, which is forgeable and also silently lost whenever someone closes the
tab on the success screen. If the webhook secret is wrong, payments succeed at
Razorpay and nobody gets in, and the only sign is a 400 in the API log.

Keep live keys until step 10.

---

## 3. Railway — the API and the worker

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → pick
   this repo.
2. Region **Singapore** (project settings). Same metro as Neon.
3. You need **two services from the same repo**. Railway creates one; duplicate
   it with **+ New → GitHub Repo → same repo**.

| Service | Start command |
| --- | --- |
| `api` | `node apps/api/dist/server.js` |
| `worker` | `node apps/worker/dist/worker.js` |

`nixpacks.toml` at the repo root already handles install and build for both,
including the `postgresql_17` package the worker's `pg_dump` backup needs.

4. On `api`: **Settings → Networking → Generate Domain**. That host is your API
   origin — e.g. `jee-api-production.up.railway.app`. Write it down; steps 2, 4
   and 5 all need it.
5. **Settings → Health check path** on `api`: `/ready`, timeout above 10 s.
   (`/ready` touches the database; `/health` does not.)

### Environment variables

On **`api`**:

```
NODE_ENV=production
DATABASE_URL=<Neon POOLED url>
DATABASE_URL_UNPOOLED=<Neon DIRECT url>
PG_POOL_MAX=15

BETTER_AUTH_SECRET=<32+ random chars: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
BETTER_AUTH_URL=https://api.test.jeesociety.in

CORS_ORIGINS=https://<web-domain>,https://<exam-domain>
WEB_ORIGIN=https://<web-domain>


RAZORPAY_KEY_ID=<test key>
RAZORPAY_KEY_SECRET=<test secret>
RAZORPAY_WEBHOOK_SECRET=<the webhook secret from step 2>

TRUST_PROXY_HOPS=1
SERVE_LOCAL_PAPERS=false
```

On **`worker`**: the same database variables, plus

```
NODE_ENV=production
PG_POOL_MAX=5
WORKER_JOBS=autosubmit,flags,payments,backup
R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET=jee-papers
```

The API **refuses to boot** in production without `CORS_ORIGINS`, the Razorpay
keys, or the webhook secret, and refuses if `WEB_ORIGIN` is not in
`CORS_ORIGINS`. That is deliberate: each of those is a failure that otherwise
only appears when a student hits it. A boot loop here is the guard working —
read the log, it names the variable.

`BETTER_AUTH_SECRET` signs every session cookie. **Rotating it signs every
student out**, so set it once and never touch it near the event.

Verify: `curl https://<api-domain>/health` → `{"ok":true,...}`, and
`/ready` → `{"ok":true}`. If `/ready` fails but `/health` works, the database
URL is wrong.

---

## 4. Sign-in

Email and password is the only way in. There is nothing to configure here.

Google sign-in was offered and has been removed — `socialProviders` is empty in
`apps/api/src/auth.ts`, so `/auth/sign-in/social` answers `PROVIDER_NOT_FOUND`
and no saved link can create an account that bypasses the password. Any
`GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` still set in the Render dashboard
is ignored and should be deleted so it cannot look live.

> **There is still no password reset.** No email sending is configured, so a
> student who forgets their password has no self-service route back in. This is
> the gap to close before the paper opens — and note that any account created
> through Google *before* the removal has no password row at all, so those
> students cannot sign in until one is set for them. See the admin recovery
> script in [ADMIN-PORTAL.md](ADMIN-PORTAL.md).

---

## 5. Cloudflare Pages — the two frontends

Two projects, same repo.

| Project | Build command | Output directory |
| --- | --- | --- |
| `jee-web` | `npx pnpm@9.15.4 install --frozen-lockfile && npx pnpm@9.15.4 --filter @jee/web build` | `apps/web/out` |
| `jee-exam` | `npx pnpm@9.15.4 install --frozen-lockfile && npx pnpm@9.15.4 --filter @jee/exam build` | `apps/exam/dist` |

<https://dash.cloudflare.com> → **Workers & Pages → Create → Pages → Connect to
Git**.

Build-time variables on `jee-web`:

```
NEXT_PUBLIC_API_URL=https://api.test.jeesociety.in
NEXT_PUBLIC_EXAM_URL=https://<exam-domain>
```

On `jee-exam`:

```
VITE_API_URL=https://api.test.jeesociety.in
VITE_WEB_URL=https://<web-domain>
```

These are baked in at **build** time, not read at runtime — changing one needs a
redeploy, not a restart.

The API hostname must be under the same registrable domain as the frontends.
For this deployment, add `api.test.jeesociety.in` as a custom domain on the
Render `jee-api` service, then create its Cloudflare CNAME to that service's
`onrender.com` hostname. Set the DNS record to **DNS only** while Render
verifies it and issues TLS. Update `BETTER_AUTH_URL`, `NEXT_PUBLIC_API_URL`,
and `VITE_API_URL` to `https://api.test.jeesociety.in`, then redeploy the API
and both Pages projects. The current `onrender.com` API URL is cross-site from
`test.jeesociety.in`; browsers that restrict third-party cookies can accept a
password but refuse the session cookie, leaving every authenticated request
with a 401. CORS settings do not override browser cookie policy.

On `jee-exam` add a redirect so deep links boot the SPA. Create
`apps/exam/public/_redirects`:

```
/*    /index.html   200
```

Now go back and put both Pages domains into the API's `CORS_ORIGINS`, and the
web one into `WEB_ORIGIN`.

### Custom domains

Pages → the project → **Custom domains**. `test.jeesociety.in` → `jee-web`,
and something like `exam.jeesociety.in` → `jee-exam`. Then update
`CORS_ORIGINS`, `WEB_ORIGIN`, `NEXT_PUBLIC_*` and `VITE_*` to match. Every one
of them is a string compare somewhere.

> The build plan (§3.2) wants everything on **one** origin —
> `test.jeesociety.in`, with the API at `/api/*`. That is better: cookies become
> first-party and CORS disappears. It is also part of the Cloudflare port,
> which §2.1 says to skip if the exam is under four weeks out.
> Two origins works today; one origin is where this should land.

---

## 6. R2 — the paper

Cloudflare → **R2 → Create bucket** → `jee-papers`.

Make a second bucket for backups, or scope the public domain to `papers/` only.
**Backups must not be public.** The paper blob is safe to serve publicly because
it is AES-256-GCM ciphertext whose key is released at `starts_at`; a database
dump is not.

Create an **R2 API token** (Account → R2 → Manage API tokens) and put the three
values on the `worker` service.

---

## 7. Verify the whole funnel, in test mode

Do this on the deployed site, not locally. In order:

1. Open `https://<web-domain>` — the landing page renders.
2. **Register** → `/signup` → create an account with email and password.
3. You land on `/complete-profile`. Fill it. Use a date of birth under 18 and
   confirm the guardian block appears and blocks submission until consented.
4. You land on `/register` with a **Pay** button.
5. Pay with a [Razorpay test card](https://razorpay.com/docs/payments/payments/test-card-details/).
6. The page polls and flips to "payment is recorded".
7. In Razorpay's dashboard → Webhooks, the delivery shows **200**.
8. Sign out. Sign in at `/login`. You land on `/register`, already paid.
9. **Profile gate:** with a fresh account, confirm `/register` sends you to
   `/complete-profile` and that checkout is unreachable until it is saved.
10. **No social route:** `POST /auth/sign-in/social` with
    `{"provider":"google"}` must answer `PROVIDER_NOT_FOUND`. If it returns a
    URL, the deployed build still has a provider configured.

If step 7 shows anything other than 200, stop and fix it. A failing webhook
means students pay and get nothing, and the reconciliation job only partly
covers it.

---

## 8. Create the real test and an admin

There is no admin-creation endpoint by design, and `pnpm seed` must not touch
production. So, two manual steps against the **direct** Neon URL:

```sql
-- The real test row. IST times converted to UTC: 09:00 IST = 03:30 UTC.
INSERT INTO tests (name, starts_at, ends_at, lobby_opens_at, status)
VALUES ('JEEsociety Scholarship Test',
        '2026-11-29 03:30:00+00',
        '2026-11-29 06:30:00+00',
        '2026-11-29 03:00:00+00',
        'scheduled')
RETURNING id;
```

`scheduled` is the state that sells the test while the paper stays shut: the
public site takes payments and the exam client shows its coming-soon screen.

Then make yourself an admin — **sign up on the site first**, then:

```sql
INSERT INTO admins (user_id, note)
SELECT "id", 'owner' FROM "user" WHERE "email" = 'you@example.com';
```

Publish the paper with `tools/build-paper` (see its README) — the admin **Go
live** button refuses a test with no paper.

---

## 9. The day before

- **Neon: autosuspend OFF.** Default behaviour suspends an idle compute, and the
  first connection pays the wake-up. 20,000 students arriving in one minute onto
  a cold compute is a self-inflicted outage.
- **Neon: size the compute up**, and check PITR retention covers the event plus
  the days after.
- **Railway: `api` to 4 replicas, 2 vCPU / 2 GB**; `worker` stays at 1.
- Confirm the worker's boot log says `"msg":"backups enabled"` with `pg_dump`
  17+. Without it the worker runs happily and takes **no backups**.
- Verify the paper is cached at the edge: fetch it twice, the second must say
  `cf-cache-status: HIT`.
- **Do not deploy during the test window.** The API draining mid-event costs
  students their in-flight syncs.

## 10. Switching to live money

Only after step 7 passes end to end in test mode:

1. Razorpay → complete KYC → **live** keys.
2. Replace `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` on the `api` service.
3. Add a **live-mode** webhook with the same URL and events, and a new secret;
   update `RAZORPAY_WEBHOOK_SECRET`.
4. Make one real ₹499 payment yourself and refund it from the dashboard.

Test and live keys are separate, and so are their webhooks. A live key with a
test webhook secret fails signature verification on every real payment.

## 11. The day after

**Scale everything down.** `api` to 1 small replica, `worker` to 0, Neon
autosuspend back on and the compute resized. The dominant cost is idle RAM held
across a month, not test-day compute, and this is the step everyone forgets —
it repeats the bill silently until someone notices.

---

## Common failures, and what they actually mean

| Symptom | Cause |
| --- | --- |
| API boot loop, log names a variable | A production guard doing its job. Set it. |
| `/health` OK, `/ready` 503 | `DATABASE_URL` wrong, or Neon compute suspended |
| Student pays, no access | Webhook secret mismatch, or the URL still points at the old domain. Check Razorpay → Webhooks for non-200s. |
| `/profile` 500s, nobody can pay | Migration `005` not applied |
| CORS errors in the browser console | A Pages domain missing from `CORS_ORIGINS`, exactly (scheme, no trailing slash) |
| Exam client 404s on refresh | `_redirects` missing from `apps/exam/public/` |
| Worker runs, no backups | `pg_dump` absent or older than Postgres 17 |
