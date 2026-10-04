/**
 * `.env` text, as people paste it: `KEY=value` lines with optional `export`,
 * quotes and comments. Shared so the dashboard's editor and the API read the
 * same text the same way.
 */
import { ENV_KEY_RE } from './constants.ts';

/** Parse `.env` text; a repeated key keeps its last value. `badLine` is the first line that is not `KEY=value` (1-based). */
export function parseDotenv(text: string): { variables: { key: string; value: string }[]; badLine: number | null } {
  const variables: { key: string; value: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim();
    if (raw.length === 0 || raw.startsWith('#')) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(raw);
    if (match === null || !ENV_KEY_RE.test(match[1]!)) return { variables, badLine: index + 1 };
    const key = match[1]!;
    let value = match[2]!;
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    const existing = variables.findIndex((variable) => variable.key === key);
    if (existing !== -1) variables.splice(existing, 1);
    variables.push({ key, value });
  }
  return { variables, badLine: null };
}
