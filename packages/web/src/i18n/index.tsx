/**
 * Internationalization runtime.
 *
 * Messages are plain typed objects (`m.app.deploy`), so every lookup is
 * checked at compile time and costs nothing at runtime. Uzbek ships in the
 * main bundle; Russian and English load on demand. Dates, numbers, relative
 * times and plurals all go through `Intl` with the active locale.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Locale } from '@ploy/shared';
import { uz, type Messages, type Plural } from './uz.ts';
import { formatUzDate, formatUzNumber, formatUzRelative, zonedParts } from './uzFormat.ts';

const LOADERS: Record<Locale, () => Promise<Messages>> = {
  uz: async () => uz,
  ru: async () => (await import('./ru.ts')).ru,
  en: async () => (await import('./en.ts')).en,
};

/** BCP 47 tags for Intl. Uzbek is written in Latin script. */
export const LOCALE_TAGS: Record<Locale, string> = { uz: 'uz-Latn-UZ', ru: 'ru-RU', en: 'en-GB' };
export const LOCALE_NAMES: Record<Locale, string> = { uz: 'Oʻzbekcha', ru: 'Русский', en: 'English' };

const STORAGE_KEY = 'ploy.locale';

export function storedLocale(): Locale {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'uz' || value === 'ru' || value === 'en') return value;
  } catch {
    // storage unavailable
  }
  // Uzbek is the primary language; Russian is offered first only to Russian-language browsers.
  // English is an explicit choice (many Uzbek users run English-language systems).
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'uz';
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
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18n>(() => {
    const tag = LOCALE_TAGS[locale];
    // Browsers lack Uzbek CLDR data, so Uzbek uses hand-written formatters (see uzFormat.ts).
    const isUz = locale === 'uz';
    const pluralRules = new Intl.PluralRules(isUz ? 'en' : tag);
    const relative = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'long' });
    const number = (value: number, options?: Intl.NumberFormatOptions) => (isUz ? formatUzNumber(value, options) : new Intl.NumberFormat(tag, options).format(value));
    const relativeFormat = (value: number, unit: Intl.RelativeTimeFormatUnit) => (isUz ? formatUzRelative(value, unit) : relative.format(value, unit));
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
        return isUz ? formatUzDate(new Date(input), zoned) : new Intl.DateTimeFormat(tag, zoned).format(new Date(input));
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
