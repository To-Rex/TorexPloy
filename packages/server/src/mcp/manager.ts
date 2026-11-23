/**
 * TorexPloy as an MCP server: what an outside agent (Claude Code, Cursor,
 * VS Code, claude.ai, …) can see and do through its connection.
 *
 * A connection is a token: a person, a team, and a reach (read, write, full).
 * The agent gets TorexAi's tools, its skills as prompts, and a few resources,
 * and every step it takes is recorded like a TorexAi step, under a record of
 * its own for that connection, so the dashboard shows what it did and can
 * take most of it back.
 *
 * The transport (HTTP here, stdio through the `torex mcp` bridge) is not this
 * module's concern: it hands over one request at a time, already
 * authenticated, and gets a result back or an `RpcError`.
 */
import { createHash } from 'node:crypto';
import { MCP_MODERN_VERSIONS, MCP_VERSIONS, type TokenAccess, type TokenKind } from '@ploy/shared';
import type { Actor } from '../ai/internal.ts';
import { ToolError } from '../ai/files.ts';
import { clipForModel, STORED_OUTPUT_MAX } from '../ai/manager.ts';
import { maskSecrets, toolFailure } from '../ai/tools.ts';
import type { ToolPlan } from '../ai/types.ts';
import type { Context } from '../context.ts';
import { AppError, errorMessage } from '../lib/errors.ts';
import { nowIso, randomId } from '../lib/ids.ts';
import type { AiChatRecord } from '../store/index.ts';
import { LATEST_LEGACY_VERSION, META, RPC, RpcError, isLegacyVersion, type JsonRpcRequest } from './protocol.ts';
import { CliLogins } from './cli.ts';
import { OAuthServer } from './oauth.ts';
import { definitionOf, listTools, mcpTool, offered, type McpToolDef } from './tools.ts';

/** Who is calling, as their token says. */
export interface McpCaller {
  tokenId: string;
  kind: TokenKind;
  userId: string;
  teamId: string;
  access: TokenAccess;
  /** The app, as the person will recognise it: an OAuth app's name, the computer `torex` runs on, a token's name. */
  client: string;
  /** What its steps are recorded under: `grant:<id>` for an OAuth app (its tokens change, the grant stays), `token:<id>` otherwise. */
  connection: string;
  ip: string;
  origin: string;
}

/** One request, as the transport read it. */
export interface McpRequestContext {
  caller: McpCaller;
  era: 'modern' | 'legacy';
  /** The protocol version the request speaks. */
  version: string;
  /** What the client said it can do (modern requests carry it every time). */
  capabilities: Record<string, unknown>;
  signal: AbortSignal;
}

export interface McpSettings {
  enabled: boolean;
  oauth: boolean;
}

const SETTINGS_KEY = 'mcp';
const DEFAULT_SETTINGS: McpSettings = { enabled: true, oauth: true };
/** How long a client may keep a list before asking again. Lists change rarely; ten minutes keeps them fresh enough. */
const LIST_TTL_MS = 600_000;
/** A confirmation asked through the client's own dialog stays answerable this long. */
const CONFIRM_TTL_MS = 15 * 60_000;

export const MCP_SERVER_NAME = 'torexploy';

/** What a model connected over MCP is told about this server, once (clients put it in their system prompt). */
export const MCP_INSTRUCTIONS = `TorexPloy runs applications, databases and other services on the user's own servers (Docker): deployments from git or uploaded code, domains with HTTPS, environment variables, volumes, backups, cron jobs, logs and monitoring. These tools act as the person who connected this app, inside one team and with their role there; the connection itself may be limited to reading, or to changes that destroy nothing.

How to work:
- Start with platform_map: it gives the ids, status and domains of servers, projects, applications and services. Never guess an id.
- The platform is driven through its own API, the one the dashboard uses: api_docs finds an endpoint and its fields, api_get reads, api_call changes. Prefer the platform's features to manual work on a host.
- logs reads build and runtime logs (deployment:<id>, app:<id>, service:<id>); wait_deployment follows a deployment to its end and reports why it failed.
- shell runs a command on a server's host, exec inside an application's container; file_read, file_list, file_search, file_write and file_edit work on a host, in a container, or in an application's source.
- To change an application's code: code op "open", the file tools with where=code:<id>, code op "diff", code op "deploy", wait_deployment; code op "push" keeps the change in git.
- Skills are expert playbooks for whole jobs (security audit and hardening, intrusion check, attack response, Docker and dependency security, code review, failed deployments, performance, disk space, PostgreSQL and MySQL tuning, backup drills, domains and SSL, log investigation, server migration, monitoring): skill op "find", then op "use", and follow the method. They are offered as prompts too.
- A step that destroys something (deleting, wiping, destructive commands) or shows secret values is not run at first: the result says what would happen. Describe it to the user and ask. Only after their explicit yes, call again with confirm: true. If the client shows its own confirmation, the user answers there instead.
- A change answers with an undo id; undo takes it back. read_output reads the rest of a long result.
- Secrets arrive as [hidden]; ask for the values (reveal: true) only when the task needs them, and never write [hidden] back as a value.
- Answer in the user's language.`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The same JSON for the same value, whatever order its keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function humanize(name: string): string {
  const spaced = name.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export class McpManager {
  private readonly ctx: Context;
  private cache: McpSettings | null = null;
  /** Requests in flight per connection, so a legacy `notifications/cancelled` can stop one. */
  private readonly inflight = new Map<string, AbortController>();
  /** How apps connect without a token copied by hand. */
  readonly oauth: OAuthServer;
  /** `torex login` waiting for the person's yes in the browser. */
  readonly cli: CliLogins;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.oauth = new OAuthServer(ctx, this);
    this.cli = new CliLogins(ctx);
  }

  // ---------------------------------------------------------------- settings

  settings(): McpSettings {
    if (this.cache === null) {
      let stored: Partial<McpSettings> = {};
      try {
        stored = JSON.parse(this.ctx.stores.settings.getRaw(SETTINGS_KEY) ?? '{}') as Partial<McpSettings>;
      } catch {
        stored = {};
      }
      this.cache = { ...DEFAULT_SETTINGS, ...stored };
    }
    return this.cache;
  }

  updateSettings(patch: Partial<McpSettings>): McpSettings {
    const next = { ...this.settings(), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as McpSettings;
    this.ctx.stores.settings.setRaw(SETTINGS_KEY, JSON.stringify(next));
    this.cache = next;
    return next;
  }

  serverInfo(): Record<string, unknown> {
    return { name: MCP_SERVER_NAME, title: 'TorexPloy', version: this.ctx.config.version, description: 'Self-hosted platform: applications, databases, domains, servers', websiteUrl: 'https://github.com/To-Rex/TorexPloy' };
  }

  capabilities(): Record<string, unknown> {
    return { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false } };
  }

  // --------------------------------------------------------------- requests

  /** Register a request that can be cancelled; returns the signal to run it with and a function to forget it. */
  track(caller: McpCaller, id: string | number | undefined, outer: AbortSignal): { signal: AbortSignal; done: () => void; abort: () => void } {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', abort, { once: true });
    const key = id === undefined ? null : `${caller.tokenId}:${String(id)}`;
    if (key !== null) this.inflight.set(key, controller);
    return {
      signal: controller.signal,
      abort,
      done: () => {
        outer.removeEventListener('abort', abort);
        if (key !== null && this.inflight.get(key) === controller) this.inflight.delete(key);
      },
    };
  }

  /** A notification: only cancellation means anything to this server. */
  notify(caller: McpCaller, message: JsonRpcRequest): void {
    if (message.method !== 'notifications/cancelled') return;
    const requestId = message.params?.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return;
    this.inflight.get(`${caller.tokenId}:${String(requestId)}`)?.abort();
  }

  /** Answer one request. Throws `RpcError` for protocol errors; problems a model can fix come back as tool results. */
  async handle(message: JsonRpcRequest, request: McpRequestContext): Promise<Record<string, unknown>> {
    const params = message.params ?? {};
    const modern = request.era === 'modern';
    const decorate = (result: Record<string, unknown>, cacheable = false): Record<string, unknown> =>
      modern ? { resultType: 'complete', ...result, ...(cacheable ? { ttlMs: LIST_TTL_MS, cacheScope: 'private' } : {}), _meta: { [META.serverInfo]: this.serverInfo() } } : result;

    switch (message.method) {
      case 'server/discover':
        return decorate({ supportedVersions: [...MCP_VERSIONS], capabilities: this.capabilities(), instructions: MCP_INSTRUCTIONS }, true);
      case 'initialize': {
        if (modern) throw new RpcError(RPC.methodNotFound, 'initialize belongs to the legacy protocol; this request is modern', { status: 404 });
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return { protocolVersion: isLegacyVersion(asked) ? asked : LATEST_LEGACY_VERSION, capabilities: this.capabilities(), serverInfo: this.serverInfo(), instructions: MCP_INSTRUCTIONS };
      }
      case 'ping':
        if (modern) throw new RpcError(RPC.methodNotFound, 'ping was removed in protocol version 2026-07-28', { status: 404 });
        return {};
      case 'tools/list':
        return decorate({ tools: listTools(request.caller.access) }, true);
      case 'tools/call':
        return decorate(await this.callTool(params, request));
      case 'prompts/list':
        return decorate({ prompts: this.prompts() }, true);
      case 'prompts/get':
        return decorate(this.prompt(params));
      case 'resources/list':
        return decorate({ resources: this.resources() }, true);
      case 'resources/templates/list':
        return decorate({ resourceTemplates: RESOURCE_TEMPLATES }, true);
      case 'resources/read':
        return decorate(await this.readResource(params, request), true);
      default:
        throw new RpcError(RPC.methodNotFound, `Method not found: ${message.method}`, { status: modern ? 404 : 200 });
    }
  }

  // ------------------------------------------------------------------ tools

  private actorFor(caller: McpCaller, chat: AiChatRecord): Actor {
    return { userId: caller.userId, teamId: caller.teamId, sessionId: null, ip: caller.ip, origin: caller.origin, chatId: chat.id, mcp: { client: caller.client, tokenId: caller.tokenId } };
  }

  private chatFor(caller: McpCaller): AiChatRecord {
    const chat = this.ctx.stores.ai.mcpChat(caller.userId, caller.teamId, caller.connection, caller.client);
    this.ctx.stores.ai.touchChat(chat.id);
    return chat;
  }

  private async callTool(params: Record<string, unknown>, request: McpRequestContext): Promise<Record<string, unknown>> {
    const { caller } = request;
    const name = params.name;
    if (typeof name !== 'string' || name.length === 0) throw new RpcError(RPC.invalidParams, 'tools/call needs the name of a tool');
    const tool = mcpTool(name);
    if (tool === undefined || !offered(tool, caller.access)) throw new RpcError(RPC.invalidParams, `Unknown tool: ${name}`);
    const given = params.arguments ?? {};
    if (!isObject(given)) throw new RpcError(RPC.invalidParams, 'The arguments of a tool call must be an object');
    const args: Record<string, unknown> = { ...given };
    const confirmed = args.confirm === true;
    delete args.confirm;
    Object.assign(args, tool.fixed ?? {});

    const { ai } = this.ctx.stores;
    const chat = this.chatFor(caller);
    const env = this.ctx.ai.toolEnv(this.actorFor(caller, chat), chat);
    const anchor = ai.mcpAnchor(chat.id);
    const record = (plan: Pick<ToolPlan, 'title' | 'detail' | 'risk'> & { preview?: string | null }, status: 'running' | 'failed' | 'rejected', summary?: string) => {
      const action = ai.createAction({ chatId: chat.id, messageId: anchor, callId: `mcp_${randomId(12)}`, tool: tool.ai, title: plan.title, detail: plan.detail, preview: plan.preview ?? null, input: args, risk: plan.risk, status });
      return status === 'running' ? action : ai.updateAction(action.id, { summary: (summary ?? '').slice(0, 500), output: summary ?? null, finishedAt: nowIso() });
    };

    let plan: ToolPlan;
    try {
      plan = await definitionOf(tool).plan(args, env);
    } catch (error) {
      const text = toolFailure(error);
      if (!(error instanceof ToolError) && !(error instanceof AppError)) this.ctx.logger.warn('An MCP tool could not be planned', { tool: name, error: errorMessage(error) });
      record({ title: '', detail: '', risk: 'safe' }, 'failed', text);
      return textResult(text, true);
    }
    const described = [plan.title || tool.title, plan.detail].filter((part) => part.length > 0).join(': ');

    // The reach of the connection comes first: no yes from anyone makes a read-only connection write.
    if (caller.access === 'read' && (plan.risk !== 'safe' || plan.confirm === true)) {
      const text = `Not run: this connection can only read, and this step would change something (${described}). The user can do it in the TorexPloy dashboard, or connect again with a reach that allows it.`;
      record(plan, 'rejected', text);
      return textResult(text, true);
    }
    if (caller.access === 'write' && plan.risk === 'danger') {
      const text = `Not run: this connection may change things but not delete or destroy them, and this step would (${described}). The user can do it in the TorexPloy dashboard, or connect again with full access.`;
      record(plan, 'rejected', text);
      return textResult(text, true);
    }

    if (plan.risk === 'danger' || plan.confirm === true) {
      const verdict = this.confirmation(tool, args, plan, params, request, confirmed);
      if (verdict === 'declined') {
        const text = 'The user declined this step, so it was not run. Do not try it again or reach the same result another way; ask what they would like instead.';
        record(plan, 'rejected', text);
        return textResult(text, true);
      }
      if (verdict !== 'approved') return verdict;
    }

    let action = record(plan, 'running');
    try {
      const outcome = await plan.run(request.signal);
      const failed = outcome.error === true;
      const undo = failed ? null : (outcome.undo ?? null);
      action = ai.updateAction(action.id, {
        status: failed ? 'failed' : 'done',
        summary: outcome.summary.slice(0, 500),
        output: outcome.output.slice(0, STORED_OUTPUT_MAX),
        display: outcome.display === undefined ? null : outcome.display.slice(0, STORED_OUTPUT_MAX),
        undo,
        finishedAt: nowIso(),
      });
      const text = clipForModel(outcome.output, action.id);
      return textResult(undo === null ? text : `${text}\n(undo id: ${action.id})`, failed);
    } catch (error) {
      if (request.signal.aborted) {
        ai.updateAction(action.id, { status: 'cancelled', summary: 'Cancelled by the client', finishedAt: nowIso() });
        return textResult('Cancelled before it finished. It may have taken effect in part.', true);
      }
      const text = toolFailure(error);
      if (!(error instanceof ToolError) && !(error instanceof AppError)) this.ctx.logger.warn('An MCP tool failed', { tool: name, error: errorMessage(error) });
      ai.updateAction(action.id, { status: 'failed', summary: text.slice(0, 500), output: text, finishedAt: nowIso() });
      return textResult(text, true);
    }
  }

  /**
   * The user's yes to a step that destroys something or shows secrets. A
   * client that can show its own dialog (elicitation, in the modern protocol)
   * is asked to: the person answers there, and nothing the model writes can
   * stand in for that answer. Other clients must pass `confirm: true`, which
   * the model is told to do only after the user said yes.
   */
  private confirmation(tool: McpToolDef, args: Record<string, unknown>, plan: ToolPlan, params: Record<string, unknown>, request: McpRequestContext, confirmed: boolean): 'approved' | 'declined' | Record<string, unknown> {
    const elicitation = request.capabilities.elicitation;
    const canAsk = request.era === 'modern' && isObject(elicitation) && (isObject(elicitation.form) || Object.keys(elicitation).length === 0);
    const what = [plan.title || tool.title, plan.detail].filter((part) => part.length > 0).join('\n');
    if (canAsk) {
      const responses = params.inputResponses;
      const answer = isObject(responses) ? responses.confirm : undefined;
      if (isObject(answer) && this.stateMatches(params.requestState, tool, args, request.caller)) {
        return answer.action === 'accept' && isObject(answer.content) && answer.content.confirm === true ? 'approved' : 'declined';
      }
      const preview = plan.preview === undefined || plan.preview === null ? '' : `\n\n${plan.preview.slice(0, 1_500)}`;
      return {
        resultType: 'input_required',
        inputRequests: {
          confirm: {
            method: 'elicitation/create',
            params: {
              mode: 'form',
              message: `TorexPloy asks before this step:\n\n${what}${preview}\n\nAllow it?`,
              requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Allow this step', default: false } }, required: ['confirm'] },
            },
          },
        },
        requestState: this.ctx.secrets.seal(JSON.stringify({ t: tool.name, a: this.argsHash(args), c: request.caller.tokenId, e: Date.now() + CONFIRM_TTL_MS }), 'mcp'),
      };
    }
    if (confirmed) return 'approved';
    const preview = plan.preview === undefined || plan.preview === null ? '' : `\n\n${plan.preview.slice(0, 3_000)}`;
    return textResult(
      `Not run yet: this step needs the user's explicit approval.\n\n${what}${preview}\n\nTell the user what it will do and ask. Only if they say yes, call ${tool.name} again with the same arguments and confirm: true.`,
      true,
    );
  }

  private argsHash(args: Record<string, unknown>): string {
    return createHash('sha256').update(canonical(args)).digest('base64url');
  }

  private stateMatches(state: unknown, tool: McpToolDef, args: Record<string, unknown>, caller: McpCaller): boolean {
    if (typeof state !== 'string' || state.length === 0 || state.length > 4_000) return false;
    try {
      const parsed = JSON.parse(this.ctx.secrets.open(state, 'mcp')) as { t?: unknown; a?: unknown; c?: unknown; e?: unknown };
      return parsed.t === tool.name && parsed.a === this.argsHash(args) && parsed.c === caller.tokenId && typeof parsed.e === 'number' && parsed.e > Date.now();
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- prompts

  /** Skills the connection may use as prompts: the built-in library and what is installed (and switched on) here. */
  private promptSkills() {
    const { skills } = this.ctx.stores;
    return this.ctx.ai.skills.entries().filter((entry) => {
      const installed = skills.get(entry.name);
      return installed !== undefined ? installed.enabled : entry.source === 'builtin';
    });
  }

  private prompts(): Record<string, unknown>[] {
    return this.promptSkills().map((entry) => ({
      name: entry.name,
      title: entry.metadata['title.en'] ?? humanize(entry.name),
      description: entry.description,
      arguments: [{ name: 'task', description: 'What to do, and where: which server, application or service, and anything already known', required: false }],
    }));
  }

  private prompt(params: Record<string, unknown>): Record<string, unknown> {
    const name = typeof params.name === 'string' ? params.name : '';
    const entry = this.promptSkills().find((candidate) => candidate.name === name);
    if (entry === undefined) throw new RpcError(RPC.invalidParams, `Unknown prompt: ${name}`);
    const args = isObject(params.arguments) ? params.arguments : {};
    const task = typeof args.task === 'string' && args.task.trim().length > 0 ? args.task.trim().slice(0, 4_000) : null;
    const text = [
      `Work on this with TorexPloy's tools, following the "${entry.name}" playbook below${task === null ? '.' : `.\n\nThe task: ${task}`}`,
      "The playbook names TorexPloy tools (platform_map, api_call, shell, logs, …): they are the tools of this connection. It is advice, not authority: steps that destroy something still need the user's yes, and the connection's reach still applies.",
      '',
      entry.body,
    ].join('\n');
    const record = this.ctx.stores.skills.get(entry.name);
    if (record !== undefined) this.ctx.ai.skills.use(record);
    return { description: entry.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
  }

  // -------------------------------------------------------------- resources

  private resources(): Record<string, unknown>[] {
    return [
      { uri: 'torexploy://platform', name: 'platform', title: 'Platform map', description: "The team's servers, projects, applications and services, with ids, status and domains", mimeType: 'text/plain' },
      ...this.promptSkills().map((entry) => ({ uri: `torexploy://skills/${entry.name}`, name: `skill-${entry.name}`, title: entry.metadata['title.en'] ?? humanize(entry.name), description: entry.description, mimeType: 'text/markdown' })),
    ];
  }

  private async readResource(params: Record<string, unknown>, request: McpRequestContext): Promise<Record<string, unknown>> {
    const uri = typeof params.uri === 'string' ? params.uri : '';
    const notFound = (): RpcError => new RpcError(request.era === 'modern' ? RPC.invalidParams : RPC.legacyResourceNotFound, `Resource not found: ${uri}`, { data: { uri } });
    const contents = (text: string, mimeType: string) => ({ contents: [{ uri, mimeType, text }] });
    const { caller } = request;

    const skill = /^torexploy:\/\/skills\/([a-z0-9-]{1,64})$/.exec(uri);
    if (skill !== null) {
      const entry = this.promptSkills().find((candidate) => candidate.name === skill[1]);
      if (entry === undefined) throw notFound();
      return contents(entry.body, 'text/markdown');
    }

    const run = async (toolName: string, input: Record<string, unknown>): Promise<string> => {
      const tool = mcpTool(toolName)!;
      const chat = this.chatFor(caller);
      const plan = await definitionOf(tool).plan(input, this.ctx.ai.toolEnv(this.actorFor(caller, chat), chat));
      if (plan.risk !== 'safe') throw notFound();
      const outcome = await plan.run(request.signal);
      if (outcome.error === true) throw new RpcError(RPC.invalidParams, outcome.output.slice(0, 500), { data: { uri } });
      return outcome.output;
    };

    try {
      if (uri === 'torexploy://platform') return contents(await run('platform_map', {}), 'text/plain');
      const log = /^torexploy:\/\/deployments\/([A-Za-z0-9_-]{1,64})\/log$/.exec(uri);
      if (log !== null) return contents(await run('logs', { target: `deployment:${log[1]}`, tail: 500 }), 'text/plain');
      const app = /^torexploy:\/\/applications\/([A-Za-z0-9_-]{1,64})$/.exec(uri);
      if (app !== null) {
        const chat = this.chatFor(caller);
        const result = await this.ctx.ai.api.call(this.actorFor(caller, chat), 'GET', `/api/applications/${app[1]}`);
        if (!result.ok) throw notFound();
        return contents(JSON.stringify(maskSecrets(result.data).value, null, 2), 'application/json');
      }
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(RPC.invalidParams, toolFailure(error), { data: { uri } });
    }
    throw notFound();
  }
}

const RESOURCE_TEMPLATES = [
  { uriTemplate: 'torexploy://applications/{id}', name: 'application', title: 'Application', description: 'An application: its source, build and runtime settings, status and domains (secrets hidden)', mimeType: 'application/json' },
  { uriTemplate: 'torexploy://deployments/{id}/log', name: 'deployment-log', title: 'Deployment log', description: 'The build and deploy log of a deployment, with the lines that look like errors picked out', mimeType: 'text/plain' },
  { uriTemplate: 'torexploy://skills/{name}', name: 'skill', title: 'Skill', description: 'An expert playbook', mimeType: 'text/markdown' },
];

/** The versions a client may speak, for error messages. */
export const SUPPORTED_VERSIONS_TEXT = `${MCP_MODERN_VERSIONS.join(', ')} (stateless) or ${MCP_VERSIONS.filter((version) => isLegacyVersion(version)).join(', ')} (with initialize)`;
