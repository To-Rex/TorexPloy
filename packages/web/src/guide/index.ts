/**
 * Guide content per language, loaded on demand so the dashboard bundle stays small. Uzbek in Cyrillic and in the
 * 2021 Latin alphabet is the Latin guide converted, prose only: ids, icons, routes and commands stay as they are.
 */
import type { Locale } from '@ploy/shared';
import { toUzbekCyrillic, toUzbekNewLatin, transliterateTree } from '@ploy/shared/transliterate';
import type { GuideBlock, GuideContent } from './types.ts';

/** Keys whose values are identifiers, not text. */
const IDENTIFIERS = new Set(['id', 'icon', 'type', 'tone', 'to']);

function convertGuide(guide: GuideContent, convert: (text: string) => string): GuideContent {
  const blocks = (list: GuideBlock[]): GuideBlock[] =>
    list.map((block) => (block.type === 'code' ? { ...block, ...(block.label === undefined ? {} : { label: convert(block.label) }) } : transliterateTree(block, convert, IDENTIFIERS)));
  return {
    intro: convert(guide.intro),
    quickStart: transliterateTree(guide.quickStart, convert, IDENTIFIERS),
    chapters: guide.chapters.map((chapter) => ({
      ...chapter,
      title: convert(chapter.title),
      sections: chapter.sections.map((section) => ({ ...section, title: convert(section.title), summary: convert(section.summary), blocks: blocks(section.blocks) })),
    })),
  };
}

const LOADERS: Record<Locale, () => Promise<GuideContent>> = {
  uz: async () => (await import('./uz.ts')).guide,
  'uz-new': async () => convertGuide((await import('./uz.ts')).guide, toUzbekNewLatin),
  'uz-cyrl': async () => convertGuide((await import('./uz.ts')).guide, toUzbekCyrillic),
  kaa: async () => (await import('./kaa.ts')).guide,
  ru: async () => (await import('./ru.ts')).guide,
  en: async () => (await import('./en.ts')).guide,
  ky: async () => (await import('./ky.ts')).guide,
  tg: async () => (await import('./tg.ts')).guide,
  kk: async () => (await import('./kk.ts')).guide,
  tk: async () => (await import('./tk.ts')).guide,
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
