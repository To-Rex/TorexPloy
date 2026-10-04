/**
 * Typed error taxonomy.
 *
 * Every error that crosses the HTTP boundary is an `AppError`, so the server
 * can map it to a status code and a stable machine-readable `code` without
 * leaking internals. Anything else becomes a 500 with a correlation id.
 */

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'setup_required'
  | 'already_setup'
  | 'engine_unavailable'
  | 'proxy_error'
  | 'git_error'
  | 'build_failed'
  | 'deploy_failed'
  | 'health_check_failed'
  | 'dependency_missing'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
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
  engine_unavailable: 503,
  proxy_error: 502,
  git_error: 502,
  build_failed: 500,
  deploy_failed: 500,
  health_check_failed: 502,
  dependency_missing: 501,
  internal_error: 500,
};

export interface AppErrorOptions {
  /** Extra structured context attached to logs and (when `PLOY_LOG_LEVEL=debug`) to the response. */
  details?: Record<string, unknown>;
  /** Underlying error, preserved for logging. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** Set by the HTTP layer to correlate a response with a log line. */
  requestId?: string;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    if (options.details !== undefined) this.details = options.details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('bad_request', message, details === undefined ? {} : { details });
export const validationFailed = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('validation_failed', message, details === undefined ? {} : { details });
export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError('unauthorized', message);
export const forbidden = (message = 'Insufficient permissions'): AppError =>
  new AppError('forbidden', message);
export const notFound = (what: string): AppError => new AppError('not_found', `${what} not found`);
export const conflict = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('conflict', message, details === undefined ? {} : { details });
export const rateLimited = (message = 'Too many requests'): AppError =>
  new AppError('rate_limited', message);
export const internal = (message: string, cause?: unknown): AppError =>
  new AppError('internal_error', message, cause === undefined ? {} : { cause });

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalize any thrown value into an `AppError` for consistent responses. */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    const err = new AppError('internal_error', value.message, { cause: value });
    return err;
  }
  return new AppError('internal_error', String(value));
}