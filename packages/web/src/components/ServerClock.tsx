/**
 * The server's clock in the top bar, in the instance's time zone, and the
 * dialog that changes the zone. The clock follows the server's time (the
 * bootstrap carries it), not the browser's, so every operator sees the same.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Clock, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { isValidTimeZone, type BootstrapDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { api } from '../lib/api.ts';
import { useAction } from '../lib/mutate.ts';
import { keys } from '../lib/queries.ts';
import { Dialog } from './Dialog.tsx';
import { Button, Callout, Input } from './ui.tsx';

const FALLBACK_ZONES = ['UTC', 'Asia/Tashkent', 'Asia/Almaty', 'Asia/Bishkek', 'Asia/Dushanbe', 'Asia/Ashgabat', 'Asia/Baku', 'Europe/Moscow', 'Europe/Istanbul', 'Europe/Berlin', 'Europe/London', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles'];

/** Every zone the browser knows, or a short list on older engines. */
function allZones(): string[] {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    if (list !== undefined && list.length > 0) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    // older engine
  }
  return FALLBACK_ZONES;
}

/** `UTC+05:00` for a zone right now. */
export function zoneOffset(zone: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find((item) => item.type === 'timeZoneName')?.value ?? 'GMT';
    return part === 'GMT' ? 'UTC+00:00' : part.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

/** The zone's short name where it has one (`CET`, `PKT`); otherwise the city. */
function zoneLabel(zone: string): string {
  const city = zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;
  return city;
}

/** Milliseconds to add to the browser's clock to get the server's. */
function useServerOffset(bootstrap: BootstrapDto): number {
  return useMemo(() => {
    const serverTime = Date.parse(bootstrap.serverTime);
    return Number.isNaN(serverTime) ? 0 : serverTime - Date.now();
  }, [bootstrap.serverTime]);
}

function useNow(offset: number): Date {
  const [now, setNow] = useState(() => new Date(Date.now() + offset));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date(Date.now() + offset)), 1_000);
    return () => window.clearInterval(timer);
  }, [offset]);
  return now;
}

export function TimezoneDialog({ open, onClose, canEdit }: { open: boolean; onClose: () => void; canEdit: boolean }) {
  const { m, timezone, formatDate, setTimezone } = useI18n();
  const c = m.clock;
  const client = useQueryClient();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(timezone);
  useEffect(() => {
    if (open) {
      setChosen(timezone);
      setQuery('');
    }
  }, [open, timezone]);
  const zones = useMemo(allZones, []);
  const needle = query.trim().toLowerCase().replace(/\s+/g, '_');
  const matches = useMemo(() => {
    const list = needle.length === 0 ? zones : zones.filter((zone) => zone.toLowerCase().includes(needle));
    // The current and the chosen zone stay in view.
    const pinned = [timezone, chosen].filter((zone, index, all) => all.indexOf(zone) === index && list.includes(zone));
    return [...pinned, ...list.filter((zone) => !pinned.includes(zone))].slice(0, 60);
  }, [zones, needle, timezone, chosen]);
  const save = useAction((zone: string) => api.patch('/api/settings', { timezone: zone }), {
    success: c.saved,
    invalidate: [keys.settings, keys.bootstrap],
    onSuccess: () => {
      setTimezone(chosen);
      void client.invalidateQueries();
      onClose();
    },
  });
  const previewAt = new Date();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={c.timezoneTitle}
      description={canEdit ? c.timezoneHint : c.timezoneReadOnly}
      onSubmit={() => {
        if (canEdit && isValidTimeZone(chosen) && chosen !== timezone) save.mutate(chosen);
        else onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          {canEdit && (
            <Button type="submit" variant="primary" busy={save.isPending} disabled={chosen === timezone}>
              {c.apply}
            </Button>
          )}
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <label className="toolbar__search" style={{ maxWidth: 'none', flex: 'none' }}>
          <Search aria-hidden="true" />
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={c.search} aria-label={c.search} data-autofocus />
        </label>
        <div className="zones" role="listbox" aria-label={c.timezoneTitle}>
          {matches.map((zone) => (
            <button key={zone} type="button" role="option" aria-selected={zone === chosen} className="zone" disabled={!canEdit} onClick={() => setChosen(zone)}>
              <span className="zone__check">{zone === chosen && <Check aria-hidden="true" />}</span>
              <span className="zone__name">
                {zone.replace(/_/g, ' ')}
                {zone === timezone && <span className="builder__tag">{c.current}</span>}
              </span>
              <span className="zone__meta">
                {zoneOffset(zone, previewAt)} · {formatDate(previewAt, { timeZone: zone, hour: '2-digit', minute: '2-digit' })}
              </span>
            </button>
          ))}
          {matches.length === 0 && <p className="field__hint" style={{ padding: 10 }}>{m.palette.noResults}</p>}
        </div>
        {canEdit && chosen !== timezone && <Callout tone="info">{c.applyHint}</Callout>}
      </div>
    </Dialog>
  );
}

export function ServerClock({ bootstrap, canEdit }: { bootstrap: BootstrapDto; canEdit: boolean }) {
  const { m, timezone, formatClock, formatDate } = useI18n();
  const offset = useServerOffset(bootstrap);
  const now = useNow(offset);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="clock" onClick={() => setOpen(true)} title={`${m.clock.serverTime}: ${formatDate(now, { dateStyle: 'full', timeStyle: 'medium' })} (${timezone}, ${zoneOffset(timezone, now)})`}>
        <Clock aria-hidden="true" />
        <span className="clock__time tabular">{formatClock(now)}</span>
        <span className="clock__zone">{zoneLabel(timezone)}</span>
      </button>
      <TimezoneDialog open={open} onClose={() => setOpen(false)} canEdit={canEdit} />
    </>
  );
}
