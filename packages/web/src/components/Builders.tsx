/**
 * The build types TorexPloy offers, with the mark and words each one is
 * shown with. The picker renders the ones this control plane can run as a
 * grid of radio cards; builders whose CLI is missing wait behind a "more"
 * line, visible on request but never selectable.
 */
import { useState, type ReactNode } from 'react';
import { Container, FileCode2, Globe, Hammer, Layers, Package, Sparkles, Train } from 'lucide-react';
import { BUILD_TYPES, EXTERNAL_BUILD_TYPES, type BuildType } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { useBootstrap } from '../lib/queries.ts';

const ICONS: Record<BuildType, ReactNode> = {
  torex: <Sparkles aria-hidden="true" />,
  dockerfile: <FileCode2 aria-hidden="true" />,
  nixpacks: <Package aria-hidden="true" />,
  railpack: <Train aria-hidden="true" />,
  heroku: <Layers aria-hidden="true" />,
  paketo: <Hammer aria-hidden="true" />,
  static: <Globe aria-hidden="true" />,
};

/** Builders that need no source checkout step: an image is pulled instead. */
export function BuilderIcon({ type }: { type: BuildType }) {
  return <>{ICONS[type] ?? <Container aria-hidden="true" />}</>;
}

/** Which builders this control plane can run right now. */
export function useAvailableBuilders(): Set<BuildType> {
  const bootstrap = useBootstrap();
  return new Set(bootstrap.data?.features.builders ?? BUILD_TYPES.filter((type) => !EXTERNAL_BUILD_TYPES.includes(type)));
}

export function BuilderPicker({ value, onChange, compact = false }: { value: BuildType; onChange: (value: BuildType) => void; compact?: boolean }) {
  const { m, t } = useI18n();
  const available = useAvailableBuilders();
  const [showMissing, setShowMissing] = useState(false);
  const missingCount = BUILD_TYPES.filter((type) => !available.has(type) && type !== value).length;
  // What cannot be chosen is not offered, unless asked for (or already the saved choice).
  const shown = BUILD_TYPES.filter((type) => showMissing || available.has(type) || type === value);
  return (
    <div className="builders-wrap">
      <div className={compact ? 'builders builders--compact' : 'builders'} role="radiogroup" aria-label={m.build.title}>
        {shown.map((type) => {
          const missing = !available.has(type);
          return (
            <button
              key={type}
              type="button"
              role="radio"
              className="builder"
              aria-checked={value === type}
              aria-disabled={missing || undefined}
              title={missing ? m.build.unavailable : undefined}
              onClick={() => {
                if (!missing) onChange(type);
              }}
            >
              <span className="builder__mark">{ICONS[type]}</span>
              <span className="builder__text">
                <span className="builder__name">
                  {m.build.names[type]}
                  {type === 'torex' && <span className="builder__tag">{m.build.recommended}</span>}
                  {missing && <span className="builder__tag builder__tag--off">{m.build.notInstalled}</span>}
                </span>
                {!compact && <span className="builder__hint">{m.build.hints[type]}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {missingCount > 0 && (
        <button type="button" className="link-btn" aria-expanded={showMissing} onClick={() => setShowMissing((current) => !current)}>
          {showMissing ? m.build.hideMissing : t(m.build.showMissing, { count: missingCount })}
        </button>
      )}
    </div>
  );
}
