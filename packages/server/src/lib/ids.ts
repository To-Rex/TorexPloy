/**
 * Identifiers and slugs.
 *
 * Entity ids are prefixed (`app_…`, `dep_…`) so a bare id in a log line, a
 * container label or a support ticket says what it refers to.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically random lowercase alphanumeric string (no modulo bias). */
export function randomId(length = 12): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 252 is the largest multiple of 36 below 256; rejecting the rest keeps the distribution uniform.
      if (byte < 252) out += ALPHABET[byte % 36];
      if (out.length === length) break;
    }
  }
  return out;
}

export type IdPrefix =
  | 'usr' | 'ses' | 'tok' | 'team' | 'mem' | 'inv' | 'srv' | 'prj' | 'app' | 'dep' | 'env'
  | 'dom' | 'vol' | 'svc' | 'lnk' | 'cron' | 'run' | 'bak' | 'job' | 'aud' | 'idn';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomId(14)}`;
}

/** Normalize free text into a DNS-label-safe slug (matches `SLUG_RE`). */
export function slugify(input: string, fallback = 'app'): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[ʻʼ'`’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : fallback;
}

/** First free slug among `base`, `base-2`, `base-3`… according to `taken`. */
export function uniqueSlug(base: string, taken: (candidate: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base.slice(0, 33)}-${randomId(6)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
