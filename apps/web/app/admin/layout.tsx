'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { getProfile } from '../../lib/auth';
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
  const [access, setAccess] = useState<'checking' | 'ready' | 'error'>('checking');

  useEffect(() => {
    if (pathname === '/admin/login') return;
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
  }, [pathname]);

  if (pathname === '/admin/login') return <div className="admin admin--login">{children}</div>;

  if (access !== 'ready') {
    return (
      <main className="ap" role="status" aria-live="polite">
        {access === 'error' ? (
          <p className="msg msg--bad">Could not reach the sign-in service. Check your connection and reload.</p>
        ) : (
          <p className="empty">Checking your sign-in…</p>
        )}
      </main>
    );
  }

  return (
    <div className="admin">
      <header className="admin__bar">
        <div className="admin__brand">
          JEEsociety <span>admin</span>
        </div>
        <nav className="admin__tabs">
          {TABS.map((tab) => {
            const active = tab.exact
              ? pathname === tab.href
              : pathname.startsWith(tab.href);
            return (
              <a
                key={tab.href}
                href={tab.href}
                className={active ? 'admin__tab admin__tab--on' : 'admin__tab'}
              >
                {tab.label}
              </a>
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
              await (await import('../../lib/auth')).signOut();
            } finally {
              window.location.href = '/admin/login';
            }
          }}
        >
          Log out
        </button>
      </header>
      {children}
    </div>
  );
}
