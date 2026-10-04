/** Client-side validation with the same zod schemas the server uses. */
import type { ZodType } from 'zod';
import type { Messages } from '../i18n/index.tsx';
import { issueText } from './errors.ts';

export function validate<T>(m: Messages, schema: ZodType<T>, value: unknown): { data: T; errors: null } | { data: null; errors: Record<string, string> } {
  const result = schema.safeParse(value);
  if (result.success) return { data: result.data, errors: null };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.');
    if (errors[path] !== undefined) continue;
    const raw = issue as unknown as Record<string, unknown>;
    const params: Record<string, string | number> = {};
    for (const key of ['minimum', 'maximum', 'format', 'origin', 'expected']) {
      const v = raw[key];
      if (typeof v === 'string' || typeof v === 'number') params[key] = v;
      if (typeof v === 'bigint') params[key] = Number(v);
    }
    const reason = (raw.params as { reason?: string } | undefined)?.reason;
    if (reason !== undefined) params.reason = reason;
    errors[path] = issueText(m, { path, code: issue.code, message: issue.message, params });
  }
  return { data: null, errors };
}
