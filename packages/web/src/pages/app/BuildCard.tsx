/**
 * How the code becomes an image: which builder, and the few settings each
 * one takes. "Show build plan" checks out the branch and reports what a
 * deploy would do — stack, commands, the Dockerfile — without building.
 */
import { useState } from 'react';
import { ClipboardList, FileCode2 } from 'lucide-react';
import type { ApplicationDto, BuildPlanDto, BuildType } from '@ploy/shared';
import { BuilderPicker } from '../../components/Builders.tsx';
import { CopyButton } from '../../components/Copy.tsx';
import { Card, SaveFooter } from '../../components/Frame.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Callout, Field, Input } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { fetchBuildPlan } from '../../lib/queries.ts';
import { useAppForm } from './appForm.ts';

const BUILDPACK_DEFAULTS: Partial<Record<BuildType, string>> = { heroku: 'heroku/builder:24', paketo: 'paketobuildpacks/builder-jammy-base' };

function BuildPlan({ plan }: { plan: BuildPlanDto }) {
  const { m } = useI18n();
  const b = m.build;
  return (
    <div className="plan">
      <div className="plan__head">
        <Badge>{b.names[plan.builder]}</Badge>
        <span className="plan__label">{plan.label}</span>
        {plan.commit !== null && (
          <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>
            <code>{plan.commit.sha.slice(0, 7)}</code> {plan.commit.message}
          </span>
        )}
      </div>
      {plan.warnings.length > 0 && (
        <ul className="plan__warnings">
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {plan.dockerfile !== null ? (
        <div className="editor">
          <div className="editor__bar">
            <FileCode2 aria-hidden="true" />
            <span className="grow">{plan.mode === 'dockerfile' ? b.planRepoDockerfile : b.planGeneratedDockerfile}</span>
            <CopyButton value={plan.dockerfile} />
          </div>
          <pre className="editor__area editor__area--readonly" style={{ maxHeight: 420, overflow: 'auto' }}>
            {plan.dockerfile}
          </pre>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{b.planExternal}</p>
      )}
    </div>
  );
}

export function BuildCard({ app }: { app: ApplicationDto }) {
  const { m } = useI18n();
  const b = m.build;
  const toast = useToast();
  const { form, set, text, dirty, submit, reset, saving, errors } = useAppForm(app);
  const [plan, setPlan] = useState<BuildPlanDto | null>(null);
  const [planning, setPlanning] = useState(false);
  const type = form.buildType;
  const commands = type === 'torex' || type === 'nixpacks' || type === 'railpack';
  const showPlan = async () => {
    setPlanning(true);
    try {
      setPlan(await fetchBuildPlan(app.id));
    } catch (error) {
      toast.error(error);
    } finally {
      setPlanning(false);
    }
  };

  return (
    <Card
      title={b.title}
      description={b.description}
      actions={
        <Button size="sm" icon={<ClipboardList />} busy={planning} disabled={dirty} title={dirty ? b.planSaveFirst : undefined} onClick={() => void showPlan()}>
          {b.showPlan}
        </Button>
      }
      footer={<SaveFooter dirty={dirty} saving={saving} onSave={submit} onReset={reset} note={dirty ? b.redeployNote : undefined} />}
    >
      <BuilderPicker value={type} onChange={(value) => set('buildType', value)} />
      {errors.buildType !== undefined && <p className="field__error">{errors.buildType}</p>}

      <div className="form-grid">
        <Field label={m.appSettings.rootDirectory} hint={m.newApp.rootDirectoryHint} error={errors.rootDirectory}>
          <Input mono {...text('rootDirectory')} placeholder="./" spellCheck={false} />
        </Field>
        {type === 'dockerfile' && (
          <>
            <Field label={m.appSettings.dockerfilePath} error={errors.dockerfilePath}>
              <Input mono {...text('dockerfilePath')} spellCheck={false} />
            </Field>
            <Field label={b.buildStage} hint={b.buildStageHint} optional={m.common.optional} error={errors.buildStage}>
              <Input mono {...text('buildStage')} placeholder="runtime" spellCheck={false} />
            </Field>
          </>
        )}
        {type === 'torex' && (
          <Field label={m.appSettings.dockerfilePath} hint={b.dockerfileAutoHint} error={errors.dockerfilePath}>
            <Input mono {...text('dockerfilePath')} spellCheck={false} />
          </Field>
        )}
        {(type === 'heroku' || type === 'paketo') && (
          <Field label={b.buildpackBuilder} hint={b.buildpackBuilderHint} optional={m.common.optional} error={errors.buildpackBuilder}>
            <Input mono {...text('buildpackBuilder')} placeholder={BUILDPACK_DEFAULTS[type]} spellCheck={false} />
          </Field>
        )}
        {type === 'static' && (
          <Field label={m.appSettings.outputDirectory} hint={b.staticOutputHint} error={errors.outputDirectory}>
            <Input mono {...text('outputDirectory')} placeholder="dist" spellCheck={false} />
          </Field>
        )}
      </div>

      {commands && (
        <div className="form-grid">
          <Field label={m.appSettings.installCommand} error={errors.installCommand}>
            <Input mono {...text('installCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
          </Field>
          <Field label={m.appSettings.buildCommand} error={errors.buildCommand}>
            <Input mono {...text('buildCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
          </Field>
          {type === 'torex' && (
            <Field label={m.appSettings.outputDirectory} hint={m.appSettings.outputDirectoryHint} optional={m.common.optional} error={errors.outputDirectory}>
              <Input mono {...text('outputDirectory')} placeholder="dist" spellCheck={false} />
            </Field>
          )}
        </div>
      )}
      {type === 'static' && (
        <div className="form-grid">
          <Field label={m.appSettings.installCommand} optional={m.common.optional} error={errors.installCommand}>
            <Input mono {...text('installCommand')} placeholder={m.appSettings.auto} spellCheck={false} />
          </Field>
          <Field label={m.appSettings.buildCommand} optional={m.common.optional} hint={b.staticBuildHint} error={errors.buildCommand}>
            <Input mono {...text('buildCommand')} placeholder="npm run build" spellCheck={false} />
          </Field>
        </div>
      )}
      {type === 'torex' && (
        <Field label={b.systemPackages} optional={m.common.optional} hint={b.systemPackagesHint} error={errors.systemPackages}>
          <Input mono {...text('systemPackages')} placeholder="imagemagick ffmpeg" spellCheck={false} />
        </Field>
      )}
      {type === 'nixpacks' && <Callout tone="info">{b.nixpacksNote}</Callout>}
      {type === 'railpack' && <Callout tone="info">{b.railpackNote}</Callout>}
      {(type === 'heroku' || type === 'paketo') && <Callout tone="info">{b.buildpacksNote}</Callout>}

      {plan !== null && <BuildPlan plan={plan} />}
    </Card>
  );
}
