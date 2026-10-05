/** Guide content per language, loaded on demand so the dashboard bundle stays small. */
import type { Locale } from '@ploy/shared';
import type { GuideContent } from './types.ts';

const LOADERS: Record<Locale, () => Promise<GuideContent>> = {
  uz: async () => (await import('./uz.ts')).guide,
  ru: async () => (await import('./ru.ts')).guide,
  en: async () => (await import('./en.ts')).guide,
};

const cache = new Map<Locale, GuideContent>();

export async function loadGuide(locale: Locale): Promise<GuideContent> {
  const cached = cache.get(locale);
  if (cached !== undefined) return cached;
  const content = await LOADERS[locale]();
  cache.set(locale, content);
  return content;
}

export type { GuideBlock, GuideChapter, GuideContent, GuideIcon, GuideSection } from './types.ts';
