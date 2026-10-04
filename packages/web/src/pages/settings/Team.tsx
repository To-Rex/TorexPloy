import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Link2, Mail, Plus, Trash2, UserMinus } from 'lucide-react';
import { createTeamSchema, inviteMemberSchema, roleAtLeast, TEAM_ROLES, type InvitationDto, type TeamDto, type TeamRole } from '@ploy/shared';
import { CopyButton } from '../../components/Copy.tsx';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { RelativeTime } from '../../components/Time.tsx';
import { Avatar, Badge, Button, Field, Input, Select, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useBootstrap, useInvitations, useMembers, useTeam } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';
import { SettingsSection } from './SettingsLayout.tsx';

export function TeamPage() {
  const { m, t } = useI18n();
  const confirm = useConfirm();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const bootstrap = useBootstrap();
  const team = useTeam();
  const role = team.data?.role ?? 'viewer';
  const isAdmin = roleAtLeast(role, 'admin');
  const members = useMembers();
  const invitations = useInvitations(isAdmin);
  const me = bootstrap.data?.user;

  const [name, setName] = useState('');
  useEffect(() => {
    if (team.data !== undefined) setName(team.data.name);
  }, [team.data]);
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState<{ email: string; role: TeamRole }>({ email: '', role: 'developer' });
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const [newName, setNewName] = useState('');

  const rename = useAction((value: string) => api.patch('/api/team', { name: value }), { success: m.common.saved, invalidate: [keys.team, keys.bootstrap] });
  const sendInvite = useAction((input: { email: string; role: TeamRole }) => api.post<InvitationDto>('/api/team/invitations', input), {
    invalidate: [keys.invitations],
    inlineValidation: true,
    onSuccess: (result) => setInviteLink(result.link ?? null),
  });
  const revokeInvite = useAction((id: string) => api.delete(`/api/team/invitations/${id}`), { invalidate: [keys.invitations] });
  // A fresh link for a pending invitation (the token is stored hashed, so the old one cannot be shown again).
  const relink = useAction((id: string) => api.post<InvitationDto>(`/api/team/invitations/${id}/link`), {
    invalidate: [keys.invitations],
    onSuccess: (result) => {
      setInviteErrors({});
      setInviteLink(result.link ?? null);
      setInviting(true);
    },
  });
  const setRole = useAction((input: { userId: string; role: TeamRole }) => api.patch(`/api/team/members/${input.userId}`, { role: input.role }), { success: m.team.roleChanged, invalidate: [keys.members] });
  const removeMember = useAction((userId: string) => api.delete(`/api/team/members/${userId}`), {
    success: m.team.removed,
    invalidate: [keys.members],
  });
  const createTeam = useAction((value: string) => api.post<TeamDto>('/api/teams', { name: value }), {
    success: m.team.created,
    onSuccess: () => {
      client.clear();
      void navigate('/');
    },
  });
  const deleteTeam = useAction(() => api.delete('/api/team'), {
    success: m.team.deleted,
    onSuccess: () => {
      client.clear();
      void navigate('/');
    },
  });

  if (team.data === undefined) return <Skeleton height={300} />;
  const roleOptions = TEAM_ROLES.filter((candidate) => candidate !== 'owner' || role === 'owner').slice().reverse();

  return (
    <>
      <SettingsSection title={m.team.title}>
        <form
          className="row"
          style={{ alignItems: 'flex-end' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) rename.mutate(name.trim());
          }}
        >
          <Field label={m.team.name} className="grow">
            <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!isAdmin} />
          </Field>
          {isAdmin && name.trim() !== team.data.name && (
            <Button type="submit" variant="primary" busy={rename.isPending}>
              {m.common.save}
            </Button>
          )}
        </form>
      </SettingsSection>

      <SettingsSection title={m.team.members} hint={m.team.membersHint}>
        {isAdmin && (
          <div>
            <Button variant="primary" icon={<Plus />} onClick={() => { setInviteLink(null); setInviteErrors({}); setInviting(true); }}>
              {m.team.invite}
            </Button>
          </div>
        )}
        <div className="list">
          {(members.data ?? []).map((member) => {
            const self = member.userId === me?.id;
            const canEdit = isAdmin && !self && (member.role !== 'owner' || role === 'owner');
            return (
              <div key={member.userId} className="list__row">
                <Avatar name={member.name} src={member.avatarUrl} size={32} />
                <div className="grow">
                  <div className="row">
                    <span className="list__title truncate">{member.name}</span>
                    {self && <Badge>{m.common.you}</Badge>}
                  </div>
                  <div className="list__meta">
                    <span>{member.email}</span>
                  </div>
                </div>
                {canEdit ? (
                  <Select value={member.role} onChange={(event) => setRole.mutate({ userId: member.userId, role: event.target.value as TeamRole })} style={{ width: 160 }} aria-label={m.team.role}>
                    {roleOptions.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {m.roles[candidate]}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone={member.role === 'owner' ? 'info' : undefined}>{m.roles[member.role]}</Badge>
                )}
                {(canEdit || self) && (
                  <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<Ellipsis />}>{m.common.actions}</Button>}>
                    <MenuItem
                      icon={<UserMinus />}
                      danger
                      onSelect={async () => {
                        const result = await confirm({ title: self ? m.team.leave : m.team.removeMember, text: t(m.team.removeConfirm, { name: member.name }), confirmLabel: self ? m.team.leave : m.team.removeMember, danger: true });
                        if (!result.confirmed) return;
                        removeMember.mutate(member.userId, {
                          onSuccess: () => {
                            if (self) {
                              client.clear();
                              void navigate('/');
                            }
                          },
                        });
                      }}
                    >
                      {self ? m.team.leave : m.team.removeMember}
                    </MenuItem>
                  </Menu>
                )}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      {isAdmin && (invitations.data ?? []).length > 0 && (
        <SettingsSection title={m.team.invitations}>
          <div className="list">
            {invitations.data!.map((invitation) => (
              <div key={invitation.id} className="list__row">
                <Mail width={18} height={18} className="faint" aria-hidden="true" />
                <div className="grow">
                  <div className="list__title">{invitation.email}</div>
                  <div className="list__meta">
                    <span>{m.roles[invitation.role]}</span>
                    <span>
                      {t(m.team.expires, { time: '' })}
                      <RelativeTime value={invitation.expiresAt} />
                    </span>
                  </div>
                </div>
                <Button size="sm" icon={<Link2 />} busy={relink.isPending && relink.variables === invitation.id} onClick={() => relink.mutate(invitation.id)}>
                  {m.team.getLink}
                </Button>
                <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => revokeInvite.mutate(invitation.id)}>
                  {m.team.revokeInvitation}
                </Button>
              </div>
            ))}
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={m.team.newTeam}>
        <div>
          <Button icon={<Plus />} onClick={() => setCreating(true)}>
            {m.team.newTeam}
          </Button>
        </div>
      </SettingsSection>

      {role === 'owner' && (
        <SettingsSection title={m.appSettings.danger} hint={m.team.deleteText}>
          <div>
            <Button
              variant="danger"
              icon={<Trash2 />}
              onClick={async () => {
                const result = await confirm({ title: m.team.deleteTitle, text: m.team.deleteText, confirmLabel: m.common.delete, danger: true, typeToConfirm: team.data!.name });
                if (result.confirmed) deleteTeam.mutate();
              }}
            >
              {m.team.deleteTitle}
            </Button>
          </div>
        </SettingsSection>
      )}

      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        title={m.team.inviteTitle}
        onSubmit={() => {
          if (inviteLink !== null) {
            setInviting(false);
            return;
          }
          const result = validate(m, inviteMemberSchema, invite);
          if (result.errors !== null) {
            setInviteErrors(result.errors);
            return;
          }
          sendInvite.mutate(result.data, { onError: (error) => setInviteErrors(fieldErrors(m, error)) });
        }}
        footer={
          inviteLink === null ? (
            <>
              <Button onClick={() => setInviting(false)}>{m.common.cancel}</Button>
              <Button type="submit" variant="primary" busy={sendInvite.isPending}>
                {m.team.invite}
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary">
              {m.common.close}
            </Button>
          )
        }
      >
        {inviteLink === null ? (
          <div className="stack">
            <Field label={m.team.email} error={inviteErrors.email}>
              <Input type="email" value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} autoFocus />
            </Field>
            <Field label={m.team.role} hint={m.roleHints[invite.role]}>
              <Select value={invite.role} onChange={(event) => setInvite({ ...invite, role: event.target.value as TeamRole })}>
                {roleOptions.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {m.roles[candidate]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <Field label={m.team.inviteLink} hint={m.team.inviteLinkHint}>
            <div className="secret-field">
              <Link2 width={14} height={14} className="faint" aria-hidden="true" />
              <span>{inviteLink}</span>
              <CopyButton value={inviteLink} />
            </div>
          </Field>
        )}
      </Dialog>

      <Dialog
        open={creating}
        onClose={() => {
          setCreating(false);
          if (params.has('new')) setParams({}, { replace: true });
        }}
        title={m.team.newTeam}
        onSubmit={() => {
          const result = validate(m, createTeamSchema, { name: newName });
          if (result.errors === null) createTeam.mutate(result.data.name);
        }}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={createTeam.isPending} disabled={newName.trim().length === 0}>
              {m.common.create}
            </Button>
          </>
        }
      >
        <Field label={m.team.newTeamName}>
          <Input value={newName} onChange={(event) => setNewName(event.target.value)} autoFocus />
        </Field>
      </Dialog>
    </>
  );
}
