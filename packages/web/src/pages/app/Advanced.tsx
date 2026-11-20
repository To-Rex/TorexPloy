/**
 * Advanced: how the app runs once built — the run command, what kind of
 * process it is and how many copies, resource limits, health check, rollout
 * strategy, volumes — each in its own card with its own save; host access
 * for compose stacks; and deletion. A list of the sections stays beside
 * them, so a long page of settings is one click from any of its parts.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeftRight, Cog, Cpu, Globe, HardDrive, HeartPulse, Network, Power, Repeat, ShieldAlert, SquareTerminal, Trash2 } from 'lucide-react';
import { LIMITS, roleAtLeast, type ApplicationDto } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Card, SaveFooter } from '../../components/Frame.tsx';
import { AffixInput, Button, Callout, Field, Stepper, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys, useAppMetrics, useCompose, useRole } from '../../lib/queries.ts';
import { useAppContext } from './AppLayout.tsx';
import { useAppForm } from './appForm.ts';
import { VolumesCard } from './Storage.tsx';

function RunCommandCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { text, dirty, submit, reset, saving, errors } = useAppForm(app);
  return (
    <Card id="adv-run" icon={<SquareTerminal />} title={m.advanced.runTitle} description={m.advanced.runHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <Field label={m.appSettings.startCommand} error={errors.startCommand}>
        <AffixInput mono before="$" {...text('startCommand')} placeholder={app.source.type === 'image' ? m.advanced.runImagePlaceholder : m.appSettings.auto} spellCheck={false} />
      </Field>
    </Card>
  );
}

function RuntimeCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { form, set, text, dirty, submit, reset, saving, errors } = useAppForm(app);
  const kinds: { value: 'web' | 'worker'; icon: ReactNode; title: string; hint: string }[] = [
    { value: 'web', icon: <Globe aria-hidden="true" />, title: m.newApp.kindWeb, hint: m.newApp.kindWebHint },
    { value: 'worker', icon: <Cog aria-hidden="true" />, title: m.newApp.kindWorker, hint: m.newApp.kindWorkerHint },
  ];
  return (
    <Card id="adv-runtime" icon={<Network />} title={m.advanced.runtimeTitle} description={m.advanced.runtimeHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <div className="field">
        <span className="field__label">{m.newApp.kind}</span>
        <div className="choices choices--two" role="radiogroup" aria-label={m.newApp.kind}>
          {kinds.map((kind) => (
            <button key={kind.value} type="button" role="radio" className="choice" aria-checked={form.kind === kind.value} onClick={() => set('kind', kind.value)}>
              <span className="choice__title">
                {kind.icon}
                {kind.title}
              </span>
              <span className="choice__hint">{kind.hint}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="form-grid">
        {form.kind === 'web' && (
          <Field label={m.appSettings.port} hint={m.newApp.portHint} error={errors.port}>
            <AffixInput before=":" {...text('port', true)} inputMode="numeric" placeholder={m.appSettings.auto} />
          </Field>
        )}
        <Field label={m.appSettings.replicas} hint={m.appSettings.replicasHint} error={errors.replicas}>
          <Stepper value={form.replicas} onChange={(value) => set('replicas', value)} min={1} max={LIMITS.replicasMax} labels={{ decrease: m.advanced.decrease, increase: m.advanced.increase }} />
        </Field>
      </div>
    </Card>
  );
}

/** Limits people actually choose between. Null is "no limit". */
const PRESETS: { cpu: number | null; memoryMb: number | null }[] = [
  { cpu: null, memoryMb: null },
  { cpu: 0.5, memoryMb: 512 },
  { cpu: 1, memoryMb: 1024 },
  { cpu: 2, memoryMb: 2048 },
  { cpu: 4, memoryMb: 4096 },
];

function ResourcesCard({ app }: { app: ApplicationDto }) {
  const { m, t, formatBytes, formatNumber } = useI18n();
  const a = m.advanced;
  const { form, set, text, dirty, submit, reset, saving, errors } = useAppForm(app);
  const live = app.activeDeployment !== null && app.status !== 'stopped';
  const metrics = useAppMetrics(app.id, '1h');
  const last = live ? metrics.data?.points.at(-1) : undefined;
  const cpu = form.cpuLimit.trim().length === 0 ? null : Number(form.cpuLimit);
  const memoryMb = form.memoryLimitMb.trim().length === 0 ? null : Number(form.memoryLimitMb);
  const label = (preset: (typeof PRESETS)[number]) => (preset.cpu === null || preset.memoryMb === null ? m.metrics.noLimit : `${formatNumber(preset.cpu)} vCPU · ${formatBytes(preset.memoryMb * 1024 * 1024, 0)}`);
  // How much of the limit being typed is in use right now: the reason to raise it, or the room to lower it.
  const share = (used: number, limit: number | null) => (limit === null || limit <= 0 ? null : Math.min(1, used / limit));
  const cpuShare = last === undefined ? null : share(last.cpu, cpu === null ? null : cpu * 100);
  const memShare = last === undefined ? null : share(last.mem, memoryMb === null ? null : memoryMb * 1024 * 1024);
  const state = (value: number | null) => (value === null ? undefined : value >= 0.9 ? 'bad' : value >= 0.7 ? 'work' : 'ok');
  return (
    <Card id="adv-resources" icon={<Cpu />} title={a.resourcesTitle} description={a.resourcesHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <div className="field">
        <span className="field__label">{a.presets}</span>
        <div className="presets" role="group" aria-label={a.presets}>
          {PRESETS.map((preset) => (
            <button
              key={label(preset)}
              type="button"
              aria-pressed={preset.cpu === cpu && preset.memoryMb === memoryMb}
              onClick={() => {
                set('cpuLimit', preset.cpu === null ? '' : String(preset.cpu));
                set('memoryLimitMb', preset.memoryMb === null ? '' : String(preset.memoryMb));
              }}
            >
              {label(preset)}
            </button>
          ))}
        </div>
      </div>
      <div className="form-grid">
        <Field label={m.appSettings.cpu} hint={m.appSettings.cpuHint} error={errors.cpuLimit}>
          <AffixInput after="vCPU" {...text('cpuLimit', true)} inputMode="decimal" placeholder="—" />
        </Field>
        <Field label={a.memoryLimit} hint={m.appSettings.memoryHint} error={errors.memoryLimitMb}>
          <AffixInput after={m.units.mb} {...text('memoryLimitMb', true)} inputMode="numeric" placeholder="—" />
        </Field>
      </div>
      {last !== undefined && (
        <div className="usage" aria-label={a.usage}>
          <span className="usage__label">{a.usage}</span>
          <div className="usage__item">
            <span>
              {m.metrics.cpu} <strong className="tabular">{formatNumber(last.cpu, { maximumFractionDigits: last.cpu < 10 ? 1 : 0 })}%</strong>
              {cpuShare !== null && <span className="faint"> · {t(a.ofLimit, { percent: Math.round(cpuShare * 100) })}</span>}
            </span>
            <span className="usage__bar" data-state={state(cpuShare)}>
              <i style={{ width: `${Math.round((cpuShare ?? Math.min(1, last.cpu / 100)) * 100)}%` }} />
            </span>
          </div>
          <div className="usage__item">
            <span>
              {m.metrics.memory} <strong className="tabular">{formatBytes(last.mem)}</strong>
              {memShare !== null && <span className="faint"> · {t(a.ofLimit, { percent: Math.round(memShare * 100) })}</span>}
            </span>
            <span className="usage__bar" data-state={state(memShare)}>
              <i style={{ width: `${Math.round((memShare ?? (last.memLimit > 0 ? Math.min(1, last.mem / last.memLimit) : 0)) * 100)}%` }} />
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function HealthCard({ app }: { app: ApplicationDto }) {
  const { m, t } = useI18n();
  const { form, text, dirty, submit, reset, saving, errors } = useAppForm(app);
  const compose = app.kind === 'compose';
  const path = form.healthCheckPath.trim();
  const seconds = form.healthCheckTimeoutSec.trim().length === 0 ? '…' : form.healthCheckTimeoutSec;
  return (
    <Card
      id="adv-health"
      icon={<HeartPulse />}
      title={compose ? m.compose.settleTitle : m.appSettings.health}
      description={compose ? m.compose.settleHint : m.appSettings.healthHint}
      footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}
    >
      <div className="form-grid">
        {!compose && (
          <Field label={m.appSettings.healthPath} hint={m.appSettings.healthPathHint} error={errors.healthCheckPath}>
            <AffixInput mono before="GET" {...text('healthCheckPath')} placeholder="/health" spellCheck={false} />
          </Field>
        )}
        <Field label={m.advanced.timeout} error={errors.healthCheckTimeoutSec}>
          <AffixInput after={m.advanced.seconds} {...text('healthCheckTimeoutSec', true)} inputMode="numeric" />
        </Field>
      </div>
      {/* What the two fields add up to, said as one sentence. */}
      {!compose && (
        <p className="settings-note">
          <HeartPulse aria-hidden="true" />
          {path.length > 0 ? t(m.advanced.healthProbe, { path, seconds }) : t(m.advanced.healthPort, { seconds })}
        </p>
      )}
    </Card>
  );
}

function StrategyCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const { form, set, dirty, submit, reset, saving } = useAppForm(app);
  const icons = { rolling: <Repeat aria-hidden="true" />, recreate: <Power aria-hidden="true" /> };
  return (
    <Card id="adv-strategy" icon={<ArrowLeftRight />} title={m.appSettings.strategy} description={m.advanced.strategyHint} footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} />}>
      <div className="choices choices--two" role="radiogroup" aria-label={m.appSettings.strategy}>
        {(['rolling', 'recreate'] as const).map((value) => (
          <button key={value} type="button" role="radio" className="choice" aria-checked={form.strategy === value} onClick={() => set('strategy', value)}>
            <span className="choice__title">
              {icons[value]}
              {m.appSettings.strategies[value]}
              {value === 'rolling' && <span className="builder__tag">{m.build.recommended}</span>}
            </span>
            <span className="choice__hint">{m.appSettings.strategyHints[value]}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** Compose only: an administrator's grant for host-reaching features (privileged, host network, absolute binds). */
function HostAccessCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const role = useRole();
  const admin = role !== null && roleAtLeast(role, 'admin');
  const compose = useCompose(app.id);
  const toggle = useAction((allowed: boolean) => api.put(`/api/applications/${app.id}/host-access`, { allowed }), {
    success: m.appSettings.saved,
    invalidate: [keys.app(app.id), keys.appPart(app.id, 'compose')],
  });
  const needed = compose.data?.hostAccessNeeded ?? [];
  return (
    <Card id="adv-host" icon={<ShieldAlert />} title={m.compose.hostAccessTitle} description={m.compose.hostAccessHint}>
      {needed.length > 0 ? (
        <Callout tone={app.hostAccess ? 'info' : 'work'} title={m.compose.hostAccessUses}>
          <ul className="plain-list">
            {needed.map((item) => (
              <li key={item}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{m.compose.hostAccessNone}</p>
      )}
      <Switch
        checked={app.hostAccess}
        onChange={(value) => toggle.mutate(value)}
        disabled={!admin || toggle.isPending}
        label={m.compose.hostAccessAllow}
        hint={admin ? m.compose.hostAccessWarning : m.compose.hostAccessAdminOnly}
      />
    </Card>
  );
}

function DangerCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const compose = app.kind === 'compose';
  const remove = useAction((removeData: boolean) => api.delete(`/api/applications/${app.id}?removeData=${removeData}`), {
    success: m.appSettings.deleted,
    invalidate: [keys.project(app.projectId), keys.projects, keys.apps],
    onSuccess: () => void navigate(`/projects/${app.projectId}`),
  });
  return (
    <Card
      id="adv-danger"
      tone="bad"
      icon={<Trash2 />}
      title={m.appSettings.deleteTitle}
      description={compose ? m.compose.deleteText : m.appSettings.deleteText}
      actions={
        <Button
          variant="danger"
          icon={<Trash2 />}
          busy={remove.isPending}
          onClick={async () => {
            const result = await confirm({
              title: m.appSettings.deleteTitle,
              text: compose ? m.compose.deleteText : m.appSettings.deleteText,
              confirmLabel: m.common.delete,
              danger: true,
              typeToConfirm: app.name,
              checkbox: { label: compose ? m.compose.deleteData : m.appSettings.deleteData },
            });
            if (result.confirmed) remove.mutate(result.checked);
          }}
        >
          {m.app.delete}
        </Button>
      }
    />
  );
}

interface Section {
  id: string;
  icon: ReactNode;
  label: string;
  danger?: boolean;
}

/** The sections of the page, beside it: where each one is, and which one is on screen. */
function SectionNav({ sections }: { sections: Section[] }) {
  const { m } = useI18n();
  const [current, setCurrent] = useState(sections[0]?.id ?? '');
  // A section that was asked for stays marked while the page travels to it (and when the page ends before it
  // reaches the top, as the last ones do).
  const asked = useRef(0);
  const signature = sections.map((section) => section.id).join(' ');
  useEffect(() => {
    const elements = signature.split(' ').map((id) => document.getElementById(id)).filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0 || typeof IntersectionObserver === 'undefined') return;
    // The section whose top has passed the upper part of the window is the one being read.
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        if (Date.now() < asked.current) return;
        const first = elements.find((element) => visible.has(element.id));
        if (first !== undefined) setCurrent(first.id);
      },
      { rootMargin: '-90px 0px -55% 0px' },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [signature]);
  return (
    <nav className="section-nav" aria-label={m.advanced.sections}>
      <p className="section-nav__title">{m.advanced.sections}</p>
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          data-danger={section.danger || undefined}
          aria-current={current === section.id ? 'true' : undefined}
          onClick={() => {
            asked.current = Date.now() + 1_200;
            setCurrent(section.id);
            document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          {section.icon}
          <span className="truncate">{section.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function AdvancedTab() {
  const app = useAppContext();
  const { m } = useI18n();
  const compose = app.kind === 'compose';
  const danger: Section = { id: 'adv-danger', icon: <Trash2 aria-hidden="true" />, label: m.appSettings.danger, danger: true };
  if (compose) {
    return (
      <div className="settings-split">
        <SectionNav
          sections={[
            { id: 'adv-health', icon: <HeartPulse aria-hidden="true" />, label: m.compose.settleTitle },
            { id: 'adv-host', icon: <ShieldAlert aria-hidden="true" />, label: m.compose.hostAccessTitle },
            danger,
          ]}
        />
        <div className="settings-split__main">
          <HealthCard app={app} />
          <HostAccessCard app={app} />
          <DangerCard app={app} />
        </div>
      </div>
    );
  }
  return (
    <div className="settings-split">
      <SectionNav
        sections={[
          { id: 'adv-run', icon: <SquareTerminal aria-hidden="true" />, label: m.advanced.runTitle },
          { id: 'adv-runtime', icon: <Network aria-hidden="true" />, label: m.advanced.runtimeTitle },
          { id: 'adv-resources', icon: <Cpu aria-hidden="true" />, label: m.advanced.resourcesTitle },
          ...(app.kind === 'web' ? [{ id: 'adv-health', icon: <HeartPulse aria-hidden="true" />, label: m.appSettings.health }] : []),
          { id: 'adv-strategy', icon: <ArrowLeftRight aria-hidden="true" />, label: m.appSettings.strategy },
          { id: 'adv-volumes', icon: <HardDrive aria-hidden="true" />, label: m.storage.title },
          danger,
        ]}
      />
      <div className="settings-split__main">
        <RunCommandCard app={app} />
        <RuntimeCard app={app} />
        <ResourcesCard app={app} />
        {app.kind === 'web' && <HealthCard app={app} />}
        <StrategyCard app={app} />
        <VolumesCard app={app} />
        <DangerCard app={app} />
      </div>
    </div>
  );
}
