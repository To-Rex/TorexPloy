/**
 * Saying yes (or no) to something outside the dashboard that wants in:
 * an app connecting over OAuth (claude.ai, Claude Desktop, Cursor, VS Code…),
 * or the `torex` command line signing in from a terminal.
 *
 * Both pages show what asks, where it goes back to, the team it would act in
 * and how far it may reach, and warn where a look-alike could hide.
 */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Plug, SquareTerminal, TriangleAlert } from 'lucide-react';
import { CLI_USER_CODE_RE, roleAtLeast, type CliLoginRequestDto, type ConnectRedirectDto, type ConnectRequestDto, type ConnectTeamDto, type TokenAccess } from '@ploy/shared';
import { Button, ButtonLink, Callout, Field, Input, Select, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { errorText } from '../../lib/errors.ts';
import { AuthLayout } from '../auth/AuthLayout.tsx';
import { AccessChoice } from '../../components/AccessChoice.tsx';
import '../../components/connect.css';

function TeamField({ teams, value, onChange }: { teams: ConnectTeamDto[]; value: string; onChange: (value: string) => void }) {
  const { m } = useI18n();
  return (
    <Field label={m.mcp.connect.team}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name} · {m.roles[team.role]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function defaultTeam(teams: ConnectTeamDto[], current: string | null): string {
  const usable = teams.filter((team) => roleAtLeast(team.role, 'developer'));
  return usable.find((team) => team.id === current)?.id ?? usable[0]?.id ?? teams[0]?.id ?? '';
}

export function ConnectAppPage() {
  const { m, t } = useI18n();
  const c = m.mcp.connect;
  const { id = '' } = useParams();
  const request = useQuery({ queryKey: ['connect', id], queryFn: () => api.get<ConnectRequestDto>(`/api/connect/${id}`), retry: false, staleTime: Infinity });
  const [team, setTeam] = useState('');
  const [access, setAccess] = useState<TokenAccess>('write');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);

  useEffect(() => {
    if (request.data === undefined) return;
    setTeam(defaultTeam(request.data.teams, request.data.currentTeamId));
    if (request.data.requestedAccess !== null) setAccess(request.data.requestedAccess);
  }, [request.data]);

  const answer = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    setFailure(null);
    try {
      const result = approve ? await api.post<ConnectRedirectDto>(`/api/connect/${id}/approve`, { teamId: team, access }) : await api.post<ConnectRedirectDto>(`/api/connect/${id}/deny`);
      setLeaving(approve ? c.redirecting : c.denied);
      window.location.assign(result.redirect);
    } catch (error) {
      setFailure(errorText(m, error));
      setBusy(null);
    }
  };

  const data = request.data;
  const chosen = data?.teams.find((candidate) => candidate.id === team);
  const roleTooLow = chosen !== undefined && !roleAtLeast(chosen.role, 'developer');
  return (
    <AuthLayout>
      <div className="auth__form connect">
        {request.isPending ? (
          <Skeleton height={260} />
        ) : request.isError || data === undefined ? (
          <>
            <h2>{m.mcp.invalid.title}</h2>
            <Callout tone="bad">{request.error === null ? c.expired : errorText(m, request.error)}</Callout>
            <ButtonLink href="/">{m.mcp.invalid.back}</ButtonLink>
          </>
        ) : leaving !== null ? (
          <Callout tone="ok">{leaving}</Callout>
        ) : (
          <>
            <div className="connect__mark" aria-hidden="true">
              <Plug />
            </div>
            <h2>{t(c.title, { app: data.client.name })}</h2>
            <p>{c.lead}</p>
            <div className="connect__facts">
              <span>{c.returns}</span>
              <strong>{data.redirectHost}</strong>
              {data.client.uri !== null && (
                <a href={data.client.uri} target="_blank" rel="noreferrer noopener">
                  {data.client.uri}
                </a>
              )}
            </div>
            {data.warnings.map((warning) => (
              <Callout key={warning} tone="work">
                {c.warnings[warning]}
              </Callout>
            ))}
            <TeamField teams={data.teams} value={team} onChange={setTeam} />
            {roleTooLow && <Callout tone="bad">{c.viewerRole}</Callout>}
            <Field label={m.mcp.accessLabel}>
              <AccessChoice value={access} onChange={setAccess} />
            </Field>
            {failure !== null && <Callout tone="bad">{failure}</Callout>}
            <div className="connect__actions">
              <Button variant="primary" busy={busy === 'approve'} disabled={busy !== null || roleTooLow || team.length === 0} onClick={() => void answer(true)}>
                {c.approve}
              </Button>
              <Button busy={busy === 'deny'} disabled={busy !== null} onClick={() => void answer(false)}>
                {c.deny}
              </Button>
            </div>
            <p className="faint connect__small">{c.later}</p>
          </>
        )}
      </div>
    </AuthLayout>
  );
}

export function ConnectCliPage() {
  const { m } = useI18n();
  const c = m.mcp.cli;
  const [params, setParams] = useSearchParams();
  const code = (params.get('code') ?? '').toUpperCase();
  const valid = CLI_USER_CODE_RE.test(code);
  const [typed, setTyped] = useState('');
  const request = useQuery({ queryKey: ['cli-login', code], queryFn: () => api.get<CliLoginRequestDto>(`/api/cli/requests/${code}`), enabled: valid, retry: false, staleTime: Infinity });
  const [team, setTeam] = useState('');
  const [access, setAccess] = useState<TokenAccess>('full');
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  useEffect(() => {
    if (request.data !== undefined) setTeam(defaultTeam(request.data.teams, request.data.currentTeamId));
  }, [request.data]);

  const answer = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    setFailure(null);
    try {
      await api.post('/api/cli/requests', { userCode: code, teamId: team, access, approve });
      setDone(approve ? 'approved' : 'denied');
    } catch (error) {
      setFailure(errorText(m, error));
    } finally {
      setBusy(null);
    }
  };

  const data = request.data;
  const chosen = data?.teams.find((candidate) => candidate.id === team);
  const roleTooLow = chosen !== undefined && !roleAtLeast(chosen.role, 'developer');
  return (
    <AuthLayout>
      <div className="auth__form connect">
        <div className="connect__mark" aria-hidden="true">
          {done === 'approved' ? <CheckCircle2 /> : <SquareTerminal />}
        </div>
        <h2>{c.title}</h2>
        {!valid ? (
          <form
            className="stack"
            style={{ gap: 12 }}
            onSubmit={(event) => {
              event.preventDefault();
              const normal = typed.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');
              if (CLI_USER_CODE_RE.test(normal)) setParams({ code: normal });
            }}
          >
            <Field label={c.enterCode}>
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="ABCD-EFGH" autoFocus autoComplete="off" spellCheck={false} className="connect__code-input" />
            </Field>
            <Button type="submit" variant="primary">
              {c.continue}
            </Button>
          </form>
        ) : done !== null ? (
          <Callout tone={done === 'approved' ? 'ok' : 'idle'}>{done === 'approved' ? c.approved : c.denied}</Callout>
        ) : request.isPending ? (
          <Skeleton height={200} />
        ) : request.isError || data === undefined ? (
          <Callout tone="bad">{errorText(m, request.error)}</Callout>
        ) : (
          <>
            <p>{c.lead}</p>
            <div className="connect__code" aria-label={c.code}>
              {data.userCode}
            </div>
            <p className="faint connect__small">{c.codeCheck}</p>
            <div className="connect__facts">
              <span>{c.computer}</span>
              <strong>{data.name}</strong>
              <span className="faint">
                {data.client ?? 'torex'} · {data.ip}
              </span>
            </div>
            <Callout tone="work">{c.warning}</Callout>
            <TeamField teams={data.teams} value={team} onChange={setTeam} />
            {roleTooLow && <Callout tone="bad">{m.mcp.connect.viewerRole}</Callout>}
            <Field label={m.mcp.accessLabel}>
              <AccessChoice value={access} onChange={setAccess} />
            </Field>
            {failure !== null && <Callout tone="bad">{failure}</Callout>}
            <div className="connect__actions">
              <Button variant="primary" busy={busy === 'approve'} disabled={busy !== null || roleTooLow || team.length === 0} onClick={() => void answer(true)}>
                {m.mcp.connect.approve}
              </Button>
              <Button busy={busy === 'deny'} disabled={busy !== null} onClick={() => void answer(false)}>
                {m.mcp.connect.deny}
              </Button>
            </div>
          </>
        )}
      </div>
    </AuthLayout>
  );
}

export function ConnectInvalidPage() {
  const { m } = useI18n();
  const [params] = useSearchParams();
  const reason = params.get('reason') ?? 'client';
  const reasons = m.mcp.invalid.reasons as Record<string, string>;
  return (
    <AuthLayout>
      <div className="auth__form connect">
        <div className="connect__mark" data-tone="bad" aria-hidden="true">
          <TriangleAlert />
        </div>
        <h2>{m.mcp.invalid.title}</h2>
        <Callout tone="bad">{reasons[reason] ?? reasons.client}</Callout>
        <ButtonLink href="/">{m.mcp.invalid.back}</ButtonLink>
      </div>
    </AuthLayout>
  );
}
