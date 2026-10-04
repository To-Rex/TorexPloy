/**
 * The application's editable settings as a form. Every card that edits a
 * slice of them (build, run command, resources, health…) keeps its own copy
 * and saves only what changed in it, so cards never overwrite each other.
 */
import { useEffect, useMemo, useState } from 'react';
import { updateApplicationSchema, type ApplicationDto, type UpdateApplicationInput } from '@ploy/shared';
import { useI18n } from '../../i18n/index.tsx';
import { api } from '../../lib/api.ts';
import { fieldErrors } from '../../lib/errors.ts';
import { useAction } from '../../lib/mutate.ts';
import { keys } from '../../lib/queries.ts';
import { validate } from '../../lib/validate.ts';

export interface AppForm {
  buildType: ApplicationDto['buildType'];
  dockerfilePath: string;
  rootDirectory: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
  kind: ApplicationDto['kind'];
  port: string;
  replicas: string;
  cpuLimit: string;
  memoryLimitMb: string;
  healthCheckPath: string;
  healthCheckTimeoutSec: string;
  strategy: ApplicationDto['strategy'];
}

export function fromApp(app: ApplicationDto): AppForm {
  return {
    buildType: app.buildType,
    dockerfilePath: app.dockerfilePath,
    rootDirectory: app.rootDirectory,
    installCommand: app.installCommand ?? '',
    buildCommand: app.buildCommand ?? '',
    startCommand: app.startCommand ?? '',
    outputDirectory: app.outputDirectory ?? '',
    kind: app.kind,
    port: app.port === null ? '' : String(app.port),
    replicas: String(app.replicas),
    cpuLimit: app.cpuLimit === null ? '' : String(app.cpuLimit),
    memoryLimitMb: app.memoryLimitMb === null ? '' : String(app.memoryLimitMb),
    healthCheckPath: app.healthCheckPath ?? '',
    healthCheckTimeoutSec: String(app.healthCheckTimeoutSec),
    strategy: app.strategy,
  };
}

const orNull = (value: string): string | null => (value.trim().length === 0 ? null : value.trim());
const numOrNull = (value: string): number | null => (value.trim().length === 0 ? null : Number(value));

export function toPatch(app: ApplicationDto, form: AppForm): UpdateApplicationInput {
  const patch: UpdateApplicationInput = {};
  const before = fromApp(app);
  const changed = (key: keyof AppForm) => form[key] !== before[key];
  if (changed('buildType')) patch.buildType = form.buildType;
  if (changed('dockerfilePath')) patch.dockerfilePath = form.dockerfilePath.trim();
  if (changed('rootDirectory')) patch.rootDirectory = form.rootDirectory.trim();
  if (changed('installCommand')) patch.installCommand = orNull(form.installCommand);
  if (changed('buildCommand')) patch.buildCommand = orNull(form.buildCommand);
  if (changed('startCommand')) patch.startCommand = orNull(form.startCommand);
  if (changed('outputDirectory')) patch.outputDirectory = orNull(form.outputDirectory);
  if (changed('kind') && form.kind !== 'compose') patch.kind = form.kind;
  if (changed('port')) patch.port = numOrNull(form.port);
  if (changed('replicas')) patch.replicas = Number(form.replicas);
  if (changed('cpuLimit')) patch.cpuLimit = numOrNull(form.cpuLimit);
  if (changed('memoryLimitMb')) patch.memoryLimitMb = numOrNull(form.memoryLimitMb);
  if (changed('healthCheckPath')) patch.healthCheckPath = orNull(form.healthCheckPath);
  if (changed('healthCheckTimeoutSec')) patch.healthCheckTimeoutSec = Number(form.healthCheckTimeoutSec);
  if (changed('strategy')) patch.strategy = form.strategy;
  return patch;
}

export function useAppForm(app: ApplicationDto) {
  const { m } = useI18n();
  const [form, setForm] = useState<AppForm>(() => fromApp(app));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const signature = JSON.stringify(fromApp(app));
  useEffect(() => setForm(fromApp(app)), [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useMemo(() => toPatch(app, form), [app, form]);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof AppForm>(key: K, value: AppForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const text = (key: keyof AppForm, numeric = false) => ({
    value: form[key] as string,
    onChange: (event: { target: { value: string } }) => set(key, (numeric ? event.target.value.replace(/[^\d.]/g, '') : event.target.value) as AppForm[typeof key]),
  });
  const save = useAction((input: UpdateApplicationInput) => api.patch(`/api/applications/${app.id}`, input), {
    success: m.appSettings.saved,
    invalidate: [keys.app(app.id), keys.project(app.projectId)],
    inlineValidation: true,
  });
  const submit = () => {
    const result = validate(m, updateApplicationSchema, patch);
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    save.mutate(patch, { onError: (error) => setErrors(fieldErrors(m, error)) });
  };
  const reset = () => {
    setForm(fromApp(app));
    setErrors({});
  };
  return { form, set, text, dirty, submit, reset, saving: save.isPending, errors };
}
