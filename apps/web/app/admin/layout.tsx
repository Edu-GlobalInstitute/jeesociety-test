'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getProfile, signOut } from '../../lib/auth';
import './admin.css';

/**
 * The admin portal's own chrome.
 *
 * A nested layout rather than the root one: the root layout is the public
 * site's, with a Register call to action and the prize photo credits. None of
 * that belongs around a sales pipeline.
 *
 * It cannot be replaced outright — a nested layout renders inside the root —
 * so `admin.css` hides the public chrome for these routes instead. That is one
 * rule in one file, which is less to go wrong than a route group that moves
 * every page.
 *
 * ── Why switching tabs used to feel stuck ────────────────────────────────
 *
 * Three things compounded, and all three are fixed here:
 *
 *   1. The tabs were plain <a href>, so every click was a full browser
 *      navigation: the whole React bundle was thrown away and re-downloaded,
 *      and the screen went white before anything rendered. They are next/link
 *      now, which swaps only the page component.
 *
 *   2. This layout blocked on GET /profile before rendering *any* chrome, so
 *      the nav bar itself vanished on every click and came back a round trip
 *      later. That is what made it feel broken rather than merely slow. The
 *      chrome now renders immediately and only the page body waits.
 *
 *   3. The check re-ran on every pathname change, putting a /profile round
 *      trip in front of each page's own data fetch — two sequential requests
 *      per click instead of one. The session cannot change by moving between
 *      tabs, so it is checked once per mount.
 *
 * The session is still verified: a visitor who is not signed in is still sent
 * to /admin/login. And this was never the access control — every admin route is
 * enforced server-side by requireAdmin on each request, regardless of what this
 * component renders.
 */

const TABS = [
  { href: '/admin', label: 'Dashboard', exact: true },
  { href: '/admin/leads', label: 'Sales CRM' },
  { href: '/admin/designer', label: 'Test designer' },
  { href: '/admin/review', label: 'Review queue' },
  { href: '/admin/security', label: 'Security' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // `trailingSlash: true` makes the static route resolve as `/admin/login/`.
  // Treat both forms as the public login page so it does not redirect to itself
  // and recursively wrap the current URL in `next=`.
  const isLoginPage = pathname.replace(/\/+$/, '') === '/admin/login';
  const [access, setAccess] = useState<'checking' | 'ready' | 'error'>('checking');

  useEffect(() => {
    if (isLoginPage) return;
    let live = true;
    void getProfile()
      .then((profile) => {
        if (!live) return;
        if (!profile) {
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.replace(`/admin/login?next=${encodeURIComponent(next)}`);
          return;
        }
        setAccess('ready');
      })
      .catch(() => {
        if (live) setAccess('error');
      });
    return () => {
      live = false;
    };
    // Deliberately not keyed on `pathname`. The session cannot change by moving
    // between tabs, and re-checking on every navigation serialised a /profile
    // round trip ahead of each page's own fetch. A session that expires
    // mid-visit surfaces as a 401 from the page's own request, which is where
    // it belongs.
  }, [isLoginPage]);

  if (isLoginPage) return <div className="admin admin--login">{children}</div>;

  // The same trailing-slash problem as above, and it was a real bug: pathname
  // is "/admin/leads/", which never equals a TABS href, so no tab ever showed
  // as the current one.
  const current = pathname.replace(/\/+$/, '') || '/admin';

  return (
    <div className="admin">
      {/* Rendered before the session check resolves, not after. The bar is
          identical on every admin page, so blanking it while /profile was in
          flight only made navigation look broken. */}
      <header className="admin__bar">
        <div className="admin__brand">
          JEEsociety <span>admin</span>
        </div>
        <nav className="admin__tabs">
          {TABS.map((tab) => {
            const active = tab.exact ? current === tab.href : current.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                // What a screen reader announces as the current page; the
                // colour alone does not say it.
                aria-current={active ? 'page' : undefined}
                className={active ? 'admin__tab admin__tab--on' : 'admin__tab'}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        <a className="admin__exit" href="/">
          View site
        </a>
        <button
          className="admin__exit admin__logout"
          type="button"
          onClick={async () => {
            try {
              await signOut();
            } finally {
              // A full load, deliberately: signing out should leave nothing of
              // the previous session in memory.
              window.location.href = '/admin/login';
            }
          }}
        >
          Log out
        </button>
      </header>

      {access === 'error' ? (
        <main className="ap" role="status" aria-live="polite">
          <p className="msg msg--bad">
            Could not reach the sign-in service. Check your connection and reload.
          </p>
        </main>
      ) : access === 'checking' ? (
        <main className="ap" role="status" aria-live="polite">
          <p className="empty">Checking your sign-in…</p>
        </main>
      ) : (
        children
      )}
    </div>
  );
}
