/** Route-backed tabs: each tab is a link, so tabs are bookmarkable and work with the back button. */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

export function RouteTabs({ items, label }: { items: { to: string; label: string; icon?: ReactNode; end?: boolean }[]; label: string }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end ?? true}>
          {item.icon}
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
