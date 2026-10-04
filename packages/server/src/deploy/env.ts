/**
 * Runtime environment resolution.
 *
 * Precedence (later wins): project shared variables → linked service
 * connection variables → application variables → nothing else. Platform
 * variables (`PORT`, `PLOY_*`) are added only when the user has not set them.
 *
 * `${NAME}` inside a value expands to another variable of the merged set, so
 * `DATABASE_URL=${DATABASE_URL}?sslmode=disable` or `API=https://${HOST}`
 * work without copying secrets around.
 */
import { catalogEntry, linkEnv } from '../services/catalog.ts';
import type { ApplicationRecord, Stores } from '../store/index.ts';

export interface ResolvedEnv {
  env: Record<string, string>;
  /** Keys contributed by linked services, for the variables editor. */
  inherited: { key: string; source: string }[];
  /** Values to mask in logs. */
  secrets: string[];
}

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PASS$|_PWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|SIGNING|SALT|DSN|COOKIE)/i;

/** Whether a variable's value should be masked in logs: by name, or because it embeds credentials. */
export function isSensitive(key: string, value: string): boolean {
  return SENSITIVE_KEY.test(key) || /:\/\/[^/\s:@]+:[^@\s]+@/.test(value);
}

/**
 * One pass of `${NAME}` expansion against the merged set; unknown names are
 * left as written. A self-reference resolves to the value from the layer
 * below (`base`), which is how an app extends a linked service's variable.
 */
export function expandReferences(env: Record<string, string>, base: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(REFERENCE, (match, name: string) => {
      const target = name === key ? base[name] : env[name];
      return target === undefined ? match : target;
    });
  }
  return out;
}

export function resolveAppEnv(stores: Stores, app: ApplicationRecord): ResolvedEnv {
  const merged: Record<string, string> = {};
  const inherited: { key: string; source: string }[] = [];
  const secrets: string[] = [];

  for (const { key, value } of stores.env.list({ projectId: app.projectId })) merged[key] = value;

  for (const link of stores.links.listForApplication(app.id)) {
    const service = stores.services.get(link.serviceId);
    if (service === undefined) continue;
    const entry = catalogEntry(service.type);
    const vars = linkEnv(entry, service.credentials, service.slug, service.internalPort, link.prefix);
    for (const [key, value] of Object.entries(vars)) {
      merged[key] = value;
      inherited.push({ key, source: service.name });
    }
    secrets.push(service.credentials.password);
  }

  const base = { ...merged };
  const own = stores.env.list({ applicationId: app.id });
  for (const { key, value } of own) merged[key] = value;

  const env = expandReferences(merged, base);
  for (const [key, value] of Object.entries(env)) if (isSensitive(key, value)) secrets.push(value);
  return { env, inherited: inherited.filter((item) => !own.some((variable) => variable.key === item.key)), secrets };
}

/** Add platform-provided variables without overriding anything the user set. */
export function withPlatformEnv(env: Record<string, string>, platform: Record<string, string>): Record<string, string> {
  return { ...platform, ...env };
}
