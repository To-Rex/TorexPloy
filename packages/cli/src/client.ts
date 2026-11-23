/**
 * Talking to a panel: JSON requests with the profile's token, errors turned
 * into sentences, and Server-Sent Events read as they arrive (build logs,
 * container logs, TorexAi's replies).
 */
import { CliError } from './ui.ts';

export interface ApiErrorBody {
  error?: { code?: string; message?: string; params?: Record<string, unknown>; issues?: { path: string; message: string }[] };
}

export class ApiError extends CliError {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** A raw body (an upload) instead of JSON. */
  raw?: Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** The events of a Server-Sent Events body, one at a time. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let id: string | undefined;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.search(/\r?\n/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
        if (line === '') {
          if (data.length > 0) yield { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
          event = 'message';
          data = [];
          id = undefined;
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const text = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = text;
          else if (field === 'data') data.push(text);
          else if (field === 'id') id = text;
        }
        newline = buffer.search(/\r?\n/);
      }
    }
    // A last line the stream ended without a newline after.
    const tail = buffer.replace(/\r$/, '');
    if (tail.length > 0 && !tail.startsWith(':')) {
      const colon = tail.indexOf(':');
      const field = colon === -1 ? tail : tail.slice(0, colon);
      const text = colon === -1 ? '' : tail.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(text);
      else if (field === 'event') event = text;
    }
    if (data.length > 0) yield { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export class Client {
  readonly url: string;
  private readonly token: string | null;
  private readonly agent: string;

  constructor(url: string, token: string | null, agent: string) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.agent = agent;
  }

  private address(path: string, query: RequestOptions['query']): string {
    const url = new URL(path, `${this.url}/`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    return url.toString();
  }

  async fetch(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': this.agent, accept: 'application/json', ...options.headers };
    if (this.token !== null) headers.authorization = `Bearer ${this.token}`;
    let body: BodyInit | undefined;
    if (options.raw !== undefined) {
      body = options.raw as unknown as BodyInit;
      headers['content-type'] ??= 'application/octet-stream';
      headers['content-length'] = String(options.raw.byteLength);
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    try {
      return await fetch(this.address(path, options.query), { method, headers, ...(body === undefined ? {} : { body }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      throw new CliError(`Cannot reach ${this.url}: ${cause?.code ?? cause?.message ?? (error as Error).message}`);
    }
  }

  /** A JSON request; anything but success becomes an `ApiError` worded for a person. */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.fetch(method, path, options);
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) throw this.failure(response.status, parsed);
    return parsed as T;
  }

  failure(status: number, parsed: unknown): ApiError {
    const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as ApiErrorBody;
    const code = body.error?.code ?? `http_${status}`;
    let message = body.error?.message ?? (typeof parsed === 'string' && parsed.length > 0 && parsed.length < 300 ? parsed : `The panel answered ${status}`);
    const reason = body.error?.params?.reason;
    if (status === 401) message = 'Not signed in, or the token was revoked or has expired. Run: torex login';
    else if (reason === 'token_read_only') message = 'This sign-in can only read. Sign in again with more access: torex login';
    else if (reason === 'token_no_destroy') message = 'This sign-in may change things but not delete or destroy them. Sign in again with full access to do this: torex login';
    const issues = body.error?.issues ?? [];
    if (issues.length > 0) message += `\n${issues.map((issue) => `  ${issue.path === '' ? '' : `${issue.path}: `}${issue.message}`).join('\n')}`;
    return new ApiError(status, code, message);
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, query === undefined ? {} : { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body === undefined ? {} : { body });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /** Follow an event stream until it ends, the handler returns `false`, or the signal fires. */
  async stream(path: string, query: RequestOptions['query'], handle: (event: SseEvent) => boolean | void | Promise<boolean | void>, signal?: AbortSignal): Promise<void> {
    const response = await this.fetch('GET', path, { query, headers: { accept: 'text/event-stream' }, ...(signal === undefined ? {} : { signal }) });
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '');
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON.
      }
      throw this.failure(response.status, parsed);
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for await (const event of readSse(response.body, controller.signal)) {
        if ((await handle(event)) === false) break;
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      controller.abort();
    }
  }
}
