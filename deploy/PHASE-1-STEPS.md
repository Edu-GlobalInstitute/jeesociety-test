# Phase 1: landing page, sign-up, sign-in, Razorpay test mode

**Scope:** the public funnel on `test.jeesociety.in` — landing page, create an
account, sign in, and pay with **test** keys so no real money moves.

**Not in this phase:** Google sign-in (code is in, switched off), the exam
client, the admin panel, the paper, real payments.

Follow the steps in order. Where a step produces a value the next one needs, it
says so. Budget about two hours, most of it waiting for DNS.

---

## What you are signing up for

| Service | What it does here | Cost now |
| --- | --- | --- |
| **Neon** | Postgres database | free tier |
| **Railway** | runs the API | $5/mo (includes $5 usage credit) |
| **Cloudflare** | DNS + hosts the website | free |
| **Razorpay** | payments, test mode | free until live keys |

**~$5/month** for this phase. The free tier is genuinely enough while you are
only taking registrations; it stops being enough on exam day, which is a
decision for later, not now.

---

## Step 1 — Push the code to GitHub ✅ DONE 2026-10-29

Railway and Cloudflare both deploy from GitHub, so nothing works until the code
is there. Three commits are ready on `main`.

```bash
cd "D:/Orvinex Software Solution/testseries"
git push origin main
```

If it asks for a password, use a **personal access token**, not your GitHub
password: GitHub → Settings → Developer settings → Personal access tokens →
Tokens (classic) → Generate new token → tick `repo` → copy it and paste it as
the password.

---

## Step 2 — Neon: the database ✅ DONE 2026-10-29

Project `ancient-meadow-62709723`, branch `production`, region
`ap-southeast-1` (correct — same metro as Railway). Server reported
**PostgreSQL 18.6**.

Migrations applied: `applied 5` — `001_auth`, `002_core`, `003_ops`,
`004_mcq_only`, `005_student_profile`. Verified afterwards: 13 tables,
`student_profiles` with 15 columns and the `trg_student_profiles_complete`
trigger, and both endpoints reachable.

The two connection strings for step 4 differ only by `-pooler`:

```
POOLED  (DATABASE_URL)
  ...@ep-sparkling-frost-aopw6f31-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require

DIRECT  (DATABASE_URL_UNPOOLED)
  ...@ep-sparkling-frost-aopw6f31.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

> **The password in that connection string was pasted into a chat, so treat it
> as exposed.** Rotate it before real registrations open: Neon console →
> **Roles** → `neondb_owner` → **Reset password**, then update `DATABASE_URL`
> and `DATABASE_URL_UNPOOLED` on the Railway service. Nothing else holds a copy.

The steps below are kept for when this is set up again (a fresh branch, or
after a reset).

---

## Step 2 (reference) — Neon: the database

1. Go to <https://console.neon.tech> and sign up.
2. **New project**:
   - Name: `jee-test`
   - Postgres version: **whatever Neon defaults to** (it served 18.6 here)
   - Region: **AWS Asia Pacific 1 (Singapore)** — `ap-southeast-1`
3. On the dashboard, find **Connection string**. There is a toggle for
   **Pooled connection**. You need **both** forms:

   | Toggle | Host looks like | Call it |
   | --- | --- | --- |
   | Pooled **on** | `ep-xxx-pooler.ap-southeast-1.aws.neon.tech` | **POOLED URL** |
   | Pooled **off** | `ep-xxx.ap-southeast-1.aws.neon.tech` | **DIRECT URL** |

   The only difference is `-pooler` in the hostname. Paste both into a notepad
   file. They are not interchangeable and mixing them up fails quietly.

### Create the tables

In your terminal, with the **DIRECT** URL:

```bash
cd "D:/Orvinex Software Solution/testseries"
DATABASE_URL='<paste DIRECT URL here>' npx pnpm@9.15.4 migrate
```

Expect: `applied 5: 001_auth.sql, 002_core.sql, 003_ops.sql, 004_mcq_only.sql,
005_student_profile.sql`.

If you see `applied 4`, the profile table is missing and nobody will be able to
pay. Re-run it.

---

## Step 3 — Razorpay: test keys

1. <https://dashboard.razorpay.com> → sign up.
2. Top-left, make sure the mode switch says **Test Mode**.
3. **Account & Settings → API Keys → Generate Test Key**.
4. Copy both:
   - `rzp_test_...` → **KEY ID**
   - the secret → **KEY SECRET** (shown once; copy it now)
5. Make up a long random string for the webhook secret and save it as
   **WEBHOOK SECRET**. For example:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

The webhook itself gets configured in step 5, once you have an API URL.

---

## Step 4 — Railway: run the API

1. <https://railway.app> → sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick `testseries`.
3. Open the service → **Settings**:
   - **Region**: Singapore (same metro as Neon)
   - **Start Command**: `node apps/api/dist/server.js`
   - **Health Check Path**: `/ready`, timeout `30`
4. **Settings → Networking → Generate Domain.** You get something like
   `testseries-production-ab12.up.railway.app`. Call this your **API URL** —
   steps 5, 6 and 7 all need it.
5. **Variables** tab → paste this in, filling in your values.

   First generate the auth secret:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   ```
   NODE_ENV=production
   DATABASE_URL=<POOLED URL from step 2>
   DATABASE_URL_UNPOOLED=<DIRECT URL from step 2>
   PG_POOL_MAX=10
   BETTER_AUTH_SECRET=<the 43-character string you just generated>
   BETTER_AUTH_URL=https://<your API URL>
   CORS_ORIGINS=https://test.jeesociety.in
   WEB_ORIGIN=https://test.jeesociety.in
   RAZORPAY_KEY_ID=<KEY ID from step 3>
   RAZORPAY_KEY_SECRET=<KEY SECRET from step 3>
   RAZORPAY_WEBHOOK_SECRET=<WEBHOOK SECRET from step 3>
   TRUST_PROXY_HOPS=1
   SERVE_LOCAL_PAPERS=false
   ```

   Leave `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` **out entirely**. The
   Google button then hides itself and email/password is unaffected. Setting
   only one of the pair refuses to boot on purpose.

   `BETTER_AUTH_SECRET` signs every session cookie. **Changing it later signs
   out every student**, so set it once and leave it alone.

6. Wait for the deploy, then check it:

   ```bash
   curl https://<your API URL>/health
   curl https://<your API URL>/ready
   ```

   Both must return `{"ok":true,...}`.

   - `/health` fails → read the deploy log; it names the missing variable.
   - `/health` works but `/ready` is 503 → `DATABASE_URL` is wrong.

> **Do not add the `worker` service in this phase.** It only does auto-submit,
> scoring and backups, none of which exist yet.

---

## Step 5 — Point Razorpay's webhook at the API

Back in Razorpay → **Account & Settings → Webhooks → Add New Webhook**:

- **URL**: `https://<your API URL>/payments/webhook`
- **Secret**: the **WEBHOOK SECRET** from step 3 — it must match exactly
- **Active events**: tick `payment.captured`, `payment.failed`, `order.paid`,
  `refund.processed`
- Save.

This is what actually marks a student as paid. The browser's success screen
does not — it is forgeable, and it is also lost whenever someone closes the tab.
If this secret does not match, every payment succeeds at Razorpay and nobody
gets access.

---

## Step 6 — Cloudflare: DNS for jeesociety.in

The site needs `test.jeesociety.in`. Two routes; pick one.

### Route A — move jeesociety.in's DNS to Cloudflare (recommended)

Free, and it is what the build plan assumes. **Your main site keeps working**,
because you copy its records across before switching.

1. <https://dash.cloudflare.com> → **Add a site** → `jeesociety.in` → **Free**.
2. Cloudflare scans your existing DNS and lists what it found. **Check this
   list carefully against your current DNS host** — especially:
   - the `A`/`CNAME` for `jeesociety.in` and `www` (the main site)
   - **`MX` records (email).** If these are wrong or missing, email to
     `@jeesociety.in` stops. Copy them exactly.
   - any `TXT` records (SPF, DKIM, domain verification)
3. Cloudflare gives you two nameservers. Go to wherever `jeesociety.in` is
   registered and replace the nameservers with Cloudflare's.
4. Wait for propagation — usually under an hour, up to 24. Cloudflare emails
   you when it is active.
5. Verify the main site and your email still work before continuing.

### Route B — keep DNS where it is

Add one `CNAME` at your current DNS host:

```
Type: CNAME   Name: test   Value: <your-pages-project>.pages.dev
```

You get HTTPS and Cloudflare's CDN, but not Cloudflare Access or custom WAF
rules. Fine for this phase.

---

## Step 7 — Cloudflare Pages: host the website

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
   → pick `testseries`.
2. Build settings:

   | Field | Value |
   | --- | --- |
   | Project name | `jee-web` |
   | Production branch | `main` |
   | Build command | `npx pnpm@9.15.4 install --frozen-lockfile && npx pnpm@9.15.4 --filter @jee/web build` |
   | Build output directory | `apps/web/out` |

3. **Environment variables** (build-time):

   ```
   NEXT_PUBLIC_API_URL=https://<your API URL>
   ```

   These are compiled into the pages, not read at runtime — changing one needs a
   redeploy, not a restart.

4. **Save and Deploy.** First build takes a few minutes.
5. **Custom domains** → **Set up a custom domain** → `test.jeesociety.in` →
   Cloudflare adds the DNS record for you (Route A) or shows you the CNAME
   target (Route B).
6. Open <https://test.jeesociety.in>. The landing page should render.

---

## Step 8 — Create the test row

The site needs one row in `tests`, or `/register` shows an error instead of a
pay button. `/test/status` ignores rows with status `draft`, so it must be
`scheduled`.

Neon dashboard → **SQL Editor** → run:

```sql
-- Times are UTC. 09:00 IST = 03:30 UTC (IST is UTC+5:30).
-- This date must match TEST_STARTS_AT in packages/shared/src/config.ts.
INSERT INTO tests (name, starts_at, ends_at, lobby_opens_at, status)
VALUES ('JEEsociety Scholarship Test',
        '2026-11-29 03:30:00+00',   -- 09:00 IST
        '2026-11-29 06:30:00+00',   -- 12:00 IST (3 hours)
        '2026-11-29 03:00:00+00',   -- 08:30 IST (lobby, 30 min before)
        'scheduled')
RETURNING id;
```

`scheduled` is the state that sells the test while the paper stays shut:
registration and payment work, and the exam side stays closed. That is exactly
this phase.

---

## Step 9 — Walk the whole funnel

On the real site, in this order:

1. <https://test.jeesociety.in> → landing page renders, countdown shows.
2. Click **Register** → you are on `/signup`.
3. Create an account with a real email and a password of 8+ characters.
4. You land on `/complete-profile`. Fill it in. **Use a date of birth under 18**
   and check that the parent/guardian block appears and refuses to submit until
   you tick consent.
5. You land on `/register` with a **Pay ₹300** button.
6. Click it. Razorpay's test checkout opens. In test mode:
   - **Card**: take one from
     <https://razorpay.com/docs/payments/payments/test-cards> — e.g. Visa
     `4895 1911 1111 1115`. Copy it from that page rather than from here; the
     list changes.
   - **Expiry**: any future date. **CVV**: any three digits.
   - **OTP**: any random **4 to 10 digit** number makes the payment succeed.
     Fewer than 4 digits makes it fail — which is how you test the failure path.

   These cards work in test mode only.
7. The page shows "Confirming your payment…" and then flips to **registered**.
8. **Razorpay → Webhooks → your webhook → Recent Deliveries: must show 200.**
   This is the step that matters. Anything else means students pay and get
   nothing.
9. Sign out (clear cookies), go to `/login`, sign in. You should land on
   `/register` already showing as paid.

If step 7 hangs on "Confirming", the webhook is the cause. Check step 8, then
the Railway log.

---

## Step 10 — Tell me the result

Then I will do the next piece. In rough order of what matters:

- **privacy policy + terms pages** — needed for Google sign-in to be publishable
  at all, and needed anyway under the DPDP Act because most candidates are
  minors
- **forgot-password / reset-password** — not built yet; a student who forgets
  their password currently has no route back in
- **email sending** — nothing is emailed yet, including the payment receipt
- **the admit card page**
- then: Google sign-in, the exam client, the admin panel, the paper

---

## If something breaks

| What you see | What it means |
| --- | --- |
| Railway deploy loops, log names a variable | A guard doing its job. Set that variable. |
| `/health` OK, `/ready` 503 | `DATABASE_URL` wrong, or Neon compute asleep (first hit wakes it) |
| Landing page loads, sign-up does nothing | `NEXT_PUBLIC_API_URL` wrong, or `CORS_ORIGINS` does not match `https://test.jeesociety.in` exactly — no trailing slash |
| "There is no scheduled test" | Step 8 not done, or the row is still `draft` |
| `/profile` returns 500 | Migration `005` not applied — re-run step 2 |
| Pay button does nothing | Razorpay keys missing or still placeholders |
| Paid, but still shows unpaid | Webhook secret mismatch, or the URL points at the old domain |
| Main site or email broke after step 6 | A record was not copied. Compare against your old DNS host and fix it. |

Costs to keep an eye on: Railway is $5/mo with a $5 usage credit, so one small
API service is roughly covered. Neon's free tier suspends after 5 minutes idle
and wakes on the next request — fine now, must be turned off before exam day.
