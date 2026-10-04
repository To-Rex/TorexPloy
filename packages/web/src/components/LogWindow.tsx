/**
 * How much of a container log to start with: the last N lines, from the
 * last so-many minutes. Shared by the application and database log tabs.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { Select } from './ui.tsx';

export const TAILS = ['100', '300', '1000', '5000', 'all'] as const;
export const SINCES = ['', '900', '3600', '21600', '86400'] as const;

export function useLogWindow() {
  const [tail, setTail] = useState<(typeof TAILS)[number]>('300');
  const [since, setSince] = useState<(typeof SINCES)[number]>('');
  const query = `tail=${tail}${since.length > 0 ? `&since=${since}` : ''}`;
  return { tail, setTail, since, setSince, query };
}

export function LogWindowPicker({ window }: { window: ReturnType<typeof useLogWindow> }) {
  const { m } = useI18n();
  const l = m.logs;
  return (
    <>
      <Select value={window.tail} onChange={(event) => window.setTail(event.target.value as (typeof TAILS)[number])} aria-label={l.tail} style={{ width: 'auto' }}>
        {TAILS.map((value) => (
          <option key={value} value={value}>
            {value === 'all' ? l.tailAll : `${value} ${l.tailLines}`}
          </option>
        ))}
      </Select>
      <Select value={window.since} onChange={(event) => window.setSince(event.target.value as (typeof SINCES)[number])} aria-label={l.since} style={{ width: 'auto' }}>
        <option value="">{l.sinces.all}</option>
        <option value="900">{l.sinces.m15}</option>
        <option value="3600">{l.sinces.h1}</option>
        <option value="21600">{l.sinces.h6}</option>
        <option value="86400">{l.sinces.d1}</option>
      </Select>
    </>
  );
}
