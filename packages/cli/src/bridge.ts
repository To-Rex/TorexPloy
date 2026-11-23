/**
 * `torex mcp`: TorexPloy's MCP server on stdio, for clients that start a
 * program instead of calling an address (Claude Desktop, Cursor, Windsurf,
 * Codex, Zed, …).
 *
 * It is a bridge, not a second server: each JSON-RPC line read from stdin is
 * posted to the panel's `/mcp` with the profile's token, and what comes back
 * (a JSON answer, or the events of a streamed one) is written to stdout, one
 * message per line. The headers the HTTP transport mirrors (protocol version,
 * method, name) are filled in from the message, so clients of either era of
 * the protocol work unchanged. Nothing else is ever written to stdout.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { readSse } from './client.ts';

export interface BridgeOptions {
  url: string | null;
  token: string | null;
  agent: string;
  input?: Readable;
  output?: Writable;
  log?: (line: string) => void;
}

const NAMED = new Set(['tools/call', 'prompts/get', 'resources/read']);

/** A header value as MCP wants it: plain when it is plain ASCII, `=?base64?…?=` otherwise. */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !(value.startsWith('=?base64?') && value.endsWith('?='));
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

/** The headers a request travels with. `legacyVersion` is what `initialize` agreed on, for clients that opened with it. */
export function headersFor(message: Message, legacyVersion: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const method = typeof message.method === 'string' ? message.method : '';
  const meta = message.params?._meta;
  const declared = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] : undefined;
  if (typeof declared === 'string') headers['mcp-protocol-version'] = declared;
  else if (method !== 'initialize' && legacyVersion !== null) headers['mcp-protocol-version'] = legacyVersion;
  if (method.length > 0) headers['mcp-method'] = method;
  if (NAMED.has(method)) {
    const name = method === 'resources/read' ? message.params?.uri : message.params?.name;
    if (typeof name === 'string') headers['mcp-name'] = encodeHeaderValue(name);
  }
  return headers;
}

export function runBridge(options: BridgeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => process.stderr.write(`[torex mcp] ${line}\n`));
  const inflight = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  let legacyVersion: string | null = null;

  const write = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (id: unknown, message: string, code = -32603): void => {
    if (typeof id === 'string' || typeof id === 'number') write({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const forward = async (message: Message, line: string): Promise<void> => {
    const id = message.id;
    const isRequest = typeof id === 'string' || typeof id === 'number';
    if (options.url === null || options.token === null) {
      fail(id, 'torex is not signed in to a TorexPloy panel. Run: torex login <panel address>');
      return;
    }
    const controller = new AbortController();
    if (isRequest) inflight.set(String(id), controller);
    try {
      const response = await fetch(`${options.url}/mcp`, {
        method: 'POST',
        headers: { ...headersFor(message, legacyVersion), authorization: `Bearer ${options.token}`, 'user-agent': options.agent },
        body: line,
        signal: controller.signal,
      });
      if (response.status === 202 || response.status === 204) return;
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('text/event-stream') && response.body !== null) {
        for await (const event of readSse(response.body, controller.signal)) {
          if (event.data.length === 0) continue;
          try {
            write(JSON.parse(event.data));
          } catch {
            log(`ignored a stream event that is not JSON: ${event.data.slice(0, 80)}`);
          }
        }
        return;
      }
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const rpc = parsed !== null && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed || Array.isArray(parsed));
      if (rpc) {
        if (message.method === 'initialize' && typeof (parsed as { result?: { protocolVersion?: unknown } }).result?.protocolVersion === 'string') {
          legacyVersion = (parsed as { result: { protocolVersion: string } }).result.protocolVersion;
        }
        // A JSON-RPC error that came without the request's id (the server could not read it) still belongs to this request.
        if (isRequest && 'error' in (parsed as object) && (parsed as { id?: unknown }).id === null) write({ ...(parsed as object), id });
        else write(parsed);
        return;
      }
      if (response.status === 401) fail(id, 'TorexPloy refused the sign-in: the token was revoked or has expired. Run: torex login');
      else if (response.status === 503) fail(id, 'The MCP server is switched off on this TorexPloy panel (Settings → CLI and MCP).');
      else fail(id, `TorexPloy answered ${response.status}${text.length > 0 && text.length < 300 ? `: ${text}` : ''}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      fail(id, `Cannot reach ${options.url}${cause === undefined ? '' : ` (${cause})`}: ${(error as Error).message}`);
    } finally {
      if (isRequest) inflight.delete(String(id));
    }
  };

  return new Promise((resolve) => {
    const reader = createInterface({ input, crlfDelay: Infinity });
    reader.on('line', (raw) => {
      const line = raw.trim();
      if (line.length === 0) return;
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (typeof message !== 'object' || message === null || Array.isArray(message)) {
        // A batch (2025-03-26 clients) goes as it is.
        const task = Array.isArray(message) ? forward({}, line) : Promise.resolve();
        pending.add(task);
        void task.finally(() => pending.delete(task));
        return;
      }
      if (typeof message.method !== 'string') return; // A response from the client: this server never asks it anything.
      if (message.method === 'notifications/cancelled') {
        const requestId = message.params?.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') inflight.get(String(requestId))?.abort();
      }
      const task = forward(message, line);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    reader.on('close', () => {
      // The client closed stdin: finish what is in flight (briefly), then stop.
      const deadline = new Promise((done) => setTimeout(done, 10_000).unref());
      void Promise.race([Promise.allSettled([...pending]), deadline]).then(() => resolve());
    });
  });
}
