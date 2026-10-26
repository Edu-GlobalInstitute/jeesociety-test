/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
    NEXT_PUBLIC_EXAM_URL: process.env.NEXT_PUBLIC_EXAM_URL ?? 'http://localhost:5173',
  },
};

export default nextConfig;
