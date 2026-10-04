/**
 * Frame for sign-in, setup and invitations. The aside plays the product's
 * signature once: the deployment pipeline filling stage by stage.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { DEPLOY_STAGES, LOCALES, THEMES } from '@ploy/shared';
import { PipelineRail, type StageView } from '../../components/Pipeline.tsx';
import { BrandMark, Segmented } from '../../components/ui.tsx';
import { LOCALE_NAMES, useI18n } from '../../i18n/index.tsx';
import { useTheme } from '../../lib/theme.tsx';

function DemoRail() {
  const [step, setStep] = useState(-1);
  // The active stage counts up from the moment it lit; finished stages show typical durations.
  const [activeSince, setActiveSince] = useState(() => Date.now());
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStep(DEPLOY_STAGES.length);
      return;
    }
    let current = -1;
    const timer = window.setInterval(() => {
      current += 1;
      setStep(current);
      setActiveSince(Date.now());
      if (current >= DEPLOY_STAGES.length) window.clearInterval(timer);
    }, 650);
    return () => window.clearInterval(timer);
  }, []);
  const durations = [1_400, 38_200, 2_100, 4_800, 300, 10_000];
  const stages: StageView[] = DEPLOY_STAGES.map((stage, index) => {
    if (index < step) return { stage, state: 'done', startedAt: 0, endedAt: durations[index]! };
    if (index === step) return { stage, state: 'active', startedAt: activeSince, endedAt: null };
    return { stage, state: 'pending', startedAt: null, endedAt: null };
  });
  return (
    <div className="auth__demo" aria-hidden="true">
      <PipelineRail stages={stages} />
    </div>
  );
}

function Pattern() {
  // Girih-like lattice from Samarkand tilework: rotated squares on a grid.
  const cells = [];
  for (let row = 0; row < 7; row += 1) {
    for (let col = 0; col < 7; col += 1) {
      const x = col * 80 + (row % 2) * 40;
      const y = row * 80;
      cells.push(<rect key={`${row}-${col}`} x={x - 22} y={y - 22} width="44" height="44" transform={`rotate(45 ${x} ${y})`} />);
      cells.push(<rect key={`s-${row}-${col}`} x={x - 22} y={y - 22} width="44" height="44" />);
    }
  }
  return (
    <svg className="auth__pattern" viewBox="0 0 560 560" fill="none" stroke="#7FE3D6" strokeWidth="1" aria-hidden="true">
      <g opacity="0.22">{cells}</g>
    </svg>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  const { m, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();
  return (
    <div className="auth">
      <aside className="auth__aside">
        <div className="auth__brand">
          <BrandMark size={32} />
          TorexPloy
        </div>
        <div style={{ position: 'relative', zIndex: 1 }}>
          <h1>{m.auth.asideTitle}</h1>
          <p>{m.auth.asideText}</p>
          <DemoRail />
        </div>
        <Pattern />
      </aside>
      <main className="auth__main">
        <div className="auth__form" style={{ gap: 0 }}>
          <div className="auth__mobile-brand">
            <BrandMark size={28} />
            TorexPloy
          </div>
        </div>
        {children}
        <div className="auth__prefs">
          <Segmented label={m.nav.language} value={locale} onChange={(value) => void setLocale(value)} options={LOCALES.map((value) => ({ value, label: LOCALE_NAMES[value] }))} />
          <Segmented label={m.nav.theme} value={theme} onChange={setTheme} options={THEMES.map((value) => ({ value, label: m.theme[value] }))} />
        </div>
      </main>
    </div>
  );
}
