# The admin portal

Three screens, behind a row in the `admins` table.

| Screen | Path | What it is for |
|---|---|---|
| Dashboard | `/admin` | Signups vs paid, 7 and 30 days, funnel, referral sources |
| Sales CRM | `/admin/leads` | Every student with phone and email, stages, call log |
| Test designer | `/admin/designer` | Create tests, write questions, launch papers |
| Live console | `/admin/live` | The during-test dashboard (was `/admin`) |
| Review queue | `/admin/review` | Flagged attempts |

## Before it works: apply migrations and provision the admin account

### 1. Run the migration

`006_admin_portal.sql` adds the admin portal tables and columns. `007_admin_2fa.sql` adds the authenticator schema. Apply all pending migrations from the repository root:

```powershell
cd "D:/Orvinex Software Solution/testseries"
$env:DATABASE_URL = "<your Neon pooled URL>"
npx --yes pnpm@9.15.4 migrate
Remove-Item Env:DATABASE_URL
```

It derives Neon's **direct** endpoint from the pooled one by itself (DDL is
session work and the pooler cannot carry an advisory lock), so the pooled URL is
the right thing to pass. Expect both admin migrations to be listed as applied.

Re-running it is safe: every statement is `IF NOT EXISTS` or idempotent, and
`schema_migrations` records what has been applied.

### 2. Bootstrap the fixed admin

The only admin identity is `jeesocietydev@gmail.com`. Access is checked on
**every request** rather than from a claim in the session cookie. Use the
dedicated setup form below for a new account. If the account already exists,
grant its existing user row in Neon:

```sql
INSERT INTO admins (user_id, note)
SELECT "id", 'founder'
  FROM "user"
 WHERE lower("email") = lower('jeesocietydev@gmail.com')
ON CONFLICT (user_id) DO NOTHING;
```

This inserts no row unless the exact admin account already exists in `"user"`. The API rejects other email addresses even if an `admins` row is present.

## Dedicated admin sign-in

The admin sign-in page is `/admin/login`. It uses the fixed account
`jeesocietydev@gmail.com`, and the API enforces that same email as the only
admin identity. The admin bar has a **Log out** button; student login remains
at `/login`.

For a first-time setup, create a private setup code and add it to the Render
service as `ADMIN_BOOTSTRAP_SECRET`. Generate one locally with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Do not paste the code into chat or commit it. Open `/admin/login` → **First
time? Set up the admin account**, enter the code, choose a password and confirm
it. The account is created and granted admin access in one flow. Remove
`ADMIN_BOOTSTRAP_SECRET` from Render after setup, then redeploy. If the account
already exists, use **Admin sign in** with its existing password instead; the
setup form deliberately refuses to replace an existing account's password.

The setup code exists because email verification is not configured. A public
form that lets anyone set the password for a known email address would let
someone else claim the admin account.

## What was added to the schema

| Table | Holds |
|---|---|
| `questions` | The editable question bank. One row per question per test. |
| `paper_blobs` | Compiled, encrypted paper ciphertext. |
| `question_images` | Figures for questions, options and solutions. |
| `lead_pipeline` | Sales state: stage, owner, follow-up date. |
| `lead_notes` | The contact log. Append-only. |

Plus `tests.kind`, `tests.requires_payment` and `tests.duration_minutes`.

Nothing was dropped and nothing existing was rewritten, so the live site keeps
working with the migration applied and no new code deployed.

## How a paper gets published

This is the one part worth understanding, because it is the part with no second
chance on exam morning.

```
questions table  (editable: bulk upload, per-question edit, images)
       │
  [ Publish ] ──► validate ──► encrypt (AES-256-GCM, fresh key)
       │                              │
       │                         round-trip check
       │                              │
       ├─► paper_blobs  (ciphertext, public, immutable, cached a year)
       ├─► tests.paper_key    (the secret — released at the start instant)
       ├─► tests.answer_key   (never leaves the server)
       └─► tests.status = scheduled | live
```

Three properties are preserved from the original CLI design:

- **The answer key never reaches a student.** `compilePaper` reads
  `correct_answer` and writes it only into the answer key; the paper object is
  built field by field from the other columns. A test asserts the serialised
  paper contains no answer in any form.
- **The blob is public and the key is the secret.** That is why
  `/papers/test-1-abc123.json` needs no session: without `paper_key` it is
  noise. `GET /attempt/key` releases the key at `starts_at` and not a
  millisecond before.
- **The ciphertext is verified before it is published.** It is decrypted with
  the key about to be stored and compared against the input. If that ever
  failed, students would receive an unopenable paper at the start instant with
  no way to fix it inside the window.

### Publishing refuses an invalid paper

Not a warning — a refusal. A question with no answer means every student who
attempts it scores −1 for trying, and that cannot be corrected once the paper is
open. The designer shows the problem list continuously while you write, so you
learn what is missing before you press the button.

A scholarship test must be exactly the advertised shape: 20 single-correct and 5
integer per subject, 75 questions, 300 marks. A **mock is exempt** — a
20-question chemistry-only mock is a legitimate thing to set.

### Re-publishing

Allowed while the test is `draft` or `scheduled`, and that is the normal way to
correct a paper before it opens: it mints a fresh key and a fresh blob, and the
digest in the URL changes so no cache can serve the old one.

**Refused once the test is `live`**, because a student who already downloaded the
blob holds one encrypted with the previous key.

## Mock tests vs the scholarship test

| | Mock | Scholarship |
|---|---|---|
| Who can enter | any signed-in student | paid students only |
| Appears on dashboard | yes | yes, for everyone |
| Paper shape enforced | no | yes, the full JEE pattern |
| Payment taken | no | yes |

The gate reads `tests.requires_payment`, not `kind` — so a free re-run of a
scholarship paper (a centre that lost power) needs no code exception.

`/payments/order` now asks for the **scholarship test by name** rather than
"whichever test is soonest". Without that, a free mock opening tomorrow would
become the thing a student is charged for.

## One standing caveat: where the blob is served from

The paper blob and the images are stored in Postgres and served by the API. That
is correct for mocks and it is what makes the designer usable with no S3
credentials, but for the **paid event at 25,000 students** it puts the 09:00:00
fetch through one Render instance.

Before the scholarship test, upload the blob to R2 with
`tools/build-paper` and let `tests.paper_url` point at the CDN. Nothing else has
to change — the exam client fetches whatever URL that column holds.

## Images

Uploaded as the raw request body with a `Content-Type`, not multipart, so the
browser side is one `fetch`. The declared type is **not** trusted: the upload
route reads the file's first bytes and refuses anything that is not actually a
PNG, JPEG, WebP or GIF. SVG is excluded deliberately — it is a document that can
carry script, and these are served from the API's own origin.

Capped at 5 MB per file, enforced in both the route and a CHECK constraint.

## The CRM

Every student who signs up **is** a lead. There is no import step and no
separate leads table: `student_profiles.phone` is already mandatory and unique,
and the email is on the `user` row, so the lead list is a join.

`lead_pipeline` holds sales state and nothing else — no copy of the name, phone
or email, because two numbers for one student gives nobody a way to say which to
ring.

Note what is **not** a stage: `paid`. Whether a student has paid is a `payments`
row, derived on read. A stage that could disagree with the money is a second
answer to a question that already has one.

`lead_notes` is append-only. "We called on the 3rd and they asked us to call
after boards" is a record, and a record that can be edited afterwards is not
evidence of anything.

## Still outstanding from before this work

- **Razorpay webhook** — still unconfirmed. Without it, payments hang on
  *"Confirming your payment…"* forever, and no lead ever shows as paid.
- **Rotate the exposed credentials**: the Neon password and the Razorpay key
  secret were both pasted into chat.
- **Make the GitHub repo private** — it is currently public.
- **Privacy policy and terms pages** — required to publish Google's consent
  screen, and required under the DPDP Act since most candidates are minors.
- **The exam date.** `packages/shared/src/config.ts` still says
  `2026-11-10`, which is twelve days away. This has been asked several times and
  not yet answered; if it is wrong, the landing page countdown, the test row and
  the minor-consent calculation are all wrong together.
