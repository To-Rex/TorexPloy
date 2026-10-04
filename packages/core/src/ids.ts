/**
 * Low-level identifiers.
 *
 * Entity ids are prefixed so that a database inspection or log line
 * (such as `npm --workspace @ploy/web run dev`) still works without extra context.
 */
import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically random, lowercase, URL-safe token of `length` characters. */
export function randomId(length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Prefixed entity id, e.g. `app_k3m9x2qp1z`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomId(12)}`;
}

/** UUID v4 — used where an opaque, globally unique value is required. */
export function uuid(): string {
  return randomUUID();
}

/** Normalize free-form user input into a DNS-safe slug. */
export function slugify(input: string, fallback = 'item'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
  return slug.length > 0 ? slug : fallback;
}

/** Slug that must stay unique inside a container name / hostname context. */
export function containerSlug(input: string): string {
  const slug = slugify(input, 'app').replace(/-/g, '');
  return slug.slice(0, 24) || 'app';
}

export function isValidSlug(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/.test(value);
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isValidHostname(value: string): boolean {
  return HOSTNAME_RE.test(value.trim().toLowerCase());
}

/** Validate an IPv4/IPv6 address or a hostname (no scheme, no path). */
export function isValidHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => {
      const n = Number(part);
      return n >= 0 && n <= 255 && String(n) === part.replace(/^0(?=\d)/, '');
    });
  }
  if (host.includes(':')) return /^[0-9a-f:]+$/.test(host) && host.split(':').length > 2;
  if (host === 'localhost') return true;
  return HOSTNAME_RE.test(host);
}

/** Container names must match Docker's `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. */
export function sanitizeContainerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 63) || 'container';
}

export function nowIso(): string {
  return new Date().toISOString();
}