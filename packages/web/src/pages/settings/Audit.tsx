import { ScrollText } from 'lucide-react';
import { RelativeTime } from '../../components/Time.tsx';
import { Avatar, Button, EmptyState, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useAudit } from '../../lib/queries.ts';

export function AuditPage() {
  const { m, formatDate } = useI18n();
  const audit = useAudit();
  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];
  const actions = m.audit.actions as Record<string, string>;
  return (
    <>
      {audit.isPending ? (
        <SkeletonRows rows={6} />
      ) : items.length === 0 ? (
        <EmptyState icon={<ScrollText />}>{m.audit.empty}</EmptyState>
      ) : (
        <>
          <div className="list">
            {items.map((entry) => (
              <div key={entry.id} className="list__row" style={{ minHeight: 52 }}>
                <Avatar name={entry.actor?.name ?? m.audit.system} size={28} />
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span style={{ fontWeight: 560 }}>{entry.actor?.name ?? m.audit.system}</span>
                    <span>{actions[entry.action] ?? entry.action}</span>
                    {entry.targetName !== null && <span className="code-inline">{entry.targetName}</span>}
                  </div>
                  <div className="list__meta">
                    {entry.ip !== null && <span>{entry.ip}</span>}
                    <span title={formatDate(entry.createdAt, { dateStyle: 'full', timeStyle: 'medium' })}>
                      <RelativeTime value={entry.createdAt} />
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {audit.hasNextPage && (
            <div>
              <Button busy={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
                {m.audit.loadMore}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
