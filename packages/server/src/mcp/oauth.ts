/**
 * OAuth for MCP clients: how claude.ai, Claude Desktop, Cursor, VS Code and
 * other apps connect to TorexPloy without anyone copying a token.
 *
 * The panel is both the protected resource (`/mcp`) and its authorization
 * server, implementing the subset of OAuth 2.1 the MCP specification asks
 * for: protected resource metadata (RFC 9728), authorization server metadata
 * (RFC 8414), the authorization code flow with PKCE (S256 only), refresh
 * token rotation, the `iss` response parameter (RFC 9207), resource
 * indicators (RFC 8707), revocation (RFC 7009), and both ways an unknown app
 * can identify itself: by registering (RFC 7591) or by the address of its own
 * client metadata document.
 *
 * The person decides on a page of the dashboard: which team the app acts in
 * and how far it reaches (read, write, full). What the app then gets is an
 * ordinary API token of kind `oauth`, good for the MCP endpoint only, for an
 * hour at a time; the grant behind it is listed under Settings → CLI and MCP
 * until the person removes it.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Hono } from 'hono';
import {
  API_TOKEN_PREFIX,
  connectDecisionSchema,
  MCP_PATH,
  TOKEN_ACCESS,
  type ConnectRequestDto,
  type ConnectWarning,
  type TokenAccess,
} from '@ploy/shared';
import type { Context } from '../context.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { constantTimeEqual, generateToken, sha256 } from '../lib/crypto.ts';
import { randomId } from '../lib/ids.ts';
import { audit, body, isPrivateAddress, RateLimiter, requestOrigin, requireAuth, type Ctx, type Env } from '../http/core.ts';
import type { OAuthAuthMethod, OAuthClientRecord } from '../store/index.ts';
import type { McpManager } from './manager.ts';

/** How long an access token lasts; the app trades its refresh token for the next one. */
export const ACCESS_TOKEN_TTL_S = 3_600;
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 3_600_000;
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_MAX = 2_000;
const CLIENTS_MAX = 2_000;
const METADATA_DOC_MAX_BYTES = 64 * 1024;

type Fetcher = typeof fetch;

interface PendingRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string | null;
  resource: string | null;
  issuer: string;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  grantId: string;
  expiresAt: number;
}

/** What an app says about itself, from its registration or its metadata document. */
interface ClientInfo {
  id: string;
  kind: 'dcr' | 'cimd';
  name: string;
  uri: string | null;
  redirectUris: string[];
}

export class OAuthError extends Error {
  readonly error: string;
  readonly status: number;

  constructor(error: string, description: string, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** Why a redirect address cannot be registered; null when it can. */
export function redirectProblem(value: string): string | null {
  if (value.length > 2_000) return 'too long';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not an absolute URL';
  }
  if (url.hash !== '') return 'must not have a fragment';
  if (url.username !== '' || url.password !== '') return 'must not carry credentials';
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'ftp', 'ws', 'wss', 'mailto', 'tel'].includes(scheme)) return `the ${scheme}: scheme is not allowed`;
  if (scheme === 'http' && !isLoopbackHost(url.hostname)) return 'http:// is allowed only for localhost';
  if (scheme !== 'http' && scheme !== 'https' && !/^[a-z][a-z0-9+.-]{1,60}$/.test(scheme)) return 'the scheme is not valid';
  return null;
}

/**
 * Whether a redirect address matches a registered one: exactly, or for an app
 * on the person's own machine, with any port (RFC 8252: native apps listen on
 * whatever port is free).
 */
export function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    return a.protocol === 'http:' && b.protocol === 'http:' && isLoopbackHost(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** PKCE S256: the challenge is the hash of the verifier. */
function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return constantTimeEqual(base64url(Buffer.from(sha256Buffer(verifier))), challenge);
}

function sha256Buffer(value: string): Buffer {
  return Buffer.from(sha256(value), 'hex');
}

/** An address that is reachable from the internet: not private, loopback, link-local, shared or reserved. */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^::ffff:/i, '').toLowerCase();
  if (isPrivateAddress(ip)) return false;
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    if (a === 0 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    if (ip === '::' || ip === '::1') return false;
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip)) return false;
    return true;
  }
  return false;
}

export class OAuthServer {
  private readonly ctx: Context;
  private readonly mcp: McpManager;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly documents = new Map<string, { info: ClientInfo; expiresAt: number }>();
  private fetcher: Fetcher = fetch;
  private resolver: (hostname: string) => Promise<string[]> = async (hostname) => (await lookup(hostname, { all: true })).map((entry) => entry.address);

  constructor(ctx: Context, mcp: McpManager) {
    this.ctx = ctx;
    this.mcp = mcp;
  }

  /** Tests answer in place of the internet. */
  useNetwork(fetcher: Fetcher, resolver?: (hostname: string) => Promise<string[]>): void {
    this.fetcher = fetcher;
    if (resolver !== undefined) this.resolver = resolver;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, request] of this.pending) if (request.expiresAt < now) this.pending.delete(id);
    for (const [hash, code] of this.codes) if (code.expiresAt < now) this.codes.delete(hash);
    for (const [url, document] of this.documents) if (document.expiresAt < now) this.documents.delete(url);
  }

  // ------------------------------------------------------------- metadata

  protectedResource(origin: string): Record<string, unknown> {
    return {
      resource: `${origin}${MCP_PATH}`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      resource_name: 'TorexPloy',
      resource_documentation: `${origin}/guide/cli-mcp`,
    };
  }

  authorizationServer(origin: string): Record<string, unknown> {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${origin}/guide/cli-mcp`,
    };
  }

  // -------------------------------------------------------------- clients

  /** RFC 7591: an app registers itself. Its name is its own claim, which is why the consent page shows where it sends people back to. */
  register(input: unknown): Record<string, unknown> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new OAuthError('invalid_client_metadata', 'The registration must be a JSON object');
    const fields = input as Record<string, unknown>;
    const redirects = fields.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10 || !redirects.every((value) => typeof value === 'string')) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list between 1 and 10 addresses');
    }
    for (const value of redirects as string[]) {
      const problem = redirectProblem(value);
      if (problem !== null) throw new OAuthError('invalid_redirect_uri', `${value}: ${problem}`);
    }
    const grantTypes = Array.isArray(fields.grant_types) ? fields.grant_types : ['authorization_code'];
    if (!grantTypes.every((value) => value === 'authorization_code' || value === 'refresh_token')) throw new OAuthError('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported');
    const responseTypes = Array.isArray(fields.response_types) ? fields.response_types : ['code'];
    if (!responseTypes.every((value) => value === 'code')) throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported');
    const requested = typeof fields.token_endpoint_auth_method === 'string' ? fields.token_endpoint_auth_method : 'none';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(requested)) throw new OAuthError('invalid_client_metadata', `token_endpoint_auth_method ${requested} is not supported`);
    const method = requested as OAuthAuthMethod;
    const name = typeof fields.client_name === 'string' && fields.client_name.trim().length > 0 ? fields.client_name.trim().slice(0, 80) : 'MCP client';
    const uri = typeof fields.client_uri === 'string' && /^https:\/\//.test(fields.client_uri) ? fields.client_uri.slice(0, 300) : null;
    const { oauth } = this.ctx.stores;
    if (oauth.countClients() >= CLIENTS_MAX) {
      oauth.pruneClients(new Date(Date.now() - 24 * 3_600_000).toISOString());
      if (oauth.countClients() >= CLIENTS_MAX) throw new OAuthError('temporarily_unavailable', 'Too many apps are registered; try again later', 503);
    }
    const secret = method === 'none' ? null : generateToken(32);
    const client = oauth.createClient({ kind: 'dcr', name, uri, redirectUris: redirects as string[], secret, authMethod: method });
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
      client_name: client.name,
      ...(client.uri === null ? {} : { client_uri: client.uri }),
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    };
  }

  /**
   * What an app is, by its client id: a registration here, or the metadata
   * document at the address that is its id. A document is fetched only for a
   * person who is signed in (from the consent page), only over HTTPS, only
   * from public addresses, without following redirects, and small.
   */
  async clientInfo(clientId: string): Promise<ClientInfo> {
    if (!/^https:\/\//i.test(clientId)) {
      const client = this.ctx.stores.oauth.client(clientId);
      if (client === undefined || client.kind !== 'dcr') throw new OAuthError('invalid_client', 'This app is not registered here; it has to register again');
      return { id: client.id, kind: 'dcr', name: client.name, uri: client.uri, redirectUris: client.redirectUris };
    }
    const cached = this.documents.get(clientId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.info;
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new OAuthError('invalid_client', 'The client id is not a valid address');
    }
    if (url.protocol !== 'https:' || url.pathname === '/' || url.hash !== '' || url.username !== '' || url.password !== '') throw new OAuthError('invalid_client', 'A client id address must be https with a path');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) === 0 ? await this.resolver(host).catch(() => [] as string[]) : [host];
    if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new OAuthError('invalid_client', `${url.hostname} is not a public address`);
    let response: Response;
    try {
      response = await this.fetcher(url, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new OAuthError('invalid_client', `The app's description could not be fetched from ${url.hostname}`);
    }
    if (!response.ok || response.body === null) throw new OAuthError('invalid_client', `${url.hostname} answered ${response.status} for the app's description`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > METADATA_DOC_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new OAuthError('invalid_client', "The app's description is too large");
      }
      chunks.push(value);
    }
    let document: Record<string, unknown>;
    try {
      document = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new OAuthError('invalid_client', "The app's description is not JSON");
    }
    if (typeof document !== 'object' || document === null || document.client_id !== clientId) throw new OAuthError('invalid_client', "The app's description does not name itself with this address");
    const redirects = document.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every((value) => typeof value === 'string' && redirectProblem(value) === null)) {
      throw new OAuthError('invalid_client', "The app's description has no usable redirect_uris");
    }
    const method = document.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') throw new OAuthError('invalid_client', `token_endpoint_auth_method ${String(method)} is not supported for apps described by a document`);
    const info: ClientInfo = {
      id: clientId,
      kind: 'cimd',
      name: typeof document.client_name === 'string' && document.client_name.trim().length > 0 ? document.client_name.trim().slice(0, 80) : url.hostname,
      uri: typeof document.client_uri === 'string' && /^https:\/\//.test(document.client_uri) ? document.client_uri.slice(0, 300) : null,
      redirectUris: redirects as string[],
    };
    this.documents.set(clientId, { info, expiresAt: Date.now() + 10 * 60_000 });
    return info;
  }

  // ------------------------------------------------------- authorization

  /**
   * The start of the flow, in the person's browser. What can be checked
   * without knowing who they are is checked here; the rest, with the app's
   * description, on the consent page. Nothing is redirected back to the app
   * until the request is known to be good.
   */
  async authorize(query: Record<string, string | undefined>, issuer: string): Promise<{ consent: string } | { invalid: string }> {
    this.sweep();
    const clientId = query.client_id ?? '';
    const redirectUri = query.redirect_uri ?? '';
    if (clientId.length === 0 || clientId.length > 1_000) return { invalid: 'client' };
    if (redirectUri.length === 0 || redirectProblem(redirectUri) !== null) return { invalid: 'redirect' };
    if (!/^https:\/\//i.test(clientId)) {
      const client = this.ctx.stores.oauth.client(clientId);
      if (client === undefined) return { invalid: 'client' };
      if (!client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) return { invalid: 'redirect' };
    }
    if (query.response_type !== 'code') return { invalid: 'response_type' };
    const challenge = query.code_challenge ?? '';
    if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return { invalid: 'pkce' };
    const resource = query.resource ?? null;
    if (resource !== null && !this.resourceMatches(resource, issuer)) return { invalid: 'resource' };
    if (this.pending.size >= PENDING_MAX) {
      const oldest = [...this.pending.keys()][0];
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    const id = randomId(24);
    this.pending.set(id, {
      id,
      clientId,
      redirectUri,
      state: query.state === undefined ? null : query.state.slice(0, 1_000),
      codeChallenge: challenge,
      scope: query.scope === undefined ? null : query.scope.slice(0, 500),
      resource,
      issuer,
      expiresAt: Date.now() + REQUEST_TTL_MS,
    });
    return { consent: id };
  }

  /** The resource an app asks a token for must be this panel's MCP endpoint (or the panel itself). */
  private resourceMatches(resource: string, issuer: string): boolean {
    try {
      const url = new URL(resource);
      const panel = new URL(issuer);
      return url.host.toLowerCase() === panel.host.toLowerCase() && (url.pathname === MCP_PATH || url.pathname === `${MCP_PATH}/` || url.pathname === '/' || url.pathname === '');
    } catch {
      return false;
    }
  }

  private request(id: string): PendingRequest {
    this.sweep();
    const request = this.pending.get(id);
    if (request === undefined) throw new AppError('not_found', 'This request to connect an app has expired; start again from the app', { params: { resource: 'connect_request' } });
    return request;
  }

  /** For the consent page. */
  async describe(id: string, userId: string, currentTeamId: string | null): Promise<ConnectRequestDto> {
    const request = this.request(id);
    let info: ClientInfo;
    try {
      info = await this.clientInfo(request.clientId);
    } catch (error) {
      this.pending.delete(id);
      throw new AppError('bad_request', error instanceof OAuthError ? error.message : 'The app could not be identified', { params: { reason: 'invalid_client' } });
    }
    if (!info.redirectUris.some((registered) => redirectMatches(registered, request.redirectUri))) {
      this.pending.delete(id);
      throw new AppError('bad_request', 'The app asked to return somewhere it did not register', { params: { reason: 'invalid_redirect' } });
    }
    const redirect = new URL(request.redirectUri);
    const warnings: ConnectWarning[] = [];
    if (redirect.protocol === 'http:') warnings.push(isLoopbackHost(redirect.hostname) ? 'localhost' : 'http');
    else if (redirect.protocol !== 'https:') warnings.push('custom_scheme');
    const teams = this.ctx.stores.teams.listForUser(userId).map((entry) => ({ id: entry.team.id, name: entry.team.name, role: entry.role }));
    const scopes = (request.scope ?? '').split(/\s+/);
    const requestedAccess = (TOKEN_ACCESS as readonly string[]).find((access) => scopes.includes(access)) as TokenAccess | undefined;
    return {
      id,
      client: { name: info.name, uri: info.uri, kind: info.kind },
      redirectUri: request.redirectUri,
      redirectHost: redirect.protocol === 'http:' || redirect.protocol === 'https:' ? redirect.host : `${redirect.protocol}//${redirect.host}`,
      warnings,
      requestedAccess: requestedAccess ?? null,
      teams,
      currentTeamId,
      expiresAt: new Date(request.expiresAt).toISOString(),
    };
  }

  private redirect(request: PendingRequest, params: Record<string, string>): string {
    const url = new URL(request.redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (request.state !== null) url.searchParams.set('state', request.state);
    url.searchParams.set('iss', request.issuer);
    return url.toString();
  }

  /** The person said yes: a grant, and a one-time code for the app to trade for tokens. */
  async approve(id: string, auth: { userId: string; ip: string }, input: { teamId: string; access: TokenAccess }): Promise<{ redirect: string; grantId: string; clientName: string }> {
    const request = this.request(id);
    const info = await this.clientInfo(request.clientId).catch((error: unknown) => {
      throw new AppError('bad_request', error instanceof OAuthError ? error.message : 'The app could not be identified', { params: { reason: 'invalid_client' } });
    });
    if (!info.redirectUris.some((registered) => redirectMatches(registered, request.redirectUri))) throw new AppError('bad_request', 'The app asked to return somewhere it did not register');
    const role = this.ctx.stores.teams.getRole(input.teamId, auth.userId);
    if (role === undefined) throw new AppError('forbidden', 'You are not a member of that team');
    if (role === 'viewer') throw new AppError('forbidden', 'Connecting apps needs the developer role in the team', { params: { reason: 'role' } });
    const { oauth } = this.ctx.stores;
    if (info.kind === 'cimd') oauth.createClient({ id: info.id, kind: 'cimd', name: info.name, uri: info.uri, redirectUris: info.redirectUris, secret: null, authMethod: 'none' });
    oauth.touchClient(info.id);
    const grant = oauth.createGrant({ clientId: info.id, userId: auth.userId, teamId: input.teamId, access: input.access, redirectUri: request.redirectUri, resource: request.resource });
    const code = generateToken(32);
    this.codes.set(sha256(code), { clientId: info.id, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, grantId: grant.id, expiresAt: Date.now() + CODE_TTL_MS });
    this.pending.delete(id);
    return { redirect: this.redirect(request, { code }), grantId: grant.id, clientName: info.name };
  }

  /** The person said no: the app is told so, at the address it registered. */
  async deny(id: string): Promise<{ redirect: string }> {
    const request = this.request(id);
    const info = await this.clientInfo(request.clientId).catch(() => null);
    this.pending.delete(id);
    if (info === null || !info.redirectUris.some((registered) => redirectMatches(registered, request.redirectUri))) throw new AppError('bad_request', 'The app could not be identified');
    return { redirect: this.redirect(request, { error: 'access_denied', error_description: 'The person declined to connect this app' }) };
  }

  // --------------------------------------------------------------- tokens

  private authenticateClient(form: URLSearchParams, header: string | undefined): OAuthClientRecord {
    let clientId = form.get('client_id') ?? '';
    let secret = form.get('client_secret');
    if (header !== undefined && /^basic\s+/i.test(header)) {
      const decoded = Buffer.from(header.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon > 0) {
        clientId = decodeURIComponent(decoded.slice(0, colon));
        secret = decodeURIComponent(decoded.slice(colon + 1));
      }
    }
    const client = this.ctx.stores.oauth.client(clientId);
    if (client === undefined) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (client.authMethod !== 'none') {
      if (secret === null || client.secretHash === null || !constantTimeEqual(sha256(secret), client.secretHash)) throw new OAuthError('invalid_client', 'The client secret is wrong', 401);
    }
    return client;
  }

  private issue(grantId: string, client: OAuthClientRecord): Record<string, unknown> {
    const { oauth, tokens } = this.ctx.stores;
    const grant = oauth.grant(grantId);
    if (grant === undefined) throw new OAuthError('invalid_grant', 'The connection was removed');
    // The person may have left the team, or lost the role that let them connect apps, since they said yes.
    const role = this.ctx.stores.teams.getRole(grant.teamId, grant.userId);
    if (role === undefined || role === 'viewer') {
      oauth.deleteGrant(grant.id);
      throw new OAuthError('invalid_grant', 'The person who connected this app no longer has the role for it');
    }
    // The token in use a moment ago stays valid until it runs out, so requests already on their way do not fail.
    const newest = tokens.listForGrant(grant.id)[0];
    tokens.deleteForGrant(grant.id, newest?.id);
    const { token } = tokens.create({
      userId: grant.userId,
      teamId: grant.teamId,
      name: `${client.name} (MCP)`.slice(0, 80),
      expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000).toISOString(),
      tokenPrefix: API_TOKEN_PREFIX,
      kind: 'oauth',
      access: grant.access,
      client: client.name,
      grantId: grant.id,
    });
    const refresh = `${API_TOKEN_PREFIX}r_${generateToken(32)}`;
    oauth.setRefresh(grant.id, refresh, new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString());
    oauth.touchClient(client.id);
    return { access_token: token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh };
  }

  token(form: URLSearchParams, header: string | undefined, issuer: string): Record<string, unknown> {
    this.sweep();
    const grantType = form.get('grant_type');
    const resource = form.get('resource');
    if (resource !== null && !this.resourceMatches(resource, issuer)) throw new OAuthError('invalid_target', 'Tokens here are for this panel’s MCP endpoint only');
    if (grantType === 'authorization_code') {
      const client = this.authenticateClient(form, header);
      const code = form.get('code') ?? '';
      const issued = this.codes.get(sha256(code));
      // One use only, even when the attempt fails.
      this.codes.delete(sha256(code));
      if (issued === undefined || issued.expiresAt < Date.now()) throw new OAuthError('invalid_grant', 'The code is invalid or has expired');
      if (issued.clientId !== client.id) throw new OAuthError('invalid_grant', 'The code was issued to another app');
      if ((form.get('redirect_uri') ?? issued.redirectUri) !== issued.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the one the code was issued for');
      if (!pkceMatches(form.get('code_verifier') ?? '', issued.codeChallenge)) {
        this.ctx.stores.oauth.deleteGrant(issued.grantId);
        throw new OAuthError('invalid_grant', 'The code verifier does not match');
      }
      return this.issue(issued.grantId, client);
    }
    if (grantType === 'refresh_token') {
      const client = this.authenticateClient(form, header);
      const grant = this.ctx.stores.oauth.grantByRefresh(form.get('refresh_token') ?? '');
      if (grant === undefined || grant.clientId !== client.id) throw new OAuthError('invalid_grant', 'The refresh token is invalid, was used already, or has expired');
      return this.issue(grant.id, client);
    }
    throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
  }

  /** RFC 7009: an app lets go of a token. Unknown tokens are not an error. */
  revoke(form: URLSearchParams): void {
    const token = form.get('token') ?? '';
    if (token.length === 0) return;
    const { oauth, tokens } = this.ctx.stores;
    const grant = oauth.grantByRefresh(token);
    if (grant !== undefined) {
      oauth.deleteGrant(grant.id);
      return;
    }
    const record = tokens.resolve(token);
    if (record !== undefined && record.kind === 'oauth') tokens.delete(record.id);
  }

  prune(): void {
    const { oauth, tokens } = this.ctx.stores;
    oauth.pruneGrants(new Date().toISOString());
    oauth.pruneClients(new Date(Date.now() - 30 * 24 * 3_600_000).toISOString());
    tokens.pruneExpired(new Date(Date.now() - 7 * 24 * 3_600_000).toISOString());
  }

  /** Whether OAuth is on; when it is off, apps need a token made by hand. */
  enabled(): boolean {
    const settings = this.mcp.settings();
    return settings.enabled && settings.oauth;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version' };

/** A form body (as OAuth sends it) or JSON (as some clients do anyway). */
async function formOf(c: Ctx): Promise<URLSearchParams> {
  const type = c.req.header('content-type') ?? '';
  const text = await c.req.text();
  if (text.length > 64 * 1024) throw new OAuthError('invalid_request', 'The request is too large');
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch {
      throw new OAuthError('invalid_request', 'The body is not JSON');
    }
  }
  return new URLSearchParams(text);
}

export function registerOAuthRoutes(app: Hono<Env>, ctx: Context, oauth: OAuthServer): void {
  const registerLimiter = new RateLimiter(20, 10);
  const tokenLimiter = new RateLimiter(60, 60);
  const authorizeLimiter = new RateLimiter(60, 30);

  const oauthError = (c: Ctx, error: unknown) => {
    const failure = error instanceof OAuthError ? error : new OAuthError('server_error', 'Something went wrong', 500);
    return c.json({ error: failure.error, error_description: failure.message }, failure.status as 400, { ...CORS, 'Cache-Control': 'no-store' });
  };
  const off = (c: Ctx) => c.json({ error: 'not_found', error_description: 'Connecting apps with OAuth is switched off on this TorexPloy' }, 404, CORS);
  const ip = (c: Ctx): string => c.env.incoming.socket.remoteAddress ?? '0.0.0.0';

  for (const path of ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`]) {
    app.get(path, (c) => (oauth.enabled() ? c.json(oauth.protectedResource(requestOrigin(c)), 200, CORS) : off(c)));
  }
  app.get('/.well-known/oauth-authorization-server', (c) => (oauth.enabled() ? c.json(oauth.authorizationServer(requestOrigin(c)), 200, CORS) : off(c)));
  for (const path of ['/oauth/register', '/oauth/token', '/oauth/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`]) {
    app.options(path, (c) => c.body(null, 204, { ...CORS, 'Access-Control-Max-Age': '600' }));
  }

  app.post('/oauth/register', async (c) => {
    if (!oauth.enabled()) return off(c);
    if (!registerLimiter.take(`oauth-register:${ip(c)}`)) return c.json({ error: 'slow_down', error_description: 'Too many registrations; wait a few minutes' }, 429, CORS);
    try {
      const text = await c.req.text();
      if (text.length > 64 * 1024) throw new OAuthError('invalid_client_metadata', 'The registration is too large');
      let input: unknown;
      try {
        input = JSON.parse(text);
      } catch {
        throw new OAuthError('invalid_client_metadata', 'The registration is not JSON');
      }
      return c.json(oauth.register(input), 201, { ...CORS, 'Cache-Control': 'no-store' });
    } catch (error) {
      return oauthError(c, error);
    }
  });

  app.get('/oauth/authorize', async (c) => {
    if (!oauth.enabled()) return c.redirect('/connect/invalid?reason=off', 302);
    if (!authorizeLimiter.take(`oauth-authorize:${ip(c)}`)) return c.redirect('/connect/invalid?reason=rate_limited', 302);
    const outcome = await oauth.authorize(c.req.query(), requestOrigin(c));
    return 'consent' in outcome ? c.redirect(`/connect/${outcome.consent}`, 302) : c.redirect(`/connect/invalid?reason=${outcome.invalid}`, 302);
  });

  app.post('/oauth/token', async (c) => {
    if (!oauth.enabled()) return off(c);
    if (!tokenLimiter.take(`oauth-token:${ip(c)}`)) return c.json({ error: 'slow_down', error_description: 'Too many requests' }, 429, CORS);
    try {
      const form = await formOf(c);
      return c.json(oauth.token(form, c.req.header('authorization'), requestOrigin(c)), 200, { ...CORS, 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    } catch (error) {
      return oauthError(c, error);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    try {
      oauth.revoke(await formOf(c));
    } catch {
      // RFC 7009: answer 200 whatever was sent.
    }
    return c.body(null, 200, CORS);
  });

  // The consent page, for a signed-in person (a session, not a token: tokens do not connect other apps).
  const signedIn = (c: Ctx) => {
    const auth = requireAuth(c);
    if (auth.sessionId === null) throw new AppError('forbidden', 'Sign in to the dashboard to connect an app');
    return auth;
  };

  app.get('/api/connect/:id', async (c) => {
    const auth = signedIn(c);
    if (!oauth.enabled()) throw notFound('Connect request');
    return c.json(await oauth.describe(c.req.param('id'), auth.user.id, auth.teamId));
  });

  app.post('/api/connect/:id/approve', async (c) => {
    const auth = signedIn(c);
    const input = await body(c, connectDecisionSchema);
    const approved = await oauth.approve(c.req.param('id'), { userId: auth.user.id, ip: c.get('ip') }, input);
    audit(ctx, c, 'mcp.app_connected', { type: 'oauth_grant', id: approved.grantId, name: approved.clientName, teamId: input.teamId }, { access: input.access });
    return c.json({ redirect: approved.redirect });
  });

  app.post('/api/connect/:id/deny', async (c) => {
    signedIn(c);
    return c.json(await oauth.deny(c.req.param('id')));
  });
}
