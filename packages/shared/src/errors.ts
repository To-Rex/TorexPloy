/**
 * Error contract.
 *
 * The API never returns prose for the UI to display verbatim. It returns a
 * stable `code` (plus optional `params`) that the dashboard translates, and an
 * English `message` for logs, curl users and API clients.
 */

export const ERROR_CODES = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'setup_required',
  'already_setup',
  'invalid_credentials',
  'two_factor_required',
  'invalid_two_factor_code',
  'csrf_failed',
  'docker_unavailable',
  'server_unreachable',
  'proxy_error',
  'git_error',
  'github_not_configured',
  'github_error',
  'deployment_in_progress',
  'nothing_to_deploy',
  'last_owner',
  'invitation_invalid',
  'domain_taken',
  'registry_exists',
  'registry_auth_failed',
  'update_unsupported',
  'update_in_progress',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `domains.0.host`. */
  path: string;
  /** Zod issue code (`too_small`, `invalid_format`, …) or a custom one. */
  code: string;
  message: string;
  /** Machine-readable bounds for translation, e.g. `{ minimum: 10 }`. */
  params?: Record<string, string | number>;
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    params?: Record<string, string | number>;
    issues?: ValidationIssue[];
    requestId?: string;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}
