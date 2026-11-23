/**
 * Choosing the interface language. Ten of them, each written the way its
 * speakers write it (Uzbek in three alphabets), never translated into the
 * current one: someone who cannot read the current language still finds theirs.
 */
import { Check } from 'lucide-react';
import { LOCALE_INFO, LOCALES, type Locale } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { Dialog } from './Dialog.tsx';
import { Select } from './ui.tsx';
import './language.css';

/** A compact choice: the sign-in page, a form field. */
export function LanguageSelect({ value, onChange, label }: { value: Locale; onChange: (locale: Locale) => void; label: string }) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value as Locale)} aria-label={label}>
      {LOCALES.map((locale) => {
        const info = LOCALE_INFO[locale];
        return (
          <option key={locale} value={locale} lang={info.tag}>
            {info.variant === null ? info.name : `${info.name} (${info.variant})`}
          </option>
        );
      })}
    </Select>
  );
}

/** Every language as a card: the profile page, the language dialog. */
export function LanguageGrid({ value, onChange }: { value: Locale; onChange: (locale: Locale) => void }) {
  const { m } = useI18n();
  return (
    <div className="language-grid" role="radiogroup" aria-label={m.nav.language}>
      {LOCALES.map((locale) => {
        const info = LOCALE_INFO[locale];
        const selected = locale === value;
        return (
          <button key={locale} type="button" role="radio" aria-checked={selected} className="language-grid__item" lang={info.tag} onClick={() => onChange(locale)}>
            <span className="language-grid__name">{info.name}</span>
            {info.variant !== null && <span className="language-grid__variant">{info.variant}</span>}
            {selected && <Check className="language-grid__check" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

export function LanguageDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (locale: Locale) => void }) {
  const { m, locale } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={m.nav.language}>
      <LanguageGrid
        value={locale}
        onChange={(next) => {
          onPick(next);
          onClose();
        }}
      />
    </Dialog>
  );
}
