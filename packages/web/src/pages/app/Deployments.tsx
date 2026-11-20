import { useState } from 'react';
import { Link } from 'react-router';
import { BrushCleaning, ExternalLink, GitBranch, RefreshCw, Rocket, ScrollText, User, Webhook } from 'lucide-react';
import { isTerminalDeployment, type ApplicationDto, type DeploymentDto } from '@ploy/shared';
import { CopyButton, ValueField } from '../../components/Copy.tsx';
import { DeploymentItem, deploymentTiming, deploymentTitle, parseTime } from '../../components/DeploymentItem.tsx';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { computeStages, PipelineRail } from '../../components/Pipeline.tsx';
import { deploymentTone, Status } from '../../components/Status.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Button, Callout, EmptyState, Segmented, SkeletonRows, type Tone } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useLogStream } from '../../lib/logs.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useDeploymentCleanup, useDeployments } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';

/** The in-flight deployment: live pipeline rail and the tail of its log. */
function LiveDeployment({ deployment }: { deployment: DeploymentDto }) {
  const { m, t } = useI18n();
  const { lines } = useLogStream(`/api/deployments/${deployment.id}/log`);
  const stages = computeStages(lines, deployment.status, deployment.finishedAt === null ? null : Date.parse(deployment.finishedAt));
  const tail = lines.slice(-5);
  return (
    <div className="panel">
      <div className="panel__head">
        <Status kind="deployment" status={deployment.status} />
        <span className="grow truncate muted">
          <span className="tabular faint">{t(m.deployments.number, { n: deployment.number })}</span> {deploymentTitle(m, deployment)}
        </span>
        <Link className="btn btn--sm" to={`/deployments/${deployment.id}`} style={{ textDecoration: 'none' }}>
          <ScrollText width={14} height={14} aria-hidden="true" />
          {m.deployments.viewLog}
        </Link>
      </div>
      <div className="panel__body" style={{ display: 'grid', gap: 16 }}>
        <PipelineRail stages={stages} />
        {tail.length > 0 && (
          <div className="codeblock" style={{ paddingRight: 14, maxHeight: 120, overflow: 'hidden' }} aria-hidden="true">
            {tail.map((line) => line.text).join('\n')}
          </div>
        )}
      </div>
    </div>
  );
}

/** The deploy hook: a secret URL a CI system calls to start a deployment. */
function HookCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const rotate = useAction(() => api.post(`/api/applications/${app.id}/hook/rotate`), { success: m.appSettings.hookRotated, invalidate: [keys.app(app.id)] });
  return (
    <Card
      icon={<Webhook />}
      title={m.appSettings.hook}
      description={m.appSettings.hookHint}
      actions={
        <Button size="sm" icon={<RefreshCw />} busy={rotate.isPending} onClick={() => rotate.mutate()}>
          {m.appSettings.rotateHook}
        </Button>
      }
    >
      {app.deployHookUrl === null ? (
        <Callout tone="info">{m.appSettings.hookUnavailable}</Callout>
      ) : (
        <>
          <ValueField value={app.deployHookUrl} secret />
          <div className="codeblock">
            {`curl -X POST ${app.deployHookUrl}`}
            <CopyButton value={`curl -X POST ${app.deployHookUrl}`} />
          </div>
          {/^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?\//.test(app.deployHookUrl) && <p className="field__hint">{m.appSettings.hookFromAddress}</p>}
        </>
      )}
    </Card>
  );
}

/** Clean-up of old deployments: everything finished except the active one and the newest. */
function CleanupButton({ appId, count }: { appId: string; count: number }) {
  const { m, t, plural } = useI18n();
  const confirm = useConfirm();
  const plan = useDeploymentCleanup(appId, count > 1);
  const cleanup = useAction(() => api.post<{ removed: number; imagesRemoved: number }>(`/api/applications/${appId}/deployments/cleanup`), {
    success: (result) => plural(m.deployments.cleaned, result.removed),
    invalidate: [keys.app(appId), keys.appPart(appId, 'deployments'), keys.appPart(appId, 'deployments-cleanup'), keys.teamDeployments],
  });
  const removable = plan.data?.removable ?? 0;
  const kept = (() => {
    const { keptActive: active, keptNewest: newest } = plan.data ?? { keptActive: null, keptNewest: null };
    if (active !== null && active === newest) return t(m.deployments.cleanupKeptBoth, { n: active });
    return [active === null ? null : t(m.deployments.cleanupKeptActive, { n: active }), newest === null ? null : t(m.deployments.cleanupKeptNewest, { n: newest })].filter((part) => part !== null).join(', ');
  })();
  return (
    <Button
      size="sm"
      icon={<BrushCleaning />}
      busy={cleanup.isPending}
      disabled={removable === 0}
      title={removable === 0 ? m.deployments.cleanupNothing : undefined}
      onClick={async () => {
        const result = await confirm({
          title: m.deployments.cleanupTitle,
          text: `${plural(m.deployments.cleanupText, removable)} ${t(m.deployments.cleanupKeeps, { kept })}`,
          confirmLabel: m.deployments.cleanup,
          danger: true,
        });
        if (result.confirmed) cleanup.mutate();
      }}
    >
      {m.deployments.cleanup}
      {removable > 0 && <span className="btn__count">{removable}</span>}
    </Button>
  );
}

type Filter = 'all' | 'ok' | 'bad' | 'work';
const FILTER_OF: Record<Tone, Filter | null> = { ok: 'ok', bad: 'bad', work: 'work', idle: null, info: null };
const BAR_COUNT = 32;

/**
 * The history at a glance: which version is live, how deployments have been
 * going (how many, how often they succeed, how long they take), and the last
 * few dozen as bars: as tall as each took, coloured by how it ended.
 */
function Overview({ app, items, more }: { app: ApplicationDto; items: DeploymentDto[]; more: boolean }) {
  const { m, t, plural, formatDuration, formatNumber } = useI18n();
  const d = m.deployments;
  const o = d.overview;
  const now = Date.now();
  const live = items.find((deployment) => deployment.isActive) ?? null;
  const finished = items.filter((deployment) => deployment.status === 'succeeded' || deployment.status === 'failed');
  const succeeded = finished.filter((deployment) => deployment.status === 'succeeded');
  const rate = finished.length === 0 ? null : Math.round((succeeded.length / finished.length) * 100);
  const took = succeeded.map((deployment) => deploymentTiming(deployment, now).total).filter((value): value is number => value !== null);
  const average = took.length === 0 ? null : took.reduce((sum, value) => sum + value, 0) / took.length;
  const bars = items.slice(0, BAR_COUNT).reverse();
  const totals = bars.map((deployment) => deploymentTiming(deployment, now).total ?? 0);
  const longest = Math.max(1, ...totals);
  const newest = items[0];
  const who = live === null ? null : (live.createdBy?.name ?? (live.trigger === 'push' ? live.commitAuthor : null));

  return (
    <section className="card deploy-overview">
      <div className="deploy-live" data-state={live === null ? 'none' : 'ok'}>
        <span className="deploy-live__label">
          <span className="deploy-live__pulse" aria-hidden="true" />
          {o.live}
        </span>
        {live === null ? (
          <>
            <p className="deploy-live__title">{app.activeDeployment === null ? o.none : t(d.number, { n: '…' })}</p>
            <p className="deploy-live__facts">{app.activeDeployment === null ? o.noneHint : <RelativeTime value={app.activeDeployment.finishedAt ?? app.activeDeployment.createdAt} />}</p>
          </>
        ) : (
          <>
            <Link className="deploy-live__title truncate" to={`/deployments/${live.id}`}>
              {deploymentTitle(m, live)}
            </Link>
            <p className="deploy-live__facts">
              <span className="tabular">{t(d.number, { n: live.number })}</span>
              {(live.branch !== null || live.commitSha !== null) && (
                <span>
                  <GitBranch aria-hidden="true" />
                  {live.branch}
                  {live.commitSha !== null && <code>{live.commitSha.slice(0, 7)}</code>}
                </span>
              )}
              {who !== null && (
                <span>
                  <User aria-hidden="true" />
                  {who}
                </span>
              )}
              <span>
                <RelativeTime value={live.finishedAt ?? live.createdAt} />
              </span>
            </p>
            <div className="deploy-live__actions">
              <Link className="btn btn--sm" to={`/deployments/${live.id}`} style={{ textDecoration: 'none' }}>
                <ScrollText width={14} height={14} aria-hidden="true" />
                {d.viewLog}
              </Link>
              {app.url !== null && (
                <a className="btn btn--sm btn--ghost" href={app.url} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'none' }}>
                  <ExternalLink width={14} height={14} aria-hidden="true" />
                  {m.app.open}
                </a>
              )}
            </div>
          </>
        )}
      </div>
      <div className="deploy-stats">
        <dl className="deploy-stats__numbers">
          <div>
            <dt>{o.total}</dt>
            <dd className="tabular">
              {formatNumber(items.length)}
              {more && '+'}
            </dd>
          </div>
          <div>
            <dt>{o.success}</dt>
            <dd className="tabular" data-state={rate === null ? undefined : rate >= 90 ? 'ok' : rate >= 60 ? 'work' : 'bad'}>
              {rate === null ? '—' : `${rate}%`}
            </dd>
          </div>
          <div>
            <dt>{o.average}</dt>
            <dd className="tabular">{average === null ? '—' : formatDuration(average)}</dd>
          </div>
          <div>
            <dt>{o.last}</dt>
            <dd>{newest === undefined ? '—' : <RelativeTime value={newest.createdAt} />}</dd>
          </div>
        </dl>
        {bars.length > 1 && (
          <figure className="deploy-bars">
            <div className="deploy-bars__plot" role="list" aria-label={plural(o.recent, bars.length)}>
              {bars.map((deployment, index) => {
                const label = t(o.bar, { n: deployment.number, status: m.status.deployment[deployment.status], time: totals[index]! > 0 ? formatDuration(totals[index]!) : '—' });
                return (
                  <Link
                    key={deployment.id}
                    role="listitem"
                    to={`/deployments/${deployment.id}`}
                    className="deploy-bars__bar"
                    data-state={deploymentTone[deployment.status]}
                    data-active={deployment.isActive || undefined}
                    style={{ '--h': Math.max(0.16, totals[index]! / longest), '--i': index } as React.CSSProperties}
                    title={label}
                    aria-label={label}
                  />
                );
              })}
            </div>
            <figcaption>
              <span>{plural(o.recent, bars.length)}</span>
              <span>{o.barsHint}</span>
            </figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}

export function DeploymentsTab() {
  const app = useAppContext();
  const { m, formatDate } = useI18n();
  const d = m.deployments;
  const deployments = useDeployments(app.id);
  const [filter, setFilter] = useState<Filter>('all');
  const items = deployments.data?.pages.flatMap((page) => page.items) ?? [];
  const live = items.find((deployment) => !isTerminalDeployment(deployment.status));
  const counts = { all: items.length, ok: 0, bad: 0, work: 0 };
  for (const deployment of items) {
    const kind = FILTER_OF[deploymentTone[deployment.status]];
    if (kind !== null) counts[kind] += 1;
  }
  const shown = filter === 'all' ? items : items.filter((deployment) => FILTER_OF[deploymentTone[deployment.status]] === filter);

  // Grouped by when they started, in the instance's time zone, coarser the further back: today, yesterday,
  // the rest of the last week, then a month at a time. (A heading per day would be most of the list.)
  const day = (value: string | number) => formatDate(value, { day: 'numeric', month: 'long', year: 'numeric' });
  const now = Date.now();
  const today = day(now);
  const yesterday = day(now - 86_400_000);
  const groups: { label: string; items: DeploymentDto[] }[] = [];
  for (const deployment of shown) {
    const created = parseTime(deployment.createdAt) ?? now;
    const key = day(created);
    const month = formatDate(created, { month: 'long', year: 'numeric' });
    const label = key === today ? d.today : key === yesterday ? d.yesterday : now - created < 7 * 86_400_000 ? d.lastDays : month.charAt(0).toUpperCase() + month.slice(1);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.label === label) last.items.push(deployment);
    else groups.push({ label, items: [deployment] });
  }
  const option = (value: Filter, label: string) => ({
    value,
    label: (
      <>
        {label}
        <span className="count">{counts[value]}</span>
      </>
    ),
  });

  return (
    <>
      {live !== undefined && <LiveDeployment key={live.id} deployment={live} />}
      {items.length > 0 && <Overview app={app} items={items} more={deployments.hasNextPage} />}
      <Card
        title={d.title}
        description={d.hint}
        flush={items.length > 0}
        actions={
          items.length > 1 ? (
            <>
              <Segmented
                label={d.title}
                value={filter}
                onChange={setFilter}
                options={[option('all', d.filters.all), option('ok', d.filters.ok), option('bad', d.filters.bad), ...(counts.work > 0 || filter === 'work' ? [option('work', d.filters.work)] : [])]}
              />
              <CleanupButton appId={app.id} count={items.length} />
            </>
          ) : undefined
        }
      >
        {deployments.isPending ? (
          <SkeletonRows rows={5} />
        ) : items.length === 0 ? (
          <EmptyState icon={<Rocket />}>{d.empty}</EmptyState>
        ) : shown.length === 0 ? (
          <p className="deploy-days__empty">{d.noneMatch}</p>
        ) : (
          <div className="deploy-days">
            {groups.map((group) => (
              <section key={group.label} className="deploy-day">
                <h3 className="deploy-day__label">
                  {group.label}
                  <span className="tabular">{group.items.length}</span>
                </h3>
                <div className="deploy-list deploy-list--rail">
                  {group.items.map((deployment) => (
                    <DeploymentItem key={deployment.id} deployment={deployment} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {deployments.hasNextPage && (
          <div className="deploy-days__more">
            <Button busy={deployments.isFetchingNextPage} onClick={() => void deployments.fetchNextPage()}>
              {d.loadMore}
            </Button>
          </div>
        )}
      </Card>
      <HookCard app={app} />
    </>
  );
}
