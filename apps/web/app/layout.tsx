import type { Metadata, Viewport } from 'next';
import { PAPER, TEST_FEE_PAISE } from '@jee/shared/config';
import './globals.css';
import { ArrowIcon } from '../components/PosterMarks';
import { PRIZE_PHOTO_CREDIT } from '../components/PrizeDevices';
import { TEST_DATE_SHORT, TEST_WHEN } from '../lib/testDate';

const RUPEES = TEST_FEE_PAISE / 100;

export const metadata: Metadata = {
  title: 'All-India JEE Mock — top 1% takes an iPad',
  description:
    `One full JEE paper, sat on the same morning across India: ${PAPER.totalCount} questions `
    + `in three hours for ${PAPER.maxMarks} marks, ₹${RUPEES} to enter. Try five real questions `
    + 'before you pay. Finish in the top 1% of the rank list and take home an iPad or an '
    + 'iPhone; the next two percentile bands take JEE Society mentorship. '
    + TEST_WHEN,
};

/** The navy of the chrome, so the phone's status bar joins the night sky. */
export const viewport: Viewport = {
  themeColor: '#0e1830',
};

/**
 * Fonts come in as a stylesheet link rather than next/font because this app is
 * a static export (next.config.mjs, output: 'export') built on Cloudflare
 * Pages, and next/font would make every build depend on reaching Google.
 */
const TICKER = [
  'Top 1% takes home an iPad',
  `₹${RUPEES} to sit the paper`,
  'One all-India rank list',
  `${PAPER.totalCount} questions, ${PAPER.maxMarks} marks`,
  'Ranks the same week',
  TEST_DATE_SHORT,
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
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
        {/* The marquee repeats its items twice so the track can translate by
            exactly -50% and loop with no visible seam. */}
        <div className="ticker-strip">
          <div className="ticker">
            <div className="ticker__track">
            {[0, 1].map((copy) => (
                <div className="ticker__group" key={copy} aria-hidden={copy === 1}>
                  {TICKER.map((item) => (
                    <span className="ticker__item" key={item}>
                      {item}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <header className="masthead">
          <div className="wrap masthead__inner">
            <a href="/" className="masthead__name">
              {/* Plain <img>, not next/image: this app is a static export with
                  images.unoptimized set, so next/image would add a component
                  and buy nothing. */}
              <img className="masthead__logo" src="/logo.jpeg" alt="" width={34} height={34} />
              JEE Society
            </a>
            <nav className="masthead__nav">
              <a href="/">Home</a>
              <a href="/results">Results</a>
              <a href="/login">Sign in</a>
              <a className="nav-cta" href="/signup">
                Register
                <span className="nav-cta__arrow" aria-hidden="true">
                  <ArrowIcon />
                </span>
              </a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="foot">
          <div className="wrap">
            Questions about your test? Quote your receipt number when you write to us.
            {/* CC BY-SA 4.0 requires this credit to stay visible. */}
            <p className="foot__credit">
              Prize photographs:{' '}
              {PRIZE_PHOTO_CREDIT.map((credit, index) => (
                <span key={credit.what}>
                  {index > 0 ? '; ' : ''}
                  {credit.what} by {credit.author},{' '}
                  <a href={credit.href} rel="noopener noreferrer" target="_blank">
                    Wikimedia Commons
                  </a>
                </span>
              ))}
              , licensed{' '}
              <a
                href="https://creativecommons.org/licenses/by-sa/4.0/"
                rel="license noopener noreferrer"
                target="_blank"
              >
                CC BY-SA 4.0
              </a>
              . JEE Society is not affiliated with or endorsed by Apple Inc.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
