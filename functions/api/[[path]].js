/**
 * Same-origin proxy for the API.
 *
 * Everything under https://test.jeesociety.in/api/* is forwarded to the Render
 * service and the response returned as-is, so the browser sees one origin.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The site and the API were on different origins, which made the Better Auth
 * session cookie a *third-party* cookie. The server side was never wrong — the
 * cookie is issued `Secure; SameSite=None; HttpOnly` and a request carrying it
 * is answered correctly — but a browser blocking third-party cookies never
 * sends it back. The student then saw "Your password was accepted, but this
 * browser did not keep the sign-in session": sign-in had genuinely succeeded
 * and the very next request arrived with no session.
 *
 * Safari blocks third-party cookies by default, Firefox partitions them, and
 * Chrome does the same in incognito and increasingly outside it. So this was
 * not an edge case — it locked students out of the one page that has to work.
 *
 * Routing through the site's own origin makes the cookie first-party, which no
 * browser blocks. It is also what the build plan asked for (§3.2); two origins
 * was the shortcut.
 *
 * _redirects cannot do this: Cloudflare only proxies relative paths on the same
 * site, and an external destination becomes a 302 the browser follows — which
 * would put the cookie back on the API's origin and change nothing.
 *
 * This file lives at the repository root, not under apps/web. Cloudflare reads
 * Functions from `/functions` at the Pages project root and explicitly not from
 * the build output — "make sure that the /functions directory is at the root of
 * your Pages project (and not in the static root, such as /dist)". It was in
 * apps/web/functions first, copied into out/ by a build step, and Pages ignored
 * it entirely: /api/health answered Cloudflare's static 404 rather than
 * reaching this code at all.
 *
 * ── What this must get right ─────────────────────────────────────────────
 *
 * Cookies. Set-Cookie may appear several times (Better Auth sets a session
 * token and a short-lived session_data cookie), and Headers collapses repeated
 * values into one comma-joined string — which is not a valid cookie header and
 * silently loses one. getSetCookie() returns them as separate entries.
 *
 * The Domain attribute. The API sets its cookies for its own host; left alone
 * the browser rejects them as a cross-domain cookie. They are host-only here,
 * so the attribute is stripped and the cookie belongs to whatever origin served
 * the page.
 *
 * The body. Streamed rather than buffered, so a paper blob or a CSV export does
 * not have to fit in the Function's memory.
 */

/*
 * The API's own domain, not jee-api.onrender.com.
 *
 * Render serves every *.onrender.com host behind a shared Cloudflare zone with
 * bot protection on it. That zone sees this proxy, not students: all of our
 * traffic arrives from a handful of Cloudflare datacentre addresses, which is
 * indistinguishable from automated abuse. When it decided we were a bot it
 * answered 429 with a "Just a moment..." challenge page -- to a student's
 * sign-in request -- and the login form showed "Too many attempts". It fired
 * on /health too, so it was never about the auth routes.
 *
 * A custom domain on the Render service is served without that shared zone's
 * challenge in front of it. Certificate verified before this was switched.
 */
const API_ORIGIN = 'https://api.jeesociety.in';

/** Hop-by-hop headers, which must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // /api/profile -> https://api.jeesociety.in/profile
  const target = new URL(url.pathname.replace(/^\/api/, '') || '/', API_ORIGIN);
  target.search = url.search;

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    // Host must describe the upstream, not this site, or Render routes nowhere.
    if (name.toLowerCase() === 'host') continue;
    headers.set(name, value);
  }

  // The API reads the origin for its CORS allowlist and for Better Auth's
  // trustedOrigins check. Same-origin requests send no Origin header on GET, so
  // state it explicitly rather than leaving the upstream to guess.
  headers.set('origin', url.origin);
  // Preserve the real client address: the API's rate limiter and the attempt
  // routes record it, and without this every student looks like Cloudflare.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-forwarded-host', url.host);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    // GET and HEAD must not carry one; everything else streams through.
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    // Required whenever the body is a stream rather than a buffered value.
    // Cloudflare's runtime does not insist on it; undici does, and omitting it
    // makes the Function impossible to exercise outside Cloudflare.
    ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { duplex: 'half' }),
    redirect: 'manual',
  });

  /*
   * An interception, not an answer.
   *
   * The API answers JSON. If something in front of it — a Cloudflare bot
   * challenge, a block page, a host's own 502 while the service restarts —
   * returns HTML instead, passing that through means the browser tries to
   * JSON.parse a web page and the student reads
   * `Unexpected token '<', "<!DOCTYPE "...` on the sign-in form. That names the
   * parser's complaint and nothing about the cause.
   *
   * Recognising it here is better than recognising it in the client, because
   * only this side knows it came from upstream rather than from the
   * application. Turned into the shape every caller already handles.
   */
  const upstreamType = upstream.headers.get('content-type') ?? '';
  if (!upstreamType.includes('application/json') && !upstreamType.includes('text/plain')
      && upstream.status >= 400) {
    // Non-JSON error bodies are never from the application: it answers JSON for
    // every refusal it makes. Say which of the two it was, because the remedy
    // differs and guessing sends people the wrong way -- the first version of
    // this called a 429 a "security check", which is a diagnosis nobody can act
    // on.
    const throttled = upstream.status === 429;
    return new Response(
      JSON.stringify({
        error: throttled ? 'rate_limited' : 'upstream_unavailable',
        message: throttled
          ? 'Too many requests reached the server in a short time, so it is turning some '
            + 'away. Wait about a minute and try again.'
          : 'The server did not answer this request. It may be restarting. Wait a moment '
            + 'and try again.',
        upstreamStatus: upstream.status,
      }),
      {
        status: throttled ? 429 : 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          // Both clear on their own; let the caller retry rather than caching
          // the failure at the edge.
          'retry-after': throttled ? '60' : '30',
        },
      },
    );
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    // Rebuilt below, one entry at a time.
    if (lower === 'set-cookie') continue;
    // Same origin now, so CORS headers are meaningless and an echoed
    // allow-origin naming the API host would only confuse a reader.
    if (lower.startsWith('access-control-')) continue;
    responseHeaders.set(name, value);
  }

  // getSetCookie keeps repeated Set-Cookie headers separate. `headers.get()`
  // would comma-join them into one invalid header and lose a cookie.
  const cookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie()
    : [upstream.headers.get('set-cookie')].filter(Boolean);

  for (const cookie of cookies) {
    // Drop Domain=<api host>: the cookie belongs to this origin now, and a
    // domain the browser does not recognise makes it reject the cookie.
    responseHeaders.append('set-cookie', cookie.replace(/;\s*Domain=[^;]+/i, ''));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
