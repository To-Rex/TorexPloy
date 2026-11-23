/**
 * TorexPloy outside the dashboard: the `torex` command line, and the MCP
 * server AI agents connect to (Claude Code, Claude Desktop and claude.ai,
 * Cursor, VS Code, Codex and the rest).
 *
 * Both act through tokens. A token belongs to a person and a team, acts with
 * that person's role, and carries a reach of its own: what it may do is the
 * smaller of the two.
 */
import { z } from 'zod';
import type { AiActionDto } from './ai.ts';
import type { TeamRole } from './constants.ts';

/** How a token came to be: made by hand (Settings → API tokens), by `torex login`, or for an app connected over OAuth. */
export const TOKEN_KINDS = ['api', 'cli', 'oauth'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/**
 * How far a token reaches.
 * - `read`: looks only.
 * - `write`: changes things, but never destroys them (deleting, wiping, revoking, destructive commands).
 * - `full`: everything its owner's role allows.
 */
export const TOKEN_ACCESS = ['read', 'write', 'full'] as const;
export type TokenAccess = (typeof TOKEN_ACCESS)[number];

/**
 * MCP protocol versions the server speaks. The first is the stateless
 * revision (every request carries its version); the others open with an
 * `initialize` handshake. Clients of either era are served on one endpoint.
 */
export const MCP_MODERN_VERSIONS = ['2026-07-28'] as const;
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_VERSIONS: readonly string[] = [...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS];

/** Where the MCP server and the OAuth endpoints live, relative to the panel's address. */
export const MCP_PATH = '/mcp';

export interface McpSettingsDto {
  /** The MCP endpoint answers at all. */
  enabled: boolean;
  /** Apps may connect by signing in (OAuth), without anyone copying a token. */
  oauth: boolean;
}

export const mcpSettingsSchema = z.object({ enabled: z.boolean().optional(), oauth: z.boolean().optional() });
export type McpSettingsInput = z.infer<typeof mcpSettingsSchema>;

/** One way into the platform from outside: an app connected over OAuth, a `torex login`, or a token made by hand. */
export interface McpConnectionDto {
  /** `grant:<id>` for an OAuth app, `token:<id>` otherwise. */
  id: string;
  kind: TokenKind;
  name: string;
  /** Where an OAuth app sends people back to after they say yes: a look-alike app shows itself here. */
  redirectHost: string | null;
  access: TokenAccess;
  teamName: string;
  /** Whose connection it is (an administrator sees the whole team's). */
  userName: string;
  mine: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Something an MCP client did, with the app that did it. */
export interface McpActivityDto extends AiActionDto {
  client: string;
}

export interface McpOverviewDto {
  settings: McpSettingsDto;
  /** `<panel>/mcp`. */
  endpoint: string;
  origin: string;
  /** The version of the `torex` command this panel serves; null when it was not built. */
  cliVersion: string | null;
  connections: McpConnectionDto[];
  activity: McpActivityDto[];
  /** The caller may make tokens (the developer role and up). */
  canConnect: boolean;
}

/** A token made on the CLI & MCP page to paste into an app's settings. */
export const mcpTokenSchema = z.object({
  client: z.string().trim().min(1).max(60),
  access: z.enum(TOKEN_ACCESS),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
});
export type McpTokenInput = z.infer<typeof mcpTokenSchema>;

// ---------------------------------------------------------------------------
// Saying yes to an app (OAuth) or to the command line
// ---------------------------------------------------------------------------

export const CONNECT_WARNINGS = ['localhost', 'http', 'custom_scheme', 'new_client'] as const;
export type ConnectWarning = (typeof CONNECT_WARNINGS)[number];

export interface ConnectTeamDto {
  id: string;
  name: string;
  role: TeamRole;
}

/** What the consent page shows about an app that asks to connect. */
export interface ConnectRequestDto {
  id: string;
  client: {
    name: string;
    /** Its home page, when it gave one. */
    uri: string | null;
    /** Registered here by the app itself (`dcr`) or described at an address of its own (`cimd`). */
    kind: 'dcr' | 'cimd';
  };
  redirectUri: string;
  redirectHost: string;
  warnings: ConnectWarning[];
  /** The reach the app asked for, when it asked for one. */
  requestedAccess: TokenAccess | null;
  teams: ConnectTeamDto[];
  currentTeamId: string | null;
  expiresAt: string;
}

export const connectDecisionSchema = z.object({
  teamId: z.string().min(1).max(64),
  access: z.enum(TOKEN_ACCESS),
});
export type ConnectDecisionInput = z.infer<typeof connectDecisionSchema>;

/** Where the browser goes next: back to the app, with the answer. */
export interface ConnectRedirectDto {
  redirect: string;
}

/** The command line asks to sign in: it shows `userCode` and opens `verificationUri`, then asks for the token with `code`. */
export interface CliLoginStartDto {
  code: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export const cliLoginStartSchema = z.object({
  /** The computer it runs on, so the person recognises it. */
  name: z.string().trim().min(1).max(80),
  client: z.string().trim().max(120).optional(),
});

/** What the approval page shows about a waiting `torex login`. */
export interface CliLoginRequestDto {
  userCode: string;
  name: string;
  client: string | null;
  ip: string;
  createdAt: string;
  expiresAt: string;
  teams: ConnectTeamDto[];
  currentTeamId: string | null;
}

export const CLI_USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export const cliLoginDecisionSchema = z.object({
  userCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2'))
    .pipe(z.string().regex(CLI_USER_CODE_RE)),
  teamId: z.string().min(1).max(64),
  access: z.enum(TOKEN_ACCESS),
  approve: z.boolean(),
});
export type CliLoginDecisionInput = z.infer<typeof cliLoginDecisionSchema>;

/** Handed to the command line once, when the person said yes. */
export interface CliLoginResultDto {
  token: string;
  user: { id: string; name: string; email: string };
  team: { id: string; name: string };
  role: TeamRole;
  access: TokenAccess;
}
