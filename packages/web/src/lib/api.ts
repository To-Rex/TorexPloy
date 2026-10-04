/**
 * Typed API client. Every mutation carries the anti-CSRF header the server
 * requires; every failure becomes an {@link ApiError} with a stable code the
 * UI can translate.
 */
import { isApiErrorBody, type ErrorCode, type ValidationIssue } from '@ploy/shared';

export class ApiError extends Error {
  readonly code: ErrorCode | 'network';
  readonly status: number;
  readonly params: Record<string, string | number>;
  readonly issues: ValidationIssue[];
  readonly requestId: string | null;

  constructor(code: ErrorCode | 'network', message: string, status: number, extra: { params?: Record<string, string | number>; issues?: ValidationIssue[]; requestId?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.params = extra.params ?? {};
    this.issues = extra.issues ?? [];
    this.requestId = extra.requestId ?? null;
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Ploy-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('network', 'Network error', 0);
  }
  const text = await response.text();
  const data: unknown = text.length > 0 ? safeJson(text) : null;
  if (!response.ok) {
    if (isApiErrorBody(data)) {
      throw new ApiError(data.error.code, data.error.message, response.status, {
        ...(data.error.params === undefined ? {} : { params: data.error.params }),
        ...(data.error.issues === undefined ? {} : { issues: data.error.issues }),
        ...(data.error.requestId === undefined ? {} : { requestId: data.error.requestId }),
      });
    }
    throw new ApiError('internal_error', `HTTP ${response.status}`, response.status);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  const encoded = search.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}
