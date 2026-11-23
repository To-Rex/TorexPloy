/**
 * CLI and MCP: how to connect AI agents and the `torex` command line, what is
 * connected, what the connected apps did (with undo), and, for the instance
 * administrator, the switches of the MCP server.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, KeyRound, Plug, ShieldCheck, SquareTerminal, Undo2, Unplug } from 'lucide-react';
import { type ApiTokenDto, type McpActivityDto, type McpConnectionDto, type McpOverviewDto, type McpSettingsDto, type TokenAccess } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Badge, Button, Callout, EmptyState, Field, Input, Segmented, Select, Skeleton, Switch } from '../../components/ui.tsx';
import { AccessChoice } from '../../components/AccessChoice.tsx';
import '../../components/connect.css';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { useBootstrap } from '../../lib/queries.ts';

const KEY = ['mcp'] as const;
type Client = 'claudeCode' | 'claude' | 'cursor' | 'vscode' | 'others';
type Platform = 'unix' | 'windows' | 'npm';

function Code({ children }: { children: string }) {
  return (
    <div className="codeblock">
      {children}
      <CopyButton value={children} />
    </div>
  );
}

function Step({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="mcp-step">
      <p>{text}</p>
      {children}
    </div>
  );
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** The snippets for one client: by signing in (OAuth), or with a token when there is one. */
function ClientSetup({ client, endpoint, token }: { client: Client; endpoint: string; token: string | null }) {
  const { m } = useI18n();
  const s = m.mcp;
  const header = token === null ? null : `Bearer ${token}`;
  switch (client) {
    case 'claudeCode':
      return (
        <>
          <Step text={header === null ? s.claudeCodeStep : s.runIt}>
            <Code>{`claude mcp add --transport http torexploy ${endpoint}${header === null ? '' : ` --header "Authorization: ${header}"`}`}</Code>
          </Step>
          <Step text={s.claudeCodeCli}>
            <Code>claude mcp add torexploy -- torex mcp</Code>
          </Step>
        </>
      );
    case 'claude':
      return (
        <>
          <Step text={s.claudeStep}>
            <Code>{endpoint}</Code>
          </Step>
          <Step text={s.claudeDesktop}>
            <Code>{json({ mcpServers: { torexploy: { command: 'torex', args: ['mcp'] } } })}</Code>
          </Step>
        </>
      );
    case 'cursor':
      return (
        <Step text={header === null ? s.cursorStep : s.cursorFile}>
          <Code>{json({ mcpServers: { torexploy: { url: endpoint, ...(header === null ? {} : { headers: { Authorization: header } }) } } })}</Code>
        </Step>
      );
    case 'vscode':
      return (
        <Step text={header === null ? s.vscodeStep : s.vscodeFile}>
          <Code>{json({ servers: { torexploy: { type: 'http', url: endpoint, ...(header === null ? {} : { headers: { Authorization: header } }) } } })}</Code>
        </Step>
      );
    default:
      return (
        <>
          <Step text={s.otherStep}>
            <Code>{json({ mcpServers: { torexploy: { command: 'torex', args: ['mcp'] } } })}</Code>
          </Step>
          <Step text={s.otherHttp}>
            <Code>{header === null ? endpoint : `${endpoint}\nAuthorization: ${header}`}</Code>
          </Step>
        </>
      );
  }
}


function TokenDialog({ open, onClose, endpoint }: { open: boolean; onClose: () => void; endpoint: string }) {
  const { m } = useI18n();
  const s = m.mcp;
  const [client, setClient] = useState('');
  const [access, setAccess] = useState<TokenAccess>('write');
  const [expiry, setExpiry] = useState<'30' | '90' | '365' | 'never'>('90');
  const [created, setCreated] = useState<string | null>(null);
  const [target, setTarget] = useState<Client>('cursor');
  const create = useAction((input: { client: string; access: TokenAccess; expiresInDays: number | null }) => api.post<ApiTokenDto>('/api/mcp/tokens', input), {
    invalidate: [KEY],
    onSuccess: (token) => setCreated(token.token ?? null),
  });
  const close = () => {
    setCreated(null);
    setClient('');
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={created === null ? s.tokenTitle : s.tokenCreated}
      description={created === null ? s.tokenHint : undefined}
      onSubmit={() => {
        if (created !== null) return close();
        if (client.trim().length === 0) return;
        create.mutate({ client: client.trim(), access, expiresInDays: expiry === 'never' ? null : Number(expiry) });
      }}
      footer={
        created === null ? (
          <>
            <Button onClick={close}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={create.isPending} disabled={client.trim().length === 0}>
              {s.tokenCreate}
            </Button>
          </>
        ) : (
          <Button type="submit" variant="primary">
            {m.common.close}
          </Button>
        )
      }
    >
      {created === null ? (
        <div className="stack" style={{ gap: 14 }}>
          <Field label={s.tokenClient}>
            <Input value={client} maxLength={60} placeholder={s.tokenClientPlaceholder} onChange={(event) => setClient(event.target.value)} autoFocus />
          </Field>
          <Field label={s.accessLabel}>
            <AccessChoice value={access} onChange={setAccess} />
          </Field>
          <Field label={m.tokens.expires}>
            <Select value={expiry} onChange={(event) => setExpiry(event.target.value as typeof expiry)}>
              {(['30', '90', '365', 'never'] as const).map((value) => (
                <option key={value} value={value}>
                  {m.tokens.expiry[value]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <Callout tone="work">{m.tokens.createdText}</Callout>
          <Code>{created}</Code>
          <p className="field__label">{s.tokenSnippets}</p>
          <Segmented label={s.tokenSnippets} value={target} onChange={setTarget} options={(['claudeCode', 'cursor', 'vscode', 'others'] as const).map((value) => ({ value, label: s.clients[value] }))} />
          <ClientSetup client={target} endpoint={endpoint} token={created} />
        </div>
      )}
    </Dialog>
  );
}

const KIND_ICON: Record<McpConnectionDto['kind'], ReactNode> = { oauth: <Plug aria-hidden="true" />, cli: <SquareTerminal aria-hidden="true" />, api: <KeyRound aria-hidden="true" /> };

function Connections({ connections }: { connections: McpConnectionDto[] }) {
  const { m, t } = useI18n();
  const s = m.mcp;
  const confirm = useConfirm();
  const remove = useAction((id: string) => api.delete(`/api/mcp/connections/${encodeURIComponent(id)}`), { invalidate: [KEY], success: s.disconnected });
  if (connections.length === 0) return <EmptyState icon={<Unplug />}>{s.connectionsEmpty}</EmptyState>;
  return (
    <div className="list">
      {connections.map((connection) => (
        <div key={connection.id} className="list__row">
          <span className="mcp-icon" data-kind={connection.kind}>
            {KIND_ICON[connection.kind]}
          </span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="list__title">
              {connection.name} <Badge tone={connection.access === 'full' ? 'work' : connection.access === 'write' ? 'info' : 'idle'}>{s.access[connection.access]}</Badge>
            </div>
            <div className="list__meta">
              <span>{s.kinds[connection.kind]}</span>
              {connection.redirectHost !== null && <span>{t(s.returnsTo, { host: connection.redirectHost })}</span>}
              {!connection.mine && <span>{t(s.of, { name: connection.userName })}</span>}
              <span>{connection.lastUsedAt === null ? s.neverUsed : <>{t(s.lastUsed, { time: '' })}<RelativeTime value={connection.lastUsedAt} /></>}</span>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={<Unplug />}
            onClick={async () => {
              const answer = await confirm({ title: t(s.disconnectTitle, { name: connection.name }), text: s.disconnectText, confirmLabel: s.disconnect, danger: true });
              if (answer.confirmed) remove.mutate(connection.id);
            }}
          >
            {s.disconnect}
          </Button>
        </div>
      ))}
    </div>
  );
}

function Activity({ activity }: { activity: McpActivityDto[] }) {
  const { m } = useI18n();
  const s = m.mcp;
  const undo = useAction((id: string) => api.post(`/api/mcp/activity/${id}/undo`), { invalidate: [KEY], success: s.undone });
  if (activity.length === 0) return <EmptyState icon={<Bot />}>{s.activityEmpty}</EmptyState>;
  return (
    <div className="list">
      {activity.map((step) => (
        <div key={step.id} className="list__row mcp-step-row">
          <span className="mcp-dot" data-status={step.status} aria-label={m.ai.status[step.status]} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="list__title truncate">{step.title.length > 0 ? step.title : m.ai.tools[step.tool]}</div>
            <div className="list__meta">
              <Badge tone="idle">{step.client}</Badge>
              {step.detail.length > 0 && <code className="truncate">{step.detail}</code>}
              <span>{m.ai.status[step.status]}</span>
              <RelativeTime value={step.createdAt} />
            </div>
          </div>
          {step.undoable && (
            <Button size="sm" variant="ghost" icon={<Undo2 />} busy={undo.isPending && undo.variables === step.id} onClick={() => undo.mutate(step.id)}>
              {s.undo}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function McpPage() {
  const { m } = useI18n();
  const s = m.mcp;
  const bootstrap = useBootstrap();
  const overview = useQuery({ queryKey: KEY, queryFn: () => api.get<McpOverviewDto>('/api/mcp'), refetchInterval: 15_000 });
  const [client, setClient] = useState<Client>('claudeCode');
  const [platform, setPlatform] = useState<Platform>(() => (typeof navigator !== 'undefined' && /win/i.test(navigator.platform) ? 'windows' : 'unix'));
  const [tokenOpen, setTokenOpen] = useState(false);
  const save = useAction((patch: Partial<McpSettingsDto>) => api.put<McpSettingsDto>('/api/mcp/settings', patch), { invalidate: [KEY], success: m.common.saved });

  if (overview.isError) return <Callout tone="bad">{m.errors.network}</Callout>;
  const data = overview.data;
  if (data === undefined) return <Skeleton height={260} />;
  const admin = bootstrap.data?.user?.isInstanceAdmin === true;
  const install = { unix: `curl -fsSL ${data.origin}/cli/install.sh | sh`, windows: `irm ${data.origin}/cli/install.ps1 | iex`, npm: `npm install -g ${data.origin}/cli/torexploy-cli.tgz` }[platform];
  const commands: [string, string][] = [
    ['torex link', s.cliCommandList.link],
    ['torex deploy', s.cliCommandList.deploy],
    ['torex up', s.cliCommandList.up],
    ['torex logs -f', s.cliCommandList.logs],
    ['torex env pull', s.cliCommandList.env],
    ['torex ai "…"', s.cliCommandList.ai],
    ['torex mcp', s.cliCommandList.mcp],
  ];

  return (
    <>
      <Card icon={<Bot />} title={s.heroTitle} description={s.heroText} actions={data.canConnect ? <Button icon={<KeyRound />} onClick={() => setTokenOpen(true)}>{s.tokenCreate}</Button> : undefined}>
        <div className="stack" style={{ gap: 16 }}>
          {!data.settings.enabled && <Callout tone="work">{s.enabledHint}</Callout>}
          <Field label={s.endpoint} hint={s.endpointHint}>
            <Code>{data.endpoint}</Code>
          </Field>
          <Segmented label={s.heroTitle} value={client} onChange={setClient} options={(['claudeCode', 'claude', 'cursor', 'vscode', 'others'] as const).map((value) => ({ value, label: s.clients[value] }))} />
          <div className="stack" style={{ gap: 12 }}>
            <ClientSetup client={client} endpoint={data.endpoint} token={null} />
          </div>
          <Callout tone="info" title={s.safetyTitle}>
            {s.safetyText}
          </Callout>
        </div>
      </Card>

      <Card icon={<SquareTerminal />} title={s.cliTitle} description={s.cliText}>
        <div className="stack" style={{ gap: 14 }}>
          {data.cliVersion === null && <Callout tone="work">{s.cliMissing}</Callout>}
          <Segmented label={s.cliTitle} value={platform} onChange={setPlatform} options={(['unix', 'windows', 'npm'] as const).map((value) => ({ value, label: s.cliInstall[value] }))} />
          <Code>{install}</Code>
          <p className="faint" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{s.cliNeedsNode}</p>
          <Step text={s.cliLogin}>
            <Code>{`torex login ${data.origin}`}</Code>
          </Step>
          <div>
            <p className="field__label">{s.cliCommands}</p>
            <div className="mcp-commands">
              {commands.map(([command, what]) => (
                <div key={command}>
                  <code>{command}</code>
                  <span>{what}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card icon={<Plug />} title={s.connectionsTitle} description={s.connectionsHint} flush={data.connections.length > 0}>
        <Connections connections={data.connections} />
      </Card>

      <Card icon={<ShieldCheck />} title={s.activityTitle} description={s.activityHint} flush={data.activity.length > 0}>
        <Activity activity={data.activity} />
      </Card>

      {admin && (
        <Card title={s.settingsTitle}>
          <div className="stack" style={{ gap: 14 }}>
            <Switch checked={data.settings.enabled} onChange={(enabled) => save.mutate({ enabled })} label={s.enabled} hint={s.enabledHint} />
            <Switch checked={data.settings.oauth} disabled={!data.settings.enabled} onChange={(oauth) => save.mutate({ oauth })} label={s.oauth} hint={s.oauthHint} />
          </div>
        </Card>
      )}

      <TokenDialog open={tokenOpen} onClose={() => setTokenOpen(false)} endpoint={data.endpoint} />
    </>
  );
}
