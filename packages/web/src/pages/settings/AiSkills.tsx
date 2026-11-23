/**
 * TorexAi's skills, for the instance administrator: whether the assistant
 * may install the skill a job needs by itself, what is installed (and what it
 * installed on its own), the whole catalog, the GitHub repositories skills
 * come from, and skills written here.
 *
 * Most of the time nothing needs doing on this page: TorexAi finds and
 * installs what fits. It is here to see what happened, to switch a skill off,
 * and to read and allow the few skills whose text needs a person's eye.
 */
import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, Download, ExternalLink, FilePlus2, GraduationCap, MoreHorizontal, PenLine, Plus, RefreshCw, Search, ShieldAlert, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { AI_SKILL_LIMITS, AI_SKILL_SUGGESTED_SOURCES, SKILL_NAME_RE, skillRepo, SKILL_REPO_RE, type AiSkillDto, type AiSkillFlag, type AiSkillSourceDto } from '@ploy/shared';
import { useConfirm, Dialog } from '../../components/Dialog.tsx';
import { Card } from '../../components/Frame.tsx';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Callout, EmptyState, Field, GithubMark, Input, Segmented, Skeleton, SkeletonRows, Switch, Textarea } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { addAiSkillSource, aiKeys, fetchAiSkill, installAiSkill, removeAiSkill, removeAiSkillSource, saveAiSettings, saveAiSkill, setAiSkillEnabled, syncAiSkillSource, useAiSkill, useAiSkillCatalog, useAiSkills } from '../ai/aiApi.ts';
import { Markdown } from '../ai/Markdown.tsx';
import '../ai/ai.css';

type Filter = 'all' | 'builtin' | 'registry';

/** "server-hardening" → "Server hardening", for skills that carry no title of their own. */
function humanize(name: string): string {
  const spaced = name.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function useSkillText() {
  const { locale } = useI18n();
  return {
    title: (skill: AiSkillDto): string => skill.titles[locale] ?? skill.titles.en ?? humanize(skill.name),
    summary: (skill: AiSkillDto): string => skill.summaries[locale] ?? skill.summaries.en ?? skill.description,
  };
}

const repoOf = (skill: AiSkillDto): string | null => (skill.source === 'registry' && skill.origin !== null ? skill.origin.split(':')[0]! : null);

function githubUrl(skill: AiSkillDto): string | null {
  if (skill.source !== 'registry' || skill.origin === null) return null;
  const [repo, path = ''] = skill.origin.split(':');
  return `https://github.com/${repo}${path.length > 0 ? `/tree/HEAD/${path}` : ''}`;
}

function SourceIcon({ skill }: { skill: AiSkillDto }) {
  if (skill.source === 'registry') return <GithubMark size={16} />;
  if (skill.source === 'custom') return <PenLine aria-hidden="true" />;
  return <GraduationCap aria-hidden="true" />;
}

function useSourceLabel(): (skill: AiSkillDto) => string {
  const { m } = useI18n();
  return (skill) => (skill.source === 'registry' ? (repoOf(skill) ?? m.ai.skills.sourceRegistry) : skill.source === 'custom' ? m.ai.skills.sourceCustom : m.ai.skills.sourceBuiltin);
}

function Flags({ flags }: { flags: AiSkillFlag[] }) {
  const { m } = useI18n();
  if (flags.length === 0) return null;
  return (
    <Badge tone="work" icon={<ShieldAlert aria-hidden="true" />}>
      {flags.map((flag) => m.ai.skills.flags[flag].name).join(', ')}
    </Badge>
  );
}

/** One skill as a row: what it is for, where it is from, and what can be done with it. */
function SkillRow({ skill, children, onOpen }: { skill: AiSkillDto; children?: ReactNode; onOpen: () => void }) {
  const { m, t, plural, formatRelative } = useI18n();
  const text = useSkillText();
  const sourceLabel = useSourceLabel();
  return (
    <div className="tai-skill" data-off={(skill.installed && !skill.enabled) || undefined}>
      <span className="tai-skill__icon" data-source={skill.source}>
        <SourceIcon skill={skill} />
      </span>
      <div className="tai-skill__main">
        <button type="button" className="tai-skill__title" onClick={onOpen}>
          <strong>{text.title(skill)}</strong>
          <code>{skill.name}</code>
        </button>
        <p className="tai-skill__summary">{text.summary(skill)}</p>
        <div className="tai-skill__meta">
          <span>{sourceLabel(skill)}</span>
          {skill.installed && skill.auto && (
            <Badge tone="info" icon={<Wand2 aria-hidden="true" />}>
              {m.ai.skills.installedByAi}
            </Badge>
          )}
          {skill.updateAvailable && <Badge tone="ok">{m.ai.skills.updateAvailable}</Badge>}
          <Flags flags={skill.flags} />
          {skill.installed && skill.uses > 0 && (
            <span>
              {plural(m.ai.skills.uses, skill.uses)}
              {skill.lastUsedAt !== null && ` · ${t(m.ai.skills.lastUsed, { when: formatRelative(skill.lastUsedAt) })}`}
            </span>
          )}
        </div>
      </div>
      {children !== undefined && <div className="tai-skill__side">{children}</div>}
    </div>
  );
}

/** A skill read in full before it is installed or while deciding whether to keep it. */
function SkillDialog({ skillRef, onClose, onInstall, installing }: { skillRef: string | null; onClose: () => void; onInstall: (skill: AiSkillDto) => void; installing: boolean }) {
  const { m, t, formatBytes } = useI18n();
  const detail = useAiSkill(skillRef);
  const text = useSkillText();
  const sourceLabel = useSourceLabel();
  const skill = detail.data;
  const link = skill === undefined ? null : githubUrl(skill);
  return (
    <Dialog
      open={skillRef !== null}
      onClose={onClose}
      wide
      title={skill === undefined ? m.ai.skills.loading : text.title(skill)}
      description={skill === undefined ? undefined : text.summary(skill)}
      footer={
        <>
          <Button onClick={onClose}>{m.common.close}</Button>
          {skill !== undefined && !skill.installed && (
            <Button variant="primary" icon={<Download />} busy={installing} onClick={() => onInstall(skill)}>
              {m.ai.skills.install}
            </Button>
          )}
        </>
      }
    >
      {skill === undefined ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="tai-skill__meta">
            <span className="row" style={{ gap: 6 }}>
              <SourceIcon skill={skill} /> {sourceLabel(skill)}
            </span>
            <code>{skill.name}</code>
            <span>{formatBytes(skill.bytes)}</span>
            {link !== null && (
              <a className="row" style={{ gap: 4 }} href={link} target="_blank" rel="noreferrer noopener">
                GitHub <ExternalLink width={12} height={12} aria-hidden="true" />
              </a>
            )}
          </div>
          {skill.flags.length > 0 && (
            <Callout tone="work" title={m.ai.skills.flaggedTitle}>
              <ul className="tai-skill__flags">
                {skill.flags.map((flag) => (
                  <li key={flag}>
                    <strong>{m.ai.skills.flags[flag].name}.</strong> {m.ai.skills.flags[flag].text}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          {skill.files.length > 0 && (
            <p className="faint" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
              {t(m.ai.skills.files, { files: skill.files.join(', ') })}
            </p>
          )}
          <div className="stack" style={{ gap: 6 }}>
            <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>
              {m.ai.skills.bodyLabel}
            </span>
            <div className="tai-skill__body tai-md">
              <Markdown text={skill.body} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Writing a skill of this instance's own, or rewriting one. */
function CustomSkillDialog({ editing, open, onClose }: { editing: { name: string; description: string; body: string } | null; open: boolean; onClose: () => void }) {
  const { m } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [body, setBody] = useState(editing?.body ?? m.ai.skills.customBodyTemplate);
  const [saving, setSaving] = useState(false);
  const badName = name.length > 0 && !SKILL_NAME_RE.test(name);
  const ready = SKILL_NAME_RE.test(name) && description.trim().length >= 10 && body.trim().length >= 20;

  const save = async (): Promise<void> => {
    if (!ready) return;
    setSaving(true);
    try {
      const saved = await saveAiSkill({ name, description: description.trim(), body: body.trim() });
      toast.success(saved.flags.length > 0 ? m.ai.skills.savedFlagged : m.ai.skills.saved);
      void client.invalidateQueries({ queryKey: aiKeys.skills });
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={editing === null ? m.ai.skills.customNew : m.ai.skills.customEdit}
      description={m.ai.skills.customHint}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" busy={saving} disabled={!ready}>
            {m.common.save}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label={m.ai.skills.customName} hint={m.ai.skills.customNameHint} error={badName ? m.ai.skills.customNameBad : undefined}>
          <Input mono value={name} disabled={editing !== null} maxLength={64} placeholder="nightly-backup-check" onChange={(event) => setName(event.target.value.toLowerCase().replace(/[\s_]+/g, '-'))} data-autofocus />
        </Field>
        <Field label={m.ai.skills.customDescription} hint={m.ai.skills.customDescriptionHint}>
          <Textarea rows={2} maxLength={AI_SKILL_LIMITS.descriptionMax} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <Field label={m.ai.skills.customBody} hint={m.ai.skills.customBodyHint}>
          <Textarea mono rows={14} maxLength={AI_SKILL_LIMITS.bodyMax} value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function Sources({ sources }: { sources: AiSkillSourceDto[] }) {
  const { m, t, plural, formatRelative } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const client = useQueryClient();
  const [repo, setRepo] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: aiKeys.skills });
  };
  const normalized = skillRepo(repo);
  const valid = SKILL_REPO_RE.test(normalized);
  const suggested = AI_SKILL_SUGGESTED_SOURCES.filter((entry) => !sources.some((source) => source.repo.toLowerCase() === entry.repo.toLowerCase()));

  const add = async (value: string): Promise<void> => {
    setAdding(true);
    try {
      await addAiSkillSource(value);
      setRepo('');
      toast.success(m.ai.skills.sourceAdded);
      refresh();
    } catch (error) {
      toast.error(error);
    } finally {
      setAdding(false);
    }
  };
  const sync = async (source: AiSkillSourceDto): Promise<void> => {
    setBusy(source.id);
    try {
      const after = await syncAiSkillSource(source.id);
      if (after.error === null) toast.success(t(m.ai.skills.synced, { count: after.skills }));
      refresh();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (source: AiSkillSourceDto): Promise<void> => {
    const { confirmed } = await confirm({ title: t(m.ai.skills.sourceRemoveTitle, { repo: source.repo }), text: m.ai.skills.sourceRemoveText, confirmLabel: m.common.remove, danger: true });
    if (!confirmed) return;
    try {
      await removeAiSkillSource(source.id);
      refresh();
    } catch (error) {
      toast.error(error);
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      {sources.length === 0 ? (
        <p className="faint" style={{ margin: 0 }}>
          {m.ai.skills.sourcesEmpty}
        </p>
      ) : (
        <div className="tai-sources">
          {sources.map((source) => (
            <div key={source.id} className="tai-source">
              <span className="tai-skill__icon" data-source="registry">
                <GithubMark size={16} />
              </span>
              <div className="tai-skill__main">
                <a className="tai-skill__title" href={`https://github.com/${source.repo}`} target="_blank" rel="noreferrer noopener">
                  <strong>{source.repo}</strong>
                  {source.ref !== null && <code>{source.ref}</code>}
                  <ExternalLink width={12} height={12} aria-hidden="true" />
                </a>
                <div className="tai-skill__meta">
                  {source.syncing ? (
                    <span>{m.ai.skills.syncing}</span>
                  ) : source.syncedAt === null ? (
                    <span>{m.ai.skills.neverSynced}</span>
                  ) : (
                    <span>
                      {plural(m.ai.skills.skillCount, source.skills)} · {t(m.ai.skills.syncedAt, { when: formatRelative(source.syncedAt) })}
                    </span>
                  )}
                </div>
                {source.error !== null && !source.syncing && <p className="tai-source__error">{source.error}</p>}
              </div>
              <div className="tai-skill__side">
                <Button variant="ghost" size="sm" iconOnly icon={<RefreshCw />} busy={busy === source.id || source.syncing} onClick={() => void sync(source)}>
                  {m.ai.skills.syncNow}
                </Button>
                <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} onClick={() => void remove(source)}>
                  {m.common.remove}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <form
        className="row"
        style={{ gap: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void add(normalized);
        }}
      >
        <Input mono value={repo} placeholder={m.ai.skills.sourcePlaceholder} onChange={(event) => setRepo(event.target.value)} aria-label={m.ai.skills.sourceAdd} />
        <Button type="submit" icon={<Plus />} busy={adding} disabled={!valid}>
          {m.ai.skills.sourceAdd}
        </Button>
      </form>
      {suggested.length > 0 && (
        <div className="tai-skill__suggested">
          <span className="faint">{m.ai.skills.sourceSuggested}</span>
          {suggested.map((entry) => (
            <button key={entry.repo} type="button" disabled={adding} onClick={() => void add(entry.repo)} title={entry.about}>
              <Plus aria-hidden="true" />
              {entry.repo}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AiSkillsPage() {
  const { m, t, plural } = useI18n();
  const s = m.ai.skills;
  const toast = useToast();
  const confirm = useConfirm();
  const client = useQueryClient();
  const overview = useAiSkills();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim());
  const catalog = useAiSkillCatalog(deferred);
  const [filter, setFilter] = useState<Filter>('all');
  const [viewing, setViewing] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [custom, setCustom] = useState<{ open: boolean; editing: { name: string; description: string; body: string } | null; key: number }>({ open: false, editing: null, key: 0 });
  const [savingAuto, setSavingAuto] = useState(false);

  const shown = useMemo(() => (catalog.data ?? []).filter((skill) => filter === 'all' || skill.source === filter), [catalog.data, filter]);

  if (overview.isError) return <Callout tone="bad">{m.errors.codes.forbidden}</Callout>;
  const data = overview.data;
  if (data === undefined) return <Skeleton height={220} />;

  const refresh = (): void => {
    void client.invalidateQueries({ queryKey: aiKeys.skills });
  };

  const setAuto = async (on: boolean): Promise<void> => {
    setSavingAuto(true);
    try {
      await saveAiSettings({ skillsAuto: on ? 'trusted' : 'off' });
      refresh();
      void client.invalidateQueries({ queryKey: aiKeys.settings });
    } catch (error) {
      toast.error(error);
    } finally {
      setSavingAuto(false);
    }
  };

  const install = async (skill: AiSkillDto): Promise<void> => {
    if (skill.flags.length > 0) {
      const { confirmed } = await confirm({
        title: t(s.installFlaggedTitle, { name: skill.name }),
        text: (
          <>
            {s.installFlaggedText}
            <ul className="tai-skill__flags">
              {skill.flags.map((flag) => (
                <li key={flag}>
                  <strong>{s.flags[flag].name}.</strong> {s.flags[flag].text}
                </li>
              ))}
            </ul>
          </>
        ),
        confirmLabel: s.installAnyway,
        danger: true,
      });
      if (!confirmed) return;
    }
    setInstalling(skill.ref);
    try {
      await installAiSkill(skill.ref);
      toast.success(t(s.installedToast, { name: skill.name }));
      setViewing(null);
      refresh();
    } catch (error) {
      toast.error(error);
    } finally {
      setInstalling(null);
    }
  };

  const toggle = async (skill: AiSkillDto, enabled: boolean): Promise<void> => {
    try {
      await setAiSkillEnabled(skill.name, enabled);
      refresh();
    } catch (error) {
      toast.error(error);
    }
  };

  const remove = async (skill: AiSkillDto): Promise<void> => {
    const { confirmed } = await confirm({ title: t(s.removeTitle, { name: skill.name }), text: skill.source === 'custom' ? s.removeCustomText : s.removeText, confirmLabel: m.common.remove, danger: true });
    if (!confirmed) return;
    try {
      await removeAiSkill(skill.name);
      refresh();
    } catch (error) {
      toast.error(error);
    }
  };

  const edit = async (skill: AiSkillDto): Promise<void> => {
    try {
      const detail = await client.fetchQuery({ queryKey: aiKeys.skill(skill.ref), queryFn: () => fetchAiSkill(skill.ref), staleTime: 0 });
      setCustom((current) => ({ open: true, editing: { name: detail.name, description: detail.description, body: detail.body }, key: current.key + 1 }));
    } catch (error) {
      toast.error(error);
    }
  };

  const listed = (catalog.data ?? []).length;
  const fromSources = data.sources.reduce((sum, source) => sum + source.skills, 0);
  const autoCount = data.installed.filter((skill) => skill.auto).length;

  return (
    <>
      <Card icon={<Sparkles />} title={s.autoTitle} description={s.intro}>
        <div className="stack" style={{ gap: 14 }}>
          <Switch checked={data.auto === 'trusted'} disabled={savingAuto} onChange={(on) => void setAuto(on)} label={s.auto} hint={s.autoHint} />
          <div className="tai-skill__stats">
            <div>
              <strong>{data.available}</strong>
              <span>{s.statAvailable}</span>
            </div>
            <div>
              <strong>{data.installed.length}</strong>
              <span>{s.statInstalled}</span>
            </div>
            <div>
              <strong>{autoCount}</strong>
              <span>{s.statAuto}</span>
            </div>
            <div>
              <strong>{fromSources}</strong>
              <span>{plural(s.statSources, data.sources.length)}</span>
            </div>
          </div>
          <Callout tone="info" title={s.safetyTitle}>
            {s.safetyText}
          </Callout>
        </div>
      </Card>

      <Card
        title={`${s.installedTitle}${data.installed.length > 0 ? ` · ${data.installed.length}` : ''}`}
        description={s.installedHint}
        actions={
          <Button icon={<FilePlus2 />} onClick={() => setCustom((current) => ({ open: true, editing: null, key: current.key + 1 }))}>
            {s.customNew}
          </Button>
        }
        flush={data.installed.length > 0}
      >
        {data.installed.length === 0 ? (
          <EmptyState icon={<GraduationCap />} title={s.installedEmptyTitle}>
            {s.installedEmptyText}
          </EmptyState>
        ) : (
          <div className="tai-skills">
            {data.installed.map((skill) => (
              <SkillRow key={skill.name} skill={skill} onOpen={() => setViewing(skill.ref)}>
                <Switch checked={skill.enabled} onChange={(enabled) => void toggle(skill, enabled)} label={skill.enabled ? s.enabled : s.disabled} hideLabel />
                <Menu
                  label={skill.name}
                  trigger={(props) => (
                    <Button variant="ghost" size="sm" iconOnly icon={<MoreHorizontal />} {...props}>
                      {m.common.more}
                    </Button>
                  )}
                >
                  <MenuItem icon={<BookOpen />} onSelect={() => setViewing(skill.ref)}>
                    {s.view}
                  </MenuItem>
                  {skill.updateAvailable && (
                    <MenuItem icon={<RefreshCw />} onSelect={() => void install(skill)}>
                      {s.update}
                    </MenuItem>
                  )}
                  {skill.source === 'custom' && (
                    <MenuItem icon={<PenLine />} onSelect={() => void edit(skill)}>
                      {s.edit}
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem icon={<Trash2 />} danger onSelect={() => void remove(skill)}>
                    {m.common.remove}
                  </MenuItem>
                </Menu>
              </SkillRow>
            ))}
          </div>
        )}
      </Card>

      <Card title={s.catalogTitle} description={t(s.catalogHint, { count: data.available })}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="tai-skill__search">
            <span className="tai-skill__search-input">
              <Search aria-hidden="true" />
              <Input type="search" value={query} placeholder={s.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} aria-label={s.searchPlaceholder} />
            </span>
            <Segmented
              label={s.catalogTitle}
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: s.filterAll },
                { value: 'builtin', label: s.filterBuiltin },
                { value: 'registry', label: s.filterRegistry },
              ]}
            />
          </div>
          {catalog.data === undefined ? (
            <SkeletonRows rows={5} />
          ) : shown.length === 0 ? (
            <p className="faint" style={{ margin: 0 }}>
              {deferred.length > 0 ? t(s.searchEmpty, { query: deferred }) : s.catalogEmpty}
            </p>
          ) : (
            <div className="tai-skills tai-skills--boxed">
              {shown.map((skill) => (
                <SkillRow key={skill.ref} skill={skill} onOpen={() => setViewing(skill.ref)}>
                  {skill.installed ? (
                    <Badge tone="ok">{s.installedBadge}</Badge>
                  ) : (
                    <Button size="sm" icon={<Download />} busy={installing === skill.ref} onClick={() => void install(skill)}>
                      {s.install}
                    </Button>
                  )}
                </SkillRow>
              ))}
            </div>
          )}
          {listed >= 80 && deferred.length === 0 && <p className="faint" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{s.catalogMore}</p>}
        </div>
      </Card>

      <Card title={s.sourcesTitle} description={s.sourcesHint}>
        <Sources sources={data.sources} />
      </Card>

      <SkillDialog skillRef={viewing} onClose={() => setViewing(null)} installing={installing !== null} onInstall={(skill) => void install(skill)} />
      <CustomSkillDialog key={custom.key} open={custom.open} editing={custom.editing} onClose={() => setCustom((current) => ({ ...current, open: false }))} />
    </>
  );
}
