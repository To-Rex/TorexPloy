/**
 * The tools an outside agent gets: TorexAi's own, as MCP tools.
 *
 * They are the same tools with the same code, so an agent connected over MCP
 * can do what TorexAi can do, under the same rules: the person's role, secrets
 * hidden until asked for, every change recorded and most of them undoable.
 * What differs is how a person says yes. TorexAi shows an approval card;
 * an MCP client asks its user before it calls a tool (the annotations below
 * tell it which tools only read), and the steps that destroy something wait
 * for an explicit `confirm` on top of that, or for the client's own
 * confirmation dialog when it can show one.
 *
 * TorexAi's tools that only make sense inside its own chat (making a file to
 * download, drawing a picture) are left out.
 */
import type { AiToolName, TokenAccess } from '@ploy/shared';
import { findTool, type ToolDef } from '../ai/tools.ts';

export interface McpToolDef {
  /** The name the client sees. */
  name: string;
  /** The TorexAi tool that does the work. */
  ai: AiToolName;
  title: string;
  /** Replaces TorexAi's description where its wording speaks of approval cards. */
  description?: string;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
  /** The least reach a connection needs to see the tool at all. */
  reach: TokenAccess;
  /** Arguments this tool fixes, and the properties it therefore does not offer. */
  fixed?: Record<string, unknown>;
  /** A step of this tool can need the user's explicit yes: it takes `confirm`. */
  confirmable: boolean;
}

const CONFIRM_NOTE =
  ' Steps that destroy something (deleting, wiping, destructive commands) or show secret values are not run at first: the result says exactly what would happen. Ask the user; only if they say yes to that exact step, call again with the same arguments and confirm: true.';

export const MCP_TOOLS: readonly McpToolDef[] = [
  { name: 'platform_map', ai: 'platform_map', title: 'Platform map', readOnly: true, reach: 'read', confirmable: false },
  { name: 'api_docs', ai: 'api_docs', title: 'API documentation', readOnly: true, reach: 'read', confirmable: false },
  {
    name: 'api_get',
    ai: 'api_call',
    title: 'Read from the API',
    description:
      'Read from the panel API as the connected person (their role applies). GET only, so it never changes anything: details of applications, deployments, domains, variables, services, servers, the team, the audit log. Find the endpoint with api_docs unless you know it. Secrets in answers are replaced by [hidden] unless `reveal` is true.',
    readOnly: true,
    reach: 'read',
    fixed: { method: 'GET' },
    confirmable: true,
  },
  {
    name: 'api_call',
    ai: 'api_call',
    title: 'Call the API',
    description:
      'Call the panel API as the connected person (their role applies): everything the dashboard can do, from projects, applications, deployments, domains and variables to databases, backups, servers, team, tokens and settings. Look the endpoint up with api_docs unless you already know it; use api_get for plain reads. Secrets in answers are replaced by [hidden] unless `reveal` is true; never send [hidden] back as a value. A change answers with an undo id.',
    readOnly: false,
    destructive: true,
    openWorld: false,
    reach: 'write',
    confirmable: true,
  },
  { name: 'logs', ai: 'logs', title: 'Read logs', readOnly: true, reach: 'read', confirmable: false },
  { name: 'wait_deployment', ai: 'wait_deployment', title: 'Wait for a deployment', readOnly: true, reach: 'read', confirmable: false },
  {
    name: 'shell',
    ai: 'shell',
    title: 'Run a command on a server',
    description:
      "Run a shell command on a server's host as root (sh -c): disk, processes, system services, Docker, packages, firewall, files outside containers. Not interactive: no editors, no following (-f), no prompts. Commands that only read always run; anything that changes the server needs a connection that may write. On an SSH server it needs the admin role in the team; on the panel's own server only the instance administrator may run commands.",
    readOnly: false,
    destructive: true,
    openWorld: true,
    reach: 'read',
    confirmable: true,
  },
  {
    name: 'exec',
    ai: 'exec',
    title: 'Run a command in a container',
    readOnly: false,
    destructive: true,
    openWorld: true,
    reach: 'read',
    confirmable: true,
  },
  { name: 'file_read', ai: 'file_read', title: 'Read a file', readOnly: true, reach: 'read', confirmable: false },
  { name: 'file_list', ai: 'file_list', title: 'List a folder', readOnly: true, reach: 'read', confirmable: false },
  { name: 'file_search', ai: 'file_search', title: 'Search files', readOnly: true, reach: 'read', confirmable: false },
  { name: 'file_write', ai: 'file_write', title: 'Write a file', readOnly: false, destructive: true, idempotent: true, openWorld: false, reach: 'write', confirmable: true },
  { name: 'file_edit', ai: 'file_edit', title: 'Edit a file', readOnly: false, destructive: true, openWorld: false, reach: 'write', confirmable: true },
  {
    name: 'code',
    ai: 'code',
    title: "Work on an application's source",
    readOnly: false,
    destructive: true,
    openWorld: true,
    reach: 'read',
    confirmable: true,
  },
  { name: 'read_output', ai: 'read_output', title: 'Read the rest of a result', readOnly: true, reach: 'read', confirmable: false },
  {
    name: 'undo',
    ai: 'undo',
    title: 'Undo a step',
    description:
      'Take back an earlier change made through this connection: put settings back, delete what was created, restore a file, roll back a deployment. `action` is the undo id the change answered with.',
    readOnly: false,
    destructive: true,
    openWorld: false,
    reach: 'write',
    confirmable: true,
  },
  { name: 'skill', ai: 'skill', title: 'Expert playbooks', readOnly: false, destructive: false, openWorld: false, reach: 'read', confirmable: true },
];

const BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

export function mcpTool(name: string): McpToolDef | undefined {
  return BY_NAME.get(name);
}

const REACH_ORDER: Record<TokenAccess, number> = { read: 0, write: 1, full: 2 };

/** Whether a connection with this reach is offered the tool. */
export function offered(tool: McpToolDef, reach: TokenAccess): boolean {
  return REACH_ORDER[reach] >= REACH_ORDER[tool.reach];
}

function aiDefinition(tool: McpToolDef): ToolDef {
  const definition = findTool(tool.ai);
  if (definition === undefined) throw new Error(`TorexAi has no tool ${tool.ai}`);
  return definition;
}

export function definitionOf(tool: McpToolDef): ToolDef {
  return aiDefinition(tool);
}

/** The tool as `tools/list` describes it. */
export function describeTool(tool: McpToolDef): Record<string, unknown> {
  const definition = aiDefinition(tool);
  const schema = definition.spec.schema as { properties?: Record<string, unknown>; required?: string[] };
  const properties: Record<string, unknown> = { ...(schema.properties ?? {}) };
  for (const key of Object.keys(tool.fixed ?? {})) delete properties[key];
  if (tool.confirmable) properties.confirm = { type: 'boolean', description: 'true only after the user explicitly approved this exact step' };
  const required = (schema.required ?? []).filter((key) => tool.fixed?.[key] === undefined);
  const description = `${tool.description ?? definition.spec.description}${tool.confirmable ? CONFIRM_NOTE : ''}`;
  return {
    name: tool.name,
    title: tool.title,
    description,
    inputSchema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      ...(tool.readOnly ? {} : { destructiveHint: tool.destructive ?? false, idempotentHint: tool.idempotent ?? false }),
      openWorldHint: tool.openWorld ?? false,
    },
  };
}

/** The tools a connection is offered, always in the same order (clients and models cache the list). */
export function listTools(reach: TokenAccess): Record<string, unknown>[] {
  return MCP_TOOLS.filter((tool) => offered(tool, reach)).map(describeTool);
}
