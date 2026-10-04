/**
 * Getting started: the handful of steps between a fresh install and a
 * production-ready platform, each checked against real state and each one
 * click from being done. It disappears once everything is in place.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { Check, ChevronDown, X } from 'lucide-react';
import { roleAtLeast } from '@ploy/shared';
import { Button } from '../components/ui.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useBootstrap, useGithub, useNotificationChannels, useOverview, useRole, useSettings } from '../lib/queries.ts';

interface Step {
  id: string;
  title: string;
  text: string;
  done: boolean;
  optional?: boolean;
  action: { label: string; to?: string; onClick?: () => void };
}

const storageKey = (userId: string) => `ploy.onboarding.hidden.${userId}`;

function readHidden(userId: string): boolean {
  try {
    return localStorage.getItem(storageKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function Onboarding({ onCreateProject }: { onCreateProject: () => void }) {
  const { m, t } = useI18n();
  const o = m.onboarding;
  const bootstrap = useBootstrap();
  const user = bootstrap.data?.user ?? null;
  const role = useRole();
  const admin = role !== null && roleAtLeast(role, 'admin');
  const instanceAdmin = user?.isInstanceAdmin === true;
  const overview = useOverview();
  const settings = useSettings(instanceAdmin);
  const github = useGithub(admin);
  const channels = useNotificationChannels(admin);
  const [hidden, setHidden] = useState(() => (user === null ? false : readHidden(user.id)));
  // Expanded on a fresh install; once there is a project it folds into one line.
  const [open, setOpen] = useState<boolean | null>(null);

  const data = overview.data;
  if (user === null || data === undefined || hidden) return null;
  // Wait for what is loading; a query that failed only drops its own step.
  if ((instanceAdmin && settings.isPending) || (admin && (github.isPending || channels.isPending))) return null;

  const steps: Step[] = [
    { id: 'server', title: o.server.title, text: o.server.text, done: data.servers.ready > 0, action: { label: o.server.action, to: '/servers' } },
    ...(instanceAdmin && settings.data !== undefined
      ? [{ id: 'domain', title: o.domain.title, text: o.domain.text, done: settings.data?.platformDomain != null, action: { label: o.domain.action, to: '/settings/platform' } }]
      : []),
    ...(admin && github.data !== undefined
      ? [{ id: 'github', title: o.github.title, text: o.github.text, done: (github.data?.installations.length ?? 0) > 0, optional: true, action: { label: o.github.action, to: '/settings/git' } }]
      : []),
    { id: 'project', title: o.project.title, text: o.project.text, done: data.projects > 0, action: { label: o.project.action, onClick: onCreateProject } },
    { id: 'deploy', title: o.deploy.title, text: o.deploy.text, done: data.applications.running > 0, action: { label: o.deploy.action, to: '/projects' } },
    ...(admin && channels.data !== undefined
      ? [{ id: 'alerts', title: o.alerts.title, text: o.alerts.text, done: (channels.data?.length ?? 0) > 0, optional: true, action: { label: o.alerts.action, to: '/settings/notifications' } }]
      : []),
    { id: 'twofa', title: o.twofa.title, text: o.twofa.text, done: user.twoFactorEnabled, action: { label: o.twofa.action, to: '/settings/security' } },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  const expanded = open ?? data.projects === 0;
  if (doneCount === steps.length) return null;
  const next = steps.find((step) => !step.done);

  const hide = () => {
    try {
      localStorage.setItem(storageKey(user.id), '1');
    } catch {
      // storage unavailable: hide for this visit only
    }
    setHidden(true);
  };

  return (
    <section className="onboarding" aria-labelledby="onboarding-title">
      <div className="onboarding__head">
        <button type="button" className="onboarding__toggle" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
          <span className="grow" style={{ minWidth: 0 }}>
            <span id="onboarding-title" className="onboarding__title">
              {o.title}
            </span>
            <span className="onboarding__sub">{t(o.progress, { done: doneCount, total: steps.length })}</span>
          </span>
          <span className="onboarding__meter" aria-hidden="true">
            <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </span>
          <ChevronDown className="onboarding__chevron" aria-hidden="true" />
        </button>
        <Button variant="ghost" size="sm" iconOnly icon={<X />} onClick={hide}>
          {o.hide}
        </Button>
      </div>
      {expanded && (
        <ol className="onboarding__steps">
          {steps.map((step) => (
            <li key={step.id} className="onboarding__step" data-done={step.done || undefined} data-next={step === next || undefined}>
              <span className="onboarding__check" aria-hidden="true">
                {step.done && <Check />}
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="onboarding__step-title">
                  {step.title}
                  {step.optional === true && <span className="faint"> ({m.common.optional})</span>}
                  <span className="sr-only">{step.done ? `, ${o.done}` : ''}</span>
                </div>
                {!step.done && <p className="onboarding__step-text">{step.text}</p>}
              </div>
              {!step.done &&
                (step.action.to !== undefined ? (
                  <Link className={step === next ? 'btn btn--sm btn--primary' : 'btn btn--sm'} to={step.action.to} style={{ textDecoration: 'none' }}>
                    {step.action.label}
                  </Link>
                ) : (
                  <Button size="sm" variant={step === next ? 'primary' : 'secondary'} onClick={step.action.onClick}>
                    {step.action.label}
                  </Button>
                ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
