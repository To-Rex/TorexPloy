/** Relative timestamps that stay fresh, with the absolute time on hover. */
import { useEffect, useReducer } from 'react';
import { useI18n } from '../i18n/index.tsx';

let tick = 0;
const listeners = new Set<() => void>();
setInterval(() => {
  tick += 1;
  for (const listener of listeners) listener();
}, 30_000);

function useTick(): number {
  const [, force] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => {
      listeners.delete(force);
    };
  }, []);
  return tick;
}

export function RelativeTime({ value }: { value: string | number | null | undefined }) {
  const { formatRelative, formatDate } = useI18n();
  useTick();
  if (value === null || value === undefined) return <span className="faint">—</span>;
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()} title={formatDate(date, { dateStyle: 'full', timeStyle: 'medium' })}>
      {formatRelative(date)}
    </time>
  );
}
