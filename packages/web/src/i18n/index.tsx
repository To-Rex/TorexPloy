/**
 * Internationalization runtime.
 *
 * Messages are plain typed objects (`m.app.deploy`), so every lookup is
 * checked at compile time and costs nothing at runtime. Uzbek (Latin) ships in
 * the main bundle; Uzbek in Cyrillic and in the new Latin alphabet are made
 * from it on first use; every other language loads on demand. Dates, relative
 * times and numbers use hand-written formats where browsers lack the data
 * (see format.ts) and `Intl` for Russian and English.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isLocale, LOCALE_INFO, LOCALES, localeFromBrowser, type Locale } from '@ploy/shared';
import { uz, type Messages, type Plural } from './uz.ts';
import { formatGroupedNumber, formatPack, formatPackDate, formatPackRelative, zonedParts } from './format.ts';

const LOADERS: Record<Locale, () => Promise<Messages>> = {
  uz: async () => uz,
  'uz-new': async () => (await import('./variants.ts')).uzNewLatin(),
  'uz-cyrl': async () => (await import('./variants.ts')).uzCyrillic(),
  kaa: async () => (await import('./kaa.ts')).kaa,
  ru: async () => (await import('./ru.ts')).ru,
  en: async () => (await import('./en.ts')).en,
  ky: async () => (await import('./ky.ts')).ky,
  tg: async () => (await import('./tg.ts')).tg,
  kk: async () => (await import('./kk.ts')).kk,
  tk: async () => (await import('./tk.ts')).tk,
};

/** BCP 47 tags for `<html lang>` and Intl. */
export const LOCALE_TAGS = Object.fromEntries(LOCALES.map((locale) => [locale, LOCALE_INFO[locale].tag])) as Record<Locale, string>;
/** Each language as its speakers write it, with the alphabet where Uzbek offers three. */
export const LOCALE_NAMES = Object.fromEntries(
  LOCALES.map((locale) => [locale, LOCALE_INFO[locale].variant === null ? LOCALE_INFO[locale].name : `${LOCALE_INFO[locale].name} (${LOCALE_INFO[locale].variant})`]),
) as Record<Locale, string>;

const STORAGE_KEY = 'ploy.locale';

export function storedLocale(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (isLocale(value)) return value;
  } catch {
    // storage unavailable
  }
  // Uzbek is the primary language; a browser asking for one of the others gets it. English is an explicit choice.
  return localeFromBrowser(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export type Params = Record<string, string | number>;

const pad2 = (value: number): string => String(value).padStart(2, '0');

export function interpolate(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (params[key] === undefined ? match : String(params[key])));
}

export interface I18n {
  locale: Locale;
  tag: string;
  m: Messages;
  setLocale: (locale: Locale) => Promise<void>;
  t: (template: string, params?: Params) => string;
  plural: (forms: Plural, count: number, params?: Params) => string;
  formatDate: (value: string | number | Date, options?: Intl.DateTimeFormatOptions) => string;
  formatRelative: (value: string | number | Date) => string;
  /** The instance's IANA time zone; every date above is rendered in it. */
  timezone: string;
  setTimezone: (zone: string) => void;
  /** `HH:MM:SS` in the instance's zone (log lines, the clock). */
  formatClock: (value: string | number | Date) => string;
  /** `YYYY-MM-DD HH:MM:SS` in the instance's zone (log downloads, tooltips). */
  formatStamp: (value: string | number | Date) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatBytes: (bytes: number, fractionDigits?: number) => string;
  formatDuration: (ms: number) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  const [messages, setMessages] = useState<Messages>(uz);
  // Until the bootstrap says otherwise, the browser's own zone; the Shell sets the instance's.
  const [timezone, setTimezone] = useState<string>(() => Intl.DateTimeFormat().resolvedOptions().timeZone);

  const setLocale = useCallback(async (next: Locale) => {
    const loaded = await LOADERS[next]();
    setMessages(loaded);
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (initial !== 'uz') void setLocale(initial);
    // Only the initial value matters here; later changes go through setLocale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.lang = LOCALE_TAGS[locale];
  }, [locale]);

  const value = useMemo<I18n>(() => {
    const tag = LOCALE_TAGS[locale];
    // Hand-written formats where browsers lack the data (see format.ts); Intl for Russian and English.
    const pack = formatPack(locale);
    // Nouns after numbers stay singular in the Turkic languages and Tajik: one/other covers every catalogue.
    const pluralRules = new Intl.PluralRules(pack === null ? tag : 'en');
    const relative = pack === null ? new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'long' }) : null;
    const number = (value: number, options?: Intl.NumberFormatOptions) => (pack !== null ? formatGroupedNumber(value, options) : new Intl.NumberFormat(tag, options).format(value));
    const relativeFormat = (value: number, unit: Intl.RelativeTimeFormatUnit) => (pack !== null ? formatPackRelative(pack, value, unit) : relative!.format(value, unit));
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
      ['year', 365 * 24 * 3600],
      ['month', 30 * 24 * 3600],
      ['week', 7 * 24 * 3600],
      ['day', 24 * 3600],
      ['hour', 3600],
      ['minute', 60],
      ['second', 1],
    ];
    return {
      locale,
      tag,
      m: messages,
      setLocale,
      t: interpolate,
      plural: (forms, count, params = {}) => {
        const category = pluralRules.select(count) as keyof Plural;
        const template = forms[category] ?? forms.other;
        return interpolate(template, { count: number(count), ...params });
      },
      formatDate: (input, options = { dateStyle: 'medium', timeStyle: 'short' }) => {
        const zoned = { timeZone: timezone, ...options };
        return pack !== null ? formatPackDate(pack, new Date(input), zoned) : new Intl.DateTimeFormat(tag, zoned).format(new Date(input));
      },
      timezone,
      setTimezone,
      formatClock: (input) => {
        const d = zonedParts(new Date(input), timezone);
        return `${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}`;
      },
      formatStamp: (input) => {
        const d = zonedParts(new Date(input), timezone);
        return `${d.year}-${pad2(d.month + 1)}-${pad2(d.day)} ${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}`;
      },
      formatRelative: (input) => {
        const seconds = (new Date(input).getTime() - Date.now()) / 1000;
        if (Math.abs(seconds) < 45) return messages.time.justNow;
        for (const [unit, size] of units) {
          if (Math.abs(seconds) >= size || unit === 'second') return relativeFormat(Math.round(seconds / size), unit);
        }
        return relativeFormat(0, 'second');
      },
      formatNumber: (input, options) => number(input, options),
      formatBytes: (bytes, fractionDigits = 1) => {
        const scale = [messages.units.b, messages.units.kb, messages.units.mb, messages.units.gb, messages.units.tb];
        let value = Math.max(0, bytes);
        let index = 0;
        while (value >= 1024 && index < scale.length - 1) {
          value /= 1024;
          index += 1;
        }
        const digits = index === 0 || value >= 100 ? 0 : fractionDigits;
        return `${number(value, { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${scale[index]}`;
      },
      formatDuration: (ms) => {
        const d = messages.time.duration;
        if (ms < 1000) return interpolate(d.ms, { ms: Math.round(ms) });
        const total = Math.round(ms / 1000);
        const h = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return interpolate(d.h, { h, m: mins });
        if (mins > 0) return interpolate(d.m, { m: mins, s });
        return interpolate(d.s, { s });
      },
    };
  }, [locale, messages, setLocale, timezone]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

export type { Messages, Plural };
