/**
 * Every interface language says everything the Uzbek says: the same keys, the
 * same placeholders and markup in every string, nothing left empty; the guide
 * has the same chapters, sections, blocks and routes; dates, relative times
 * and numbers read right in each language.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALE_INFO, LOCALES, type Locale } from '@ploy/shared';
import { toUzbekNewLatin, transliterateTree } from '@ploy/shared/transliterate';
import type { GuideContent } from '../guide/types.ts';
import { formatGroupedNumber, formatPack, formatPackDate, formatPackRelative } from './format.ts';
import { uz, type Messages } from './uz.ts';

async function catalogue(locale: Locale): Promise<Messages> {
  switch (locale) {
    case 'uz':
      return uz;
    case 'uz-new':
      return (await import('./variants.ts')).uzNewLatin();
    case 'uz-cyrl':
      return (await import('./variants.ts')).uzCyrillic();
    default:
      return (await import(`./${locale}.ts`))[locale] as Messages;
  }
}

/** `{name}` placeholders; `${NAME}` is an example of compose syntax, which a language may name in its own words. */
const placeholders = (text: string): string => (text.match(/(?<!\$)\{\w+\}/g) ?? []).sort().join(' ');
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many']);
const links = (text: string): string => (text.match(/\]\([^)]*\)/g) ?? []).sort().join(' ');
const count = (text: string, token: string): number => text.split(token).length - 1;

function compare(source: unknown, target: unknown, path: string, problems: string[]): void {
  if (typeof source === 'string') {
    if (typeof target !== 'string') return void problems.push(`${path}: not a string`);
    if (source.trim().length > 0 && target.trim().length === 0) problems.push(`${path}: empty`);
    // A singular form may say "once" instead of "{count} time"; it still may not invent a placeholder.
    const form = path.slice(path.lastIndexOf('.') + 1);
    const ok = PLURAL_FORMS.has(form) ? placeholders(target).split(' ').filter(Boolean).every((name) => placeholders(source).includes(name)) : placeholders(source) === placeholders(target);
    if (!ok) problems.push(`${path}: placeholders ${placeholders(source)} → ${placeholders(target)}`);
    if (links(source) !== links(target)) problems.push(`${path}: link targets differ`);
    if (count(source, '`') !== count(target, '`')) problems.push(`${path}: code spans differ`);
    if (count(source, '**') !== count(target, '**')) problems.push(`${path}: bold markers differ`);
    return;
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(target) || target.length !== source.length) return void problems.push(`${path}: list differs`);
    source.forEach((item, index) => compare(item, target[index], `${path}[${index}]`, problems));
    return;
  }
  if (source !== null && typeof source === 'object') {
    if (target === null || typeof target !== 'object') return void problems.push(`${path}: not an object`);
    for (const key of Object.keys(source)) {
      if (!(key in target)) problems.push(`${path}.${key}: missing`);
      else compare((source as Record<string, unknown>)[key], (target as Record<string, unknown>)[key], `${path}.${key}`, problems);
    }
    // Plural forms: a language may need more of them (Russian: few, many) than Uzbek has.
    const plural = 'other' in source;
    for (const key of Object.keys(target)) if (!(key in source) && !(plural && PLURAL_FORMS.has(key))) problems.push(`${path}.${key}: not in Uzbek`);
  }
}

for (const locale of LOCALES) {
  test(`${locale}: the catalogue says everything the Uzbek says`, async () => {
    const problems: string[] = [];
    compare(uz, await catalogue(locale), locale, problems);
    assert.deepEqual(problems.slice(0, 20), []);
  });
}

test('each translation is in its own alphabet', async () => {
  const strings = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === 'string') out.push(value.replace(/`[^`]*`|\{\w+\}|https?:\/\/\S+/g, ''));
    else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
    return out;
  };
  for (const locale of ['kaa', 'tk', 'uz-new'] as const) {
    const cyrillic = strings(await catalogue(locale)).filter((text) => /[Ѐ-ӿ]/.test(text));
    assert.deepEqual(cyrillic.slice(0, 5), [], `${locale} is written in Latin letters`);
  }
  for (const locale of ['ky', 'tg', 'kk', 'uz-cyrl'] as const) {
    const all = strings(await catalogue(locale));
    const cyrillicShare = all.filter((text) => /[Ѐ-ӿ]/.test(text)).length / all.length;
    assert.ok(cyrillicShare > 0.85, `${locale}: ${Math.round(cyrillicShare * 100)}% of the strings are Cyrillic`);
  }
  assert.equal((await catalogue('uz-new')).meta.languageName, 'Ōzbekça');
  assert.equal((await catalogue('uz-cyrl')).meta.languageName, 'Ўзбекча');
  for (const locale of ['kaa', 'ky', 'tg', 'kk', 'tk'] as const) assert.equal((await catalogue(locale)).meta.languageName, LOCALE_INFO[locale].name, locale);
});

test('every guide has the same chapters, sections, blocks and routes', async () => {
  const { guide: source } = (await import('../guide/uz.ts')) as { guide: GuideContent };
  const ids = (value: unknown, out: string[] = []): string[] => {
    if (Array.isArray(value)) value.forEach((item) => ids(item, out));
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (['id', 'icon', 'type', 'tone', 'to'].includes(key)) out.push(`${key}=${String(item)}`);
        else ids(item, out);
      }
    }
    return out;
  };
  for (const locale of ['kaa', 'ru', 'en', 'ky', 'tg', 'kk', 'tk'] as const) {
    const { guide } = (await import(`../guide/${locale}.ts`)) as { guide: GuideContent };
    assert.deepEqual(ids(guide), ids(source), `${locale}: identifiers`);
    if (locale !== 'ru' && locale !== 'en') {
      const problems: string[] = [];
      compare(source, guide, `${locale}.guide`, problems);
      assert.deepEqual(problems.slice(0, 20), [], locale);
    }
  }
});

test('dates, relative times and numbers in each language', () => {
  const at = new Date(Date.UTC(2026, 10, 24, 9, 5, 7));
  const expect: Partial<Record<Locale, [string, string, string]>> = {
    uz: ['24-noy, 2026, 14:05', '3 soat oldin', '2 kundan keyin'],
    'uz-new': ['24-noy, 2026, 14:05', '3 soat oldin', '2 kundan keyin'],
    'uz-cyrl': ['24-ноя, 2026, 14:05', '3 соат олдин', '2 кундан кейин'],
    kaa: ['24-noy, 2026, 14:05', '3 saat burın', '2 kúnnen keyin'],
    ky: ['24-ноя, 2026, 14:05', '3 саат мурун', '2 күндөн кийин'],
    tg: ['24 ноя, 2026, 14:05', '3 соат пеш', 'баъд аз 2 рӯз'],
    kk: ['24 қар, 2026, 14:05', '3 сағат бұрын', '2 күннен кейін'],
    tk: ['24 noý, 2026, 14:05', '3 sagat öň', '2 günden soň'],
  };
  for (const [locale, [date, past, future]] of Object.entries(expect) as [Locale, [string, string, string]][]) {
    const pack = formatPack(locale)!;
    assert.equal(formatPackDate(pack, at, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tashkent' }), date, locale);
    assert.equal(formatPackRelative(pack, -3, 'hour'), past, locale);
    assert.equal(formatPackRelative(pack, 2, 'day'), future, locale);
  }
  assert.equal(formatPack('ru'), null, 'Intl formats Russian');
  assert.equal(formatPackRelative(formatPack('uz-new')!, -1, 'day'), 'keça');
  const { dayMonth: _latin, ...latin } = formatPack('uz')!;
  const { dayMonth: _newLatin, ...newLatin } = formatPack('uz-new')!;
  assert.deepEqual(newLatin, transliterateTree(latin, toUzbekNewLatin), 'the new Latin pack is the Latin one, converted');
  assert.equal(formatPackDate(formatPack('uz-new')!, at, { dateStyle: 'full', timeZone: 'Asia/Tashkent' }), 'seşanba, 24-noyabr, 2026');
  assert.equal(formatGroupedNumber(1234567.5, { maximumFractionDigits: 1 }), '1 234 567,5');
});
