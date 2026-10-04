import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ExternalLink, Plus, Trash2, Unplug } from 'lucide-react';
import type { GithubManifestDto } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { ValueField } from '../../components/Copy.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Avatar, Badge, Button, ButtonLink, Callout, EmptyState, Field, GithubMark, Input, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useBootstrap, useGithub } from '../../lib/queries.ts';
import { SettingsSection } from './SettingsLayout.tsx';

export function GitPage() {
  const { m, t } = useI18n();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const github = useGithub();
  const bootstrap = useBootstrap();
  const isInstanceAdmin = bootstrap.data?.user?.isInstanceAdmin === true;
  const [organization, setOrganization] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const [manifest, setManifest] = useState<GithubManifestDto | null>(null);

  const createApp = useAction((org: string) => api.post<GithubManifestDto>('/api/github/manifest', { organization: org.trim().length > 0 ? org.trim() : null }), {
    onSuccess: (result) => {
      setManifest(result);
      // The manifest must be POSTed by the browser itself: GitHub creates the app in the user's session.
      window.setTimeout(() => formRef.current?.submit(), 0);
    },
  });
  const install = useAction(() => api.post<{ url: string }>('/api/github/install'), { onSuccess: (result) => window.location.assign(result.url) });
  const removeInstallation = useAction((id: number) => api.delete(`/api/github/installations/${id}`), { invalidate: [keys.github] });
  const disconnect = useAction(() => api.delete('/api/github'), { invalidate: [keys.github, keys.bootstrap] });

  const result = params.get('github') as keyof typeof m.git.results | null;
  const data = github.data;
  if (data === undefined) return <Skeleton height={300} />;

  return (
    <>
      {result !== null && m.git.results[result] !== undefined && <Callout tone={result === 'installed' ? 'ok' : 'bad'}>{m.git.results[result]}</Callout>}
      {!data.configured ? (
        <SettingsSection title={m.git.title} hint={m.git.subtitle}>
          <EmptyState icon={<GithubMark size={20} />} title={m.git.notConfiguredTitle}>
            {m.git.notConfiguredText}
          </EmptyState>
          {data.webhookUrl !== null && !data.publicUrlReady && <Callout tone="work">{t(m.git.publicUrlWarning, { url: data.webhookUrl })}</Callout>}
          {isInstanceAdmin && (
            <>
              <Field label={m.git.organization} optional={m.common.optional} hint={m.git.organizationHint}>
                <Input value={organization} onChange={(event) => setOrganization(event.target.value)} placeholder="my-company" spellCheck={false} />
              </Field>
              <div>
                <Button variant="primary" icon={<GithubMark />} busy={createApp.isPending} onClick={() => createApp.mutate(organization)}>
                  {m.git.createApp}
                </Button>
              </div>
              {manifest !== null && (
                <form ref={formRef} method="post" action={manifest.action} hidden>
                  <input type="hidden" name="manifest" value={manifest.manifest} />
                </form>
              )}
            </>
          )}
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title={m.git.app} hint={m.git.subtitle}>
            <div className="row wrap">
              <GithubMark size={18} />
              <span style={{ fontWeight: 600 }}>{data.app?.name}</span>
              <Badge>{data.app?.owner}</Badge>
              <ButtonLink href={data.app?.htmlUrl ?? '#'} external size="sm" variant="ghost" icon={<ExternalLink />}>
                {m.git.manageOnGithub}
              </ButtonLink>
            </div>
            {data.webhookUrl !== null && (
              <Field label={m.git.webhook}>
                <ValueField value={data.webhookUrl} />
              </Field>
            )}
          </SettingsSection>
          <SettingsSection title={m.git.installations} hint={m.git.installationsHint}>
            {data.installations.length === 0 ? (
              <p className="muted">{m.git.noInstallations}</p>
            ) : (
              <div className="list">
                {data.installations.map((installation) => (
                  <div key={installation.id} className="list__row">
                    <Avatar name={installation.accountLogin} src={installation.avatarUrl} size={32} />
                    <div className="grow">
                      <div className="list__title">{installation.accountLogin}</div>
                      <div className="list__meta">
                        <span>{installation.repositorySelection === 'all' ? m.git.allRepositories : m.git.selectedRepositories}</span>
                        <RelativeTime value={installation.createdAt} />
                      </div>
                    </div>
                    <ButtonLink
                      href={installation.accountType === 'Organization' ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.id}` : `https://github.com/settings/installations/${installation.id}`}
                      external
                      size="sm"
                      variant="ghost"
                      icon={<ExternalLink />}
                    >
                      {m.git.manageOnGithub}
                    </ButtonLink>
                    <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => removeInstallation.mutate(installation.id)}>
                      {m.git.removeInstallation}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Button icon={<Plus />} busy={install.isPending} onClick={() => install.mutate()}>
                {m.git.install}
              </Button>
            </div>
          </SettingsSection>
          {isInstanceAdmin && (
            <SettingsSection title={m.appSettings.danger}>
              <div>
                <Button
                  variant="danger"
                  icon={<Unplug />}
                  onClick={async () => {
                    const outcome = await confirm({ title: m.git.disconnect, text: m.git.disconnectText, confirmLabel: m.git.disconnect, danger: true });
                    if (outcome.confirmed) disconnect.mutate();
                  }}
                >
                  {m.git.disconnect}
                </Button>
              </div>
            </SettingsSection>
          )}
        </>
      )}
    </>
  );
}
