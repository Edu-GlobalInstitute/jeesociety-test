'use client';

import { usePathname } from 'next/navigation';
import './admin.css';

/**
 * The admin portal's own chrome.
 *
 * A nested layout rather than the root one: the root layout is the public
 * site's, with a marketing ticker, a Register call to action and the prize
 * photo credits. None of that belongs around a sales pipeline, and the ticker
 * animates forever behind a screen staff keep open all day.
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

  return (
    <div className="admin">
      <header className="admin__bar">
        <div className="admin__brand">
          JEE Society <span>admin</span>
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
      </header>
      {children}
    </div>
  );
}
