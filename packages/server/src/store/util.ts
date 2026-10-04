/**
 * Row-mapping helpers shared by the stores.
 */
import { badRequest } from '../lib/errors.ts';

export type Row = Record<string, unknown>;

export const bool = (value: unknown): boolean => value === 1 || value === 1n || value === true;
export const int01 = (value: boolean): number => (value ? 1 : 0);
export const str = (value: unknown): string => String(value);
export const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
export const num = (value: unknown): number => Number(value);
export const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Opaque keyset cursor over `(created_at, id)` descending. */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined || cursor.length === 0) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0) throw badRequest('Invalid cursor');
  return { createdAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
}

/** Slice a `limit + 1` result into a page with a next cursor. */
export function toPage<T extends { id: string; createdAt: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  return { items, nextCursor: encodeCursor(last.createdAt, last.id) };
}
