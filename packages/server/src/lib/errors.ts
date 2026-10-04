/**
 * Error taxonomy.
 *
 * Anything that crosses the HTTP boundary is an `AppError` carrying a stable
 * code from the shared contract; the HTTP layer maps it to a status and the
 * dashboard translates it. Any other thrown value is a bug and becomes a 500
 * with a request id, never a stack trace.
 */
import type { ErrorCode, ValidationIssue } from '@ploy/shared';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  setup_required: 428,
  already_setup: 409,
  invalid_credentials: 401,
  two_factor_required: 401,
  invalid_two_factor_code: 401,
  csrf_failed: 403,
  docker_unavailable: 503,
  server_unreachable: 502,
  proxy_error: 502,
  git_error: 502,
  github_not_configured: 409,
  github_error: 502,
  deployment_in_progress: 409,
  nothing_to_deploy: 409,
  last_owner: 409,
  invitation_invalid: 410,
  domain_taken: 409,
  registry_exists: 409,
  registry_auth_failed: 422,
  internal_error: 500,
};

export interface AppErrorOptions {
  params?: Record<string, string | number>;
  issues?: ValidationIssue[];
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly params: Record<string, string | number> | undefined;
  readonly issues: ValidationIssue[] | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.params = options.params;
    this.issues = options.issues;
  }
}

export const badRequest = (message: string, params?: Record<string, string | number>): AppError =>
  new AppError('bad_request', message, params === undefined ? {} : { params });
export const notFound = (what: string): AppError => new AppError('not_found', `${what} not found`, { params: { resource: what } });
export const forbidden = (message = 'You do not have permission to do this'): AppError => new AppError('forbidden', message);
export const conflict = (message: string, params?: Record<string, string | number>): AppError =>
  new AppError('conflict', message, params === undefined ? {} : { params });
export const unauthorized = (message = 'Authentication required'): AppError => new AppError('unauthorized', message);

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * A stable, translatable reason code for a failure: the explicit
 * `params.reason` when the thrower set one, else derived from the error type.
 * The dashboard maps these to localized text and shows the English message
 * only as technical detail.
 */
export function reasonOf(value: unknown, fallback = 'unknown'): string {
  if (value instanceof AppError) {
    const reason = value.params?.reason;
    if (typeof reason === 'string') return reason;
    const byCode: Partial<Record<ErrorCode, string>> = {
      server_unreachable: 'server_not_ready',
      docker_unavailable: 'docker_unreachable',
      proxy_error: 'proxy',
      git_error: 'git',
      github_error: 'github',
      nothing_to_deploy: 'image_gone',
    };
    return byCode[value.code] ?? fallback;
  }
  if (value instanceof Error) {
    if (value.name === 'DockerUnavailableError') return 'docker_unreachable';
    if (value.name === 'DockerError') return 'docker_error';
  }
  return fallback;
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
