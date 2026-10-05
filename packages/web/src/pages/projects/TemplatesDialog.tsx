/**
 * One-click templates: pick a ready-made app, name it, choose where it runs,
 * see exactly what will be created, install.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, Database, ExternalLink, Globe, HardDrive, Search, Sparkles } from 'lucide-react';
import { installTemplateSchema, TEMPLATE_CATEGORIES, type ApplicationDto, type TemplateCategory, type TemplateDto } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, EmptyState, Field, Input, Select, Skeleton } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useCatalog, useServers, useTemplates } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

const TILE_COLORS = ['#2746C7', '#0C9A8A', '#B7791F', '#C73340', '#7A4FD0', '#2F7FC1', '#B85C38', '#4F8A3C', '#5B6478'];

/** A lettermark tile: no third-party logos, still tells templates apart at a glance. */
export function TemplateMark({ template, size = 40 }: { template: Pick<TemplateDto, 'id' | 'name'>; size?: number }) {
  let hash = 0;
  for (const char of template.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const letters = template.name
    .split(/[\s-]+/)
    .map((word) => word[0] ?? '')
    .join('')
    .slice(0, 2);
  return (
    <span className="template-mark" style={{ width: size, height: size, background: TILE_COLORS[hash % TILE_COLORS.length], fontSize: size * 0.4 }} aria-hidden="true">
      {letters.length === 1 ? template.name.slice(0, 2) : letters}
    </span>
  );
}

type Shelf = TemplateCategory | 'all' | 'featured';

function Gallery({ templates, onPick }: { templates: TemplateDto[] | undefined; onPick: (template: TemplateDto) => void }) {
  const { m, formatBytes } = useI18n();
  const catalog = useCatalog();
  const [query, setQuery] = useState('');
  const [shelf, setShelf] = useState<Shelf>('featured');
  const needle = query.trim().toLowerCase();
  const describe = (template: TemplateDto) => m.templates.descriptions[template.id as keyof typeof m.templates.descriptions] ?? '';
  const sorted = useMemo(() => [...(templates ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [templates]);
  const counts = useMemo(() => {
    const map = new Map<Shelf, number>([['all', sorted.length], ['featured', sorted.filter((template) => template.featured).length]]);
    for (const template of sorted) map.set(template.category, (map.get(template.category) ?? 0) + 1);
    return map;
  }, [sorted]);
  // A search looks through everything: the shelf only narrows browsing.
  const active: Shelf = needle.length > 0 ? 'all' : shelf;
  const visible = sorted.filter((template) => {
    if (active === 'featured' && !template.featured) return false;
    if (active !== 'all' && active !== 'featured' && template.category !== active) return false;
    return needle.length === 0 || template.name.toLowerCase().includes(needle) || template.id.includes(needle) || describe(template).toLowerCase().includes(needle) || m.templates.categories[template.category].toLowerCase().includes(needle);
  });
  const serviceLabel = (type: string) => catalog.data?.find((entry) => entry.type === type)?.label ?? type;
  const shelves: Shelf[] = ['featured', 'all', ...TEMPLATE_CATEGORIES.filter((category) => (counts.get(category) ?? 0) > 0)];

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="template-filters">
        <label className="template-search">
          <Search aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={m.templates.search} aria-label={m.templates.search} data-autofocus />
        </label>
        <div className="template-cats" role="tablist" aria-label={m.templates.categoriesLabel}>
          {shelves.map((value) => (
            <button key={value} type="button" role="tab" aria-selected={active === value} onClick={() => { setShelf(value); setQuery(''); }}>
              {value === 'all' ? m.templates.all : value === 'featured' ? m.templates.featured : m.templates.categories[value]}
              <span className="template-cats__count">{counts.get(value) ?? 0}</span>
            </button>
          ))}
        </div>
      </div>
      {templates === undefined ? (
        <div className="template-grid">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={112} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState icon={<Search />}>{m.templates.empty}</EmptyState>
      ) : (
        <div className="template-grid">
          {visible.map((template) => (
            <button key={template.id} type="button" className="template-card" onClick={() => onPick(template)}>
              <span className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <TemplateMark template={template} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="template-card__name">{template.name}</span>
                  <span className="template-card__cat">{m.templates.categories[template.category]}</span>
                </span>
              </span>
              <span className="template-card__text">{describe(template)}</span>
              <span className="template-card__meta">
                {template.services.map((type) => (
                  <span key={type} className="row" style={{ gap: 4 }}>
                    <Database aria-hidden="true" />
                    {serviceLabel(type)}
                  </span>
                ))}
                <span>~{formatBytes(template.memoryMb * 1024 * 1024, template.memoryMb % 1024 === 0 || template.memoryMb < 1024 ? 0 : 1)} RAM</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplatesDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const { m, t, plural } = useI18n();
  const navigate = useNavigate();
  const templates = useTemplates(open);
  const servers = useServers();
  const catalog = useCatalog();
  const [picked, setPicked] = useState<TemplateDto | null>(null);
  const [name, setName] = useState('');
  const [serverId, setServerId] = useState('');
  const [domain, setDomain] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (serverId === '' && servers.data?.[0] !== undefined) setServerId((servers.data.find((server) => server.status === 'ready') ?? servers.data[0]).id);
  }, [servers.data, serverId]);

  const pick = (template: TemplateDto) => {
    setPicked(template);
    setName(template.name);
    setDomain('');
    setErrors({});
  };
  const close = () => {
    setPicked(null);
    setErrors({});
    onClose();
  };

  const install = useAction(
    (input: { templateId: string; name: string; serverId: string; domain?: string }) => api.post<{ application: ApplicationDto; deploymentId: string }>(`/api/projects/${projectId}/templates`, input),
    {
      success: (result) => t(m.templates.installing, { name: result.application.name }),
      invalidate: [keys.project(projectId), keys.projects, keys.overview],
      inlineValidation: true,
      onSuccess: (result) => {
        close();
        void navigate(`/apps/${result.application.id}`);
      },
    },
  );

  const serviceLabel = (type: string) => catalog.data?.find((entry) => entry.type === type)?.label ?? type;
  const summary = useMemo(() => {
    if (picked === null) return [];
    return [
      { icon: <Sparkles />, text: t(m.templates.createsApp, { name: name.trim() || picked.name, image: picked.image }) },
      ...picked.services.map((type) => ({ icon: <Database />, text: t(m.templates.createsService, { type: serviceLabel(type) }) })),
      ...(picked.volumes > 0 ? [{ icon: <HardDrive />, text: plural(m.templates.createsVolume, picked.volumes) }] : []),
      { icon: <Globe />, text: domain.trim().length > 0 ? t(m.templates.createsCustomDomain, { domain: domain.trim().toLowerCase() }) : m.templates.createsDomain },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, name, domain, catalog.data, m]);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={picked === null ? m.templates.title : t(m.templates.installTitle, { name: picked.name })}
      description={picked === null ? m.templates.subtitle : (m.templates.descriptions[picked.id as keyof typeof m.templates.descriptions] ?? undefined)}
      {...(picked === null
        ? {}
        : {
            onSubmit: () => {
              const payload = { templateId: picked.id, name: name.trim(), serverId, ...(domain.trim().length === 0 ? {} : { domain: domain.trim() }) };
              const result = validate(m, installTemplateSchema, payload);
              if (result.errors !== null) {
                setErrors(result.errors);
                return;
              }
              install.mutate(payload, { onError: (error) => setErrors(fieldErrors(m, error)) });
            },
          })}
      footer={
        picked === null ? (
          <Button onClick={close}>{m.common.cancel}</Button>
        ) : (
          <>
            <Button icon={<ArrowLeft />} onClick={() => setPicked(null)} style={{ marginRight: 'auto' }}>
              {m.templates.back}
            </Button>
            <Button onClick={close}>{m.common.cancel}</Button>
            <Button type="submit" variant="primary" busy={install.isPending}>
              {m.templates.install}
            </Button>
          </>
        )
      }
    >
      {picked === null ? (
        <Gallery templates={templates.data} onPick={pick} />
      ) : (
        <div className="template-setup">
          <div className="stack" style={{ gap: 16 }}>
            <div className="form-grid">
              <Field label={m.templates.name} error={errors.name}>
                <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
              </Field>
              <Field label={m.templates.server} error={errors.serverId}>
                <Select value={serverId} onChange={(event) => setServerId(event.target.value)}>
                  {(servers.data ?? []).map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field
              label={m.templates.domain}
              optional={picked.needsUrl ? undefined : m.common.optional}
              hint={errors.domain === undefined ? (picked.needsUrl ? m.templates.domainHintNeeded : m.templates.domainHint) : undefined}
              error={errors.domain}
            >
              <Input mono value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="app.example.uz" spellCheck={false} />
            </Field>
          </div>
          <aside className="template-summary">
            <div className="row" style={{ gap: 12 }}>
              <TemplateMark template={picked} size={36} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{picked.name}</div>
                <a href={picked.website} target="_blank" rel="noreferrer noopener" className="row faint" style={{ gap: 4, fontSize: 'var(--text-xs)' }}>
                  {m.templates.website}
                  <ExternalLink width={12} height={12} aria-hidden="true" />
                </a>
              </div>
            </div>
            <div className="template-summary__label">{m.templates.creates}</div>
            <ul className="template-summary__list">
              {summary.map((item, index) => (
                <li key={index}>
                  {item.icon}
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
            <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>{m.templates.editableLater}</p>
          </aside>
        </div>
      )}
    </Dialog>
  );
}
