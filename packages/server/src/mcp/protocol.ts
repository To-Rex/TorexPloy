/**
 * The Model Context Protocol, as far as a server needs it: JSON-RPC
 * messages, the errors MCP defines, and the request metadata that tells the
 * two eras of the protocol apart.
 *
 * Revision 2026-07-28 is stateless: every request names its protocol version
 * and the client's capabilities in `_meta`, and there is no handshake. Earlier
 * revisions open with `initialize`. Clients of both eras are in use, so the
 * server answers both on one endpoint ("dual-era"): a request with the modern
 * `_meta` is served by the modern rules, anything else by the legacy ones.
 */
import { MCP_LEGACY_VERSIONS, MCP_MODERN_VERSIONS, MCP_VERSIONS } from '@ploy/shared';

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Absent for a notification. */
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId | null; result: Record<string, unknown> } | { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string; data?: unknown } };

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Legacy (2025-11-25 and earlier) "resource not found"; the modern revision uses -32602. */
  legacyResourceNotFound: -32002,
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

/** A request that is answered with a JSON-RPC error; `status` is the HTTP status that goes with it. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly status: number;

  constructor(code: number, message: string, options: { data?: unknown; status?: number } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = options.data;
    this.status = options.status ?? 200;
  }
}

export const META = {
  protocolVersion: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

export const LATEST_LEGACY_VERSION = MCP_LEGACY_VERSIONS[0];

export function isModernVersion(version: string): boolean {
  return (MCP_MODERN_VERSIONS as readonly string[]).includes(version);
}

export function isLegacyVersion(version: string): boolean {
  return (MCP_LEGACY_VERSIONS as readonly string[]).includes(version);
}

export function unsupportedVersion(requested: string, status = 400): RpcError {
  return new RpcError(RPC.unsupportedProtocolVersion, 'Unsupported protocol version', { data: { supported: [...MCP_VERSIONS], requested }, status });
}

export function rpcResult(id: JsonRpcId | null, result: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Whatever arrived, as a request or a notification; null when it is not one (a response, or not JSON-RPC at all). */
export function asMessage(value: unknown): JsonRpcRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0' || typeof record.method !== 'string' || record.method.length === 0) return null;
  if (record.id !== undefined && typeof record.id !== 'string' && (typeof record.id !== 'number' || !Number.isFinite(record.id))) return null;
  if (record.params !== undefined && (typeof record.params !== 'object' || record.params === null || Array.isArray(record.params))) return null;
  return record as unknown as JsonRpcRequest;
}

/** The `_meta` object of a request's params, when there is one. */
export function metaOf(message: JsonRpcRequest): Record<string, unknown> | undefined {
  const meta = message.params?._meta;
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
}

/** The protocol version a modern request declares in its `_meta`; null for a legacy request. */
export function declaredVersion(message: JsonRpcRequest): string | null {
  const version = metaOf(message)?.[META.protocolVersion];
  return typeof version === 'string' && version.length > 0 ? version : null;
}

/** The name a request is about, which HTTP mirrors in `Mcp-Name`: a tool or prompt name, or a resource address. */
export function nameOf(message: JsonRpcRequest): string | null {
  if (message.method === 'tools/call' || message.method === 'prompts/get') return typeof message.params?.name === 'string' ? message.params.name : null;
  if (message.method === 'resources/read') return typeof message.params?.uri === 'string' ? message.params.uri : null;
  return null;
}

/** Methods whose requests must name what they are about in `Mcp-Name`. */
export const NAMED_METHODS = new Set(['tools/call', 'prompts/get', 'resources/read']);

/**
 * A header value as the client meant it: values that are not plain ASCII
 * travel as `=?base64?…?=`. Null when the encoding is broken.
 */
export function decodeHeaderValue(value: string): string | null {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice('=?base64?'.length, -2);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** How a client puts a value in a header (used by the `torex mcp` bridge, and here only for tests). */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !(value.startsWith('=?base64?') && value.endsWith('?='));
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}
