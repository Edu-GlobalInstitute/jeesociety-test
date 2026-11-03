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
     * Same origin by default, proxied to the API by functions/api/[[path]].js.
     *
     * It used to point straight at the Render host, which made the Better Auth
     * session cookie third-party: issued correctly, and then never sent back by
     * any browser that blocks or partitions such cookies. A student saw "your
     * password was accepted, but this browser did not keep the sign-in
     * session", which was exactly true and impossible for them to act on.
     *
     * Set NEXT_PUBLIC_API_URL explicitly to bypass the proxy (local dev points
     * it at localhost:3000).
     */
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? '/api',
    NEXT_PUBLIC_EXAM_URL: process.env.NEXT_PUBLIC_EXAM_URL ?? 'http://localhost:5173',
  },
};

export default nextConfig;
