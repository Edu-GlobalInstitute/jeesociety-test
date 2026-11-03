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

const API_ORIGIN = 'https://jee-api.onrender.com';

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

  // /api/profile -> https://jee-api.onrender.com/profile
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
