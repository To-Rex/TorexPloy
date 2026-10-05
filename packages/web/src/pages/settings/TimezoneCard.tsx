/** The instance's time zone: shown with the current time there, changed through the same dialog as the clock. */
import { useState } from 'react';
import { Clock } from 'lucide-react';
import { TimezoneDialog, zoneOffset } from '../../components/ServerClock.tsx';
import { Button } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { SettingsSection } from './SettingsLayout.tsx';

export function TimezoneCard() {
  const { m, timezone, formatDate } = useI18n();
  const c = m.clock;
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection
      title={c.timezoneTitle}
      hint={c.timezoneHint}
      actions={
        <Button size="sm" icon={<Clock />} onClick={() => setOpen(true)}>
          {c.change}
        </Button>
      }
    >
      <dl className="facts-strip">
        <div>
          <dt>{c.timezone}</dt>
          <dd>{timezone.replace(/_/g, ' ')}</dd>
        </div>
        <div>
          <dt>{c.offset}</dt>
          <dd>{zoneOffset(timezone)}</dd>
        </div>
        <div>
          <dt>{c.serverTime}</dt>
          <dd>{formatDate(new Date(), { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        </div>
      </dl>
      <TimezoneDialog open={open} onClose={() => setOpen(false)} canEdit />
    </SettingsSection>
  );
}
