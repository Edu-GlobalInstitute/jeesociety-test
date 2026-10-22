import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'All-India JEE Mock Test',
  description:
    'One all-India JEE mock test: 60 objective and 15 written questions in three hours, '
    + 'with objective results the next day and ranks within six days.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <div className="wrap masthead__inner">
            <a href="/" className="masthead__name" style={{ textDecoration: 'none', color: 'inherit' }}>
              All-India JEE Mock
            </a>
            <nav className="masthead__nav">
              <a href="/register">Register</a>
              <a href="/results">Results</a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="foot">
          <div className="wrap">
            Questions about your test? Quote your receipt number when you write to us.
          </div>
        </footer>
      </body>
    </html>
  );
}
