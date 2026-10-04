/** Turn API errors and validation issues into localized text. */
import type { ValidationIssue } from '@ploy/shared';
import { interpolate, type Messages } from '../i18n/index.tsx';
import { ApiError } from './api.ts';

export function errorText(m: Messages, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'network') return m.errors.network;
    // Prefer the specific server message for codes whose generic text would hide useful detail.
    const detailed = ['git_error', 'docker_unavailable', 'server_unreachable', 'proxy_error', 'github_error', 'bad_request', 'conflict', 'forbidden'] as const;
    if ((detailed as readonly string[]).includes(error.code) && error.message.length > 0 && error.message.length < 400) return error.message;
    return interpolate(m.errors.codes[error.code] ?? m.errors.unknown, error.params);
  }
  return m.errors.unknown;
}

export function issueText(m: Messages, issue: ValidationIssue): string {
  const params = issue.params ?? {};
  const v = m.validation;
  if (params.reason === 'duplicate') return v.duplicate;
  switch (issue.code) {
    case 'too_small':
      if (params.origin === 'string' && params.minimum === 1) return v.required;
      return interpolate(params.origin === 'string' ? v.tooShort : v.tooSmall, params);
    case 'too_big':
      return interpolate(params.origin === 'string' ? v.tooLong : v.tooBig, params);
    case 'invalid_format':
      if (params.format === 'email') return v.email;
      if (issue.path.endsWith('host') || issue.path.endsWith('Domain')) return v.hostname;
      if (issue.path.endsWith('key')) return v.envKey;
      return v.format;
    case 'invalid_type':
      return params.expected === 'int' || params.expected === 'number' ? v.integer : v.required;
    default:
      return issue.message.length > 0 && issue.code === 'custom' ? issue.message : v.invalid;
  }
}

/** Localized text for a server/deployment/service failure reason, with the raw message as detail. */
export function reasonText(m: Messages, kind: 'server' | 'deploy' | 'service', code: string | null, message: string | null): { text: string; detail: string | null } {
  const table = m.reasons[kind] as Record<string, string>;
  const known = code === null ? undefined : table[code];
  if (known === undefined) return { text: message ?? table.unknown!, detail: null };
  return { text: known, detail: message !== null && message !== known ? message : null };
}

/** Map issues to `{ field: message }`, keeping the first message per field. */
export function fieldErrors(m: Messages, error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const issue of error.issues) if (out[issue.path] === undefined) out[issue.path] = issueText(m, issue);
  return out;
}
