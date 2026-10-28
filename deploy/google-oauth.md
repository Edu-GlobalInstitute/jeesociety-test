# Google sign-in

Google is offered **alongside** email and password, never instead of it. If the
Google credentials are missing or wrong, the button disappears (or says so when
clicked) and every student can still register with a password. That is
deliberate: a `redirect_uri_mismatch` on the morning of the test would otherwise
be a total sign-in outage, and the event cannot be retried.

## What you have to do (owner)

### 1. Create the OAuth client

1. Open <https://console.cloud.google.com/> and sign in as the account that
   should own this.
2. Top-left project dropdown → **New project** → name it `jee-society-test` →
   **Create**. Wait for it to switch to the new project.
3. Left menu → **APIs & Services** → **OAuth consent screen**.
   - User type: **External** → **Create**.
   - App name: `JEE Society`. User support email: your address.
   - Upload the logo if you want the Google screen branded (optional).
   - **App domain** → Application home page: `https://test.jeesociety.in`.
   - Privacy policy link and Terms link: these are **required before you can
     publish** the consent screen. See the note at the bottom.
   - Developer contact email: your address → **Save and continue**.
   - Scopes: do not add any. The defaults (`email`, `profile`, `openid`) are all
     this needs → **Save and continue**.
   - Test users: add your own Google address and any staff who will test before
     launch → **Save and continue** → **Back to dashboard**.
4. Left menu → **Credentials** → **+ Create credentials** → **OAuth client ID**.
   - Application type: **Web application**.
   - Name: `jee-api`.
   - **Authorised JavaScript origins** → Add:
     - `http://localhost:3001` (local development)
     - `https://test.jeesociety.in` (production)
   - **Authorised redirect URIs** → Add, exactly:
     - `http://localhost:3000/auth/callback/google`
     - `https://api.test.jeesociety.in/auth/callback/google`

     Replace the second with whatever `BETTER_AUTH_URL` actually is in
     production — the rule is `${BETTER_AUTH_URL}/auth/callback/google`. Google
     compares this as a **string**: a trailing slash, `http` instead of `https`,
     or the wrong subdomain all produce `redirect_uri_mismatch`.
   - **Create**. Copy the **Client ID** and **Client secret**.

### 2. Put them in the environment

Local (`.env`):

```
GOOGLE_CLIENT_ID=<the client id>
GOOGLE_CLIENT_SECRET=<the client secret>
WEB_ORIGIN=http://localhost:3001
```

Production: set the same three on the API service (Railway → Variables), with
`WEB_ORIGIN=https://test.jeesociety.in`.

`WEB_ORIGIN` **must** also appear in `CORS_ORIGINS`, or the API refuses to boot
in production. That check exists because a wrong value there would redirect a
student — carrying a live session cookie — to an origin you do not control.

### 3. Publish the consent screen before launch

While the app is in **Testing**, only the test users you listed can sign in;
everyone else sees "Access blocked". Before registration opens:

OAuth consent screen → **Publish app** → confirm.

With only the `email`, `profile` and `openid` scopes this needs **no Google
verification review** and no security assessment, so publishing takes effect
immediately. (Verification is required only for sensitive or restricted scopes,
which this does not request.)

## How the flow works

```
/signup or /login
   │  "Continue with Google"
   ▼
POST {API}/auth/sign-in/social  { provider: 'google', callbackURL }
   │  returns { url, redirect: true }
   ▼
accounts.google.com  → student picks an account
   │
   ▼
{API}/auth/callback/google      ← the URI registered above; sets the session cookie
   │
   ▼
{WEB_ORIGIN}/auth/callback?next=…
   │  reads GET /profile
   ▼
/complete-profile  (always, on a first Google sign-in: Google gives no phone number)
   │
   ▼
/register → pay
```

The reason `/complete-profile` is unavoidable: Google returns an email, a name
and an avatar. It does not return a phone number, a class, a target year or a
guardian's consent — and `student_profiles.phone` is `NOT NULL UNIQUE` because a
student we cannot telephone is a student we cannot reach if the exam moves.
`POST /payments/order` returns `403 profile_incomplete` until the profile is
saved, so the gate is server-side and not just a UI step.

## Account linking

A student who registered with a password and later clicks "Continue with Google"
on the same address gets their **existing** account, not a second one
(`account.accountLinking.trustedProviders = ['google']` in `apps/api/src/auth.ts`).
Without this they would end up with two accounts, one of which holds the
payment.

This is safe only because Google verifies the address it asserts. **Do not add a
provider to `trustedProviders` that does not verify email** — that turns this
into an account-takeover path.

## Known limitation on localhost (read this before debugging a cookie problem)

In development the web app is `http://localhost:3001` and the API is
`http://localhost:3000`. Those are **different origins**, so the session cookie
is a third-party cookie, set with `SameSite=Lax` locally.

It works in Chrome and Firefox today with default settings. It will **not** work
if:

- you are in a Chrome profile with third-party cookies blocked;
- you are in Safari (ITP blocks it);
- you use an incognito window with "Block third-party cookies" on.

The symptom is specific: Google succeeds, you land on `/auth/callback`, and it
says "That did not work" because `GET /profile` returns 401 — the cookie was set
but never sent back.

**The fix is not a code change.** Production should serve the site and the API
from **one** origin, which is what `BUILD_PLAN.md` §3.2 specifies: everything
under `test.jeesociety.in`, with the API at `/api/*`. Then the cookie is
first-party, there is no CORS, and none of the above applies.

Until that is in place, use Chrome or Firefox with default settings for local
testing, and set `BETTER_AUTH_URL` to a real hostname (not `localhost`) the
moment the API is deployed anywhere a student will reach.

## Checklist before registration opens

- [ ] Consent screen **published** (not Testing), or every real student is blocked
- [ ] Redirect URI matches `${BETTER_AUTH_URL}/auth/callback/google` exactly
- [ ] `WEB_ORIGIN` set, and present in `CORS_ORIGINS`
- [ ] Privacy policy and terms pages exist and are linked on the consent screen
- [ ] Signed in with a Google account that has **never** used the site, and
      confirmed it lands on `/complete-profile` and cannot reach checkout first
- [ ] Signed up with a password, then signed in with Google on the **same**
      address, and confirmed it is one account rather than two
- [ ] Deliberately broken the client secret and confirmed the password form
      still works and the button fails politely
