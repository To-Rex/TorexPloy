/**
 * Pages declare their breadcrumb trail and document title; the shell renders
 * them. Kept in a tiny external store so setting crumbs never re-renders the
 * page that set them.
 */
import { useEffect, useSyncExternalStore } from 'react';

export interface Crumb {
  label: string;
  to?: string;
}

let crumbs: Crumb[] = [];
const listeners = new Set<() => void>();

function setCrumbs(next: Crumb[]): void {
  crumbs = next;
  for (const listener of listeners) listener();
}

export function useCrumbsValue(): Crumb[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => crumbs,
  );
}

/** Set breadcrumbs and the tab title for the current page. */
export function usePageMeta(trail: Crumb[]): void {
  const signature = trail.map((crumb) => `${crumb.label}|${crumb.to ?? ''}`).join('/');
  useEffect(() => {
    setCrumbs(trail);
    const last = trail[trail.length - 1];
    document.title = last === undefined ? 'TorexPloy' : `${last.label} — TorexPloy`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}
