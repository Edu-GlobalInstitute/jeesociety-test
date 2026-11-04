/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Every route is written as its own directory with an index.html inside
  // (out/checkout/index.html, not out/checkout.html). Without this, a static
  // host has to guess that /checkout means checkout.html — Cloudflare Pages
  // does, a plain file server does not, and the link 404s there. A directory
  // index is what every static host resolves, so the export works wherever it
  // is served from.
  trailingSlash: true,
  // Deployed to Cloudflare Pages, not Vercel — Vercel's free tier forbids
  // commercial use, and this portal charges students (D-003).
  output: 'export',
  // `next build` empties the output directory. With both a dev server and a
  // build pointed at .next, a build halfway through someone else's session
  // deletes the chunks that server is still serving, and every page it hands
  // out 404s its own JavaScript. The dev script sets this to a directory of
  // its own (see package.json) so the two cannot collide; unset, it is the
  // default, so the deployed build is unaffected.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  images: { unoptimized: true },
  env: {
    /*
     * Same origin, proxied to the API by functions/api/[[path]].js.
     *
     * Pointing this at the API's own host makes the Better Auth session cookie
     * third-party: issued correctly, and then never sent back by any browser
     * that blocks or partitions such cookies. Safari blocks them by default, so
     * on a Mac sign-in simply does not work — the password is accepted and the
     * next request arrives with no session.
     *
     * A deployed build therefore refuses a cross-origin value rather than
     * honouring it. The variable was set to the Render URL in Cloudflare, which
     * silently reinstated the bug after it had been fixed in the code: the fix
     * was in the repository and absent from the running site, which is the
     * worst place for a difference to live. Only a relative path survives a
     * production build.
     *
     * Development is exempt — `pnpm dev` points it at localhost:3000, where
     * there is no proxy and both origins are the developer's own machine.
     */
    NEXT_PUBLIC_API_URL: (() => {
      const configured = process.env.NEXT_PUBLIC_API_URL;
      if (!configured) return '/api';
      if (configured.startsWith('/')) return configured;
      if (process.env.NODE_ENV !== 'production') return configured;
      console.warn(
        `\n  NEXT_PUBLIC_API_URL="${configured}" ignored: a production build must call the API\n`
          + '  on its own origin, or the session cookie is third-party and Safari drops it.\n'
          + '  Using "/api" (see functions/api/[[path]].js). Unset the variable to silence this.\n',
      );
      return '/api';
    })(),
    NEXT_PUBLIC_EXAM_URL: process.env.NEXT_PUBLIC_EXAM_URL ?? 'http://localhost:5173',
  },
};

export default nextConfig;
