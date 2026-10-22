/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Deployed to Cloudflare Pages, not Vercel — Vercel's free tier forbids
  // commercial use, and this portal charges students (D-003).
  output: 'export',
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000',
    NEXT_PUBLIC_EXAM_URL: process.env.NEXT_PUBLIC_EXAM_URL ?? 'http://localhost:5173',
  },
};

export default nextConfig;
