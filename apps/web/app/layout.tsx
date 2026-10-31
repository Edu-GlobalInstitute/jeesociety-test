import type { Metadata, Viewport } from 'next';
import { MENTORSHIP, PAPER, TEST_FEE_PAISE } from '@jee/shared/config';
import './globals.css';
import { ArrowIcon } from '../components/PosterMarks';
import { TEST_WHEN } from '../lib/testDate';

const RUPEES = TEST_FEE_PAISE / 100;
const WORTH = MENTORSHIP.worthRupees.toLocaleString('en-IN');

export const metadata: Metadata = {
  title: `All-India JEE Mock — top 1% wins ${MENTORSHIP.months} months of IIT Bombay mentorship`,
  description:
    `One full JEE paper, sat on the same morning across India: ${PAPER.totalCount} questions `
    + `in three hours for ${PAPER.maxMarks} marks, ₹${RUPEES} to enter. `
    + `Finish in the top 1% of the rank list and win ${MENTORSHIP.months} months `
    + `of one-to-one mentorship from ${MENTORSHIP.mentors}, a ₹${WORTH} seat, free; the next two `
    + 'percentile bands take a shorter seat and a half-price one. '
    + TEST_WHEN,
};

/** The cream of the chrome, so the phone's status bar joins the page. */
export const viewport: Viewport = {
  themeColor: '#fff4e0',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Fonts come in as a stylesheet link rather than next/font because this
            app is a static export (next.config.mjs, output: 'export') built on
            Cloudflare Pages, and next/font would make every build depend on
            reaching Google. */}
        <link
          rel="stylesheet"
          href={
            'https://fonts.googleapis.com/css2'
            + '?family=Archivo:wdth,wght@75..100,500..900'
            + '&family=Bricolage+Grotesque:wght@600;700;800'
            + '&family=Hanken+Grotesk:wght@400;500;600;700'
            + '&display=swap'
          }
        />
      </head>
      <body>
        <header className="masthead">
          <div className="wrap masthead__inner">
            <a href="/" className="masthead__name">
              {/* Plain <img>, not next/image: this app is a static export with
                  images.unoptimized set, so next/image would add a component
                  and buy nothing. */}
              <img className="masthead__logo" src="/logo.jpeg" alt="" width={30} height={30} />
              {/* On the narrowest phones the name is taken out of the flow rather
                  than removed, so the mark keeps its accessible name. */}
              <span className="masthead__wordmark">JEEsociety</span>
            </a>
            <nav className="masthead__nav">
              <a className="masthead__home" href="/">Home</a>
              <a href="/results">Results</a>
              {/* The way back in for a student who already has an account: an
                  outlined pill, so it reads as a button without taking the eye
                  from Register, which is what a first visit is here for. */}
              <a className="masthead__signin" href="/login">Sign in</a>
              <a className="nav-cta" href="/checkout">
                Register
                <span className="nav-cta__arrow" aria-hidden="true">
                  <ArrowIcon />
                </span>
              </a>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
