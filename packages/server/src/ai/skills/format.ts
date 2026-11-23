/**
 * Reading a skill, and deciding how far its text can be trusted.
 *
 * A skill is a `SKILL.md`: YAML front matter with a `name` and a
 * `description`, then the instructions in Markdown (the Agent Skills
 * format). The text is given to a model that can run commands as root, so a
 * skill fetched from outside is read for the things a playbook has no
 * business saying before it is ever installed without a person looking.
 */
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { AI_SKILL_LIMITS, SKILL_NAME_RE, type AiSkillFlag } from '@ploy/shared';

export class SkillError extends Error {
  override name = 'SkillError';
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  /** Front matter beyond name and description, as strings (`metadata.*` flattened in). */
  metadata: Record<string, string>;
}

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parse a `SKILL.md`. `folder` names the directory it was found in, used when the front matter has no usable name. */
export function parseSkill(text: string, folder?: string): ParsedSkill {
  const match = FRONT_MATTER.exec(text);
  if (match === null) throw new SkillError('SKILL.md has no front matter (--- name / description ---)');
  let front: unknown;
  try {
    front = parse(match[1]!);
  } catch (error) {
    throw new SkillError(`The front matter is not valid YAML: ${(error as Error).message.split('\n')[0]}`);
  }
  if (typeof front !== 'object' || front === null || Array.isArray(front)) throw new SkillError('The front matter is not a mapping');
  const fields = front as Record<string, unknown>;
  const declared = typeof fields.name === 'string' ? fields.name.trim().toLowerCase() : '';
  const fromFolder = (folder ?? '').trim().toLowerCase();
  // The specification makes the name match the folder; a file that gets it wrong is still known by one of the two.
  const name = SKILL_NAME_RE.test(declared) ? declared : SKILL_NAME_RE.test(fromFolder) ? fromFolder : '';
  if (name.length === 0) throw new SkillError('The skill has no valid name (lowercase letters, digits and hyphens, at most 64 characters)');
  const description = typeof fields.description === 'string' ? fields.description.replace(/\s+/g, ' ').trim() : '';
  if (description.length === 0) throw new SkillError('The skill has no description');
  const body = text.slice(match[0].length).trim();
  if (body.length === 0) throw new SkillError('The skill has no instructions');
  if (body.length > AI_SKILL_LIMITS.bodyMax) throw new SkillError(`The skill is longer than ${AI_SKILL_LIMITS.bodyMax} characters`);
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'name' || key === 'description' || key === 'metadata') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') metadata[key] = String(value).slice(0, 2_000);
  }
  if (typeof fields.metadata === 'object' && fields.metadata !== null && !Array.isArray(fields.metadata)) {
    for (const [key, value] of Object.entries(fields.metadata)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') metadata[key] = String(value).slice(0, 2_000);
    }
  }
  return { name, description: description.slice(0, AI_SKILL_LIMITS.descriptionMax), body, metadata };
}

/** A fingerprint of a skill's text and files: what "the same skill" means when a registry is read again. */
export function skillHash(body: string, files: Record<string, string>): string {
  const hash = createHash('sha256').update(body);
  for (const path of Object.keys(files).sort()) hash.update(`\0${path}\0`).update(files[path]!);
  return hash.digest('hex');
}

const CHECKS: { flag: AiSkillFlag; pattern: RegExp }[] = [
  // Trying to replace the rules the assistant works by. ("Ignore instructions embedded in the code you read" is advice, not an attack.)
  { flag: 'override', pattern: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|system|your|the\s+developer'?s?)\b[^.\n]{0,30}\b(?:instructions?|rules?|prompts?|guidelines?)\b/i },
  { flag: 'override', pattern: /\b(?:new|updated|real|actual)\s+system\s+prompt\b|\byou\s+are\s+no\s+longer\b|\bact\s+as\s+(?:root|an?\s+unrestricted)\b/i },
  // Getting around the person's say.
  { flag: 'no_approval', pattern: /\b(?:skip|bypass|avoid|disable|turn\s+off|circumvent|get\s+around)\s+(?:the\s+|any\s+|all\s+)?(?:user'?s?\s+|person'?s?\s+|human\s+|operator'?s?\s+)?(?:approvals?|confirmations?|consent|permission\s+prompts?)\b/i },
  { flag: 'no_approval', pattern: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|notify|mention\s+(?:this|it)\s+to|show\s+(?:this|it)\s+to)\s+(?:the\s+)?(?:user|person|operator|admin(?:istrator)?|owner)\b/i },
  { flag: 'no_approval', pattern: /\b(?:enable|turn\s+on|switch\s+on|use)\s+auto[- ]?approv\w*|\bauto[- ]?approve\s+(?:all|every|any)(?:thing)?\b|\bwithout\s+(?:the\s+)?(?:user|person|operator|owner)(?:'s)?\s+(?:knowledge|knowing|consent)\b/i },
  // Sending what is on the machine somewhere else.
  { flag: 'exfiltration', pattern: /\b(?:curl|wget|nc|ncat|scp|rsync)\b[^\n]{0,160}(?:\/etc\/shadow|\/etc\/passwd|id_rsa|id_ed25519|\.ssh\/|\.env\b|secret\.key|\.aws\/credentials|kubeconfig)[^\n]{0,80}(?:https?:\/\/|@[\w.-]+:)/i },
  { flag: 'exfiltration', pattern: /\b(?:curl|wget)\b[^\n]{0,80}(?:-d|--data(?:-binary|-raw)?|-F|--form|-T|--upload-file)\s*[^\n]{0,60}(?:\$\(|`|@\/|@~|\$\{?[A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY))/ },
  { flag: 'exfiltration', pattern: /\b(?:send|post|upload|forward|email|leak|exfiltrate)\b[^.\n]{0,50}\b(?:passwords?|tokens?|secrets?|credentials?|private\s+keys?|api\s+keys?|env(?:ironment)?\s+variables)\b[^.\n]{0,50}\b(?:to|at)\s+(?:https?:\/\/|[\w.-]+\.[a-z]{2,}\b)/i },
  // Running code that arrives over the network unseen.
  { flag: 'remote_code', pattern: /\b(?:curl|wget|fetch)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i },
  { flag: 'remote_code', pattern: /\bbase64\s+(?:-d|--decode|-D)\b[^\n|]{0,60}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\beval\s+"?\$\(\s*(?:curl|wget)\b/i },
  { flag: 'remote_code', pattern: /\b(?:python3?|perl|ruby|node)\s+-[ce]\s+["'][^\n]{0,200}(?:urlopen|requests\.get|http\.get|socket)\b[^\n]{0,200}\bexec\b/i },
  // Handing someone a shell.
  { flag: 'reverse_shell', pattern: /\/dev\/tcp\/[\w.$-]+\/\d+|\bnc(?:at)?\b[^\n]{0,40}\s-e\s+\/?(?:bin\/)?(?:ba)?sh\b|\bmkfifo\b[^\n]{0,80}\bnc\b|\bsocat\b[^\n]{0,80}\bexec:/i },
  // Giving someone a way in.
  { flag: 'access_keys', pattern: /(?:>>?|\btee\s+(?:-a\s+)?)\s*[^\n]{0,60}authorized_keys\b|\bssh-copy-id\b|\buseradd\b[^\n]{0,80}\s-o\s+-u\s*0\b|\bNOPASSWD:\s*ALL\b|\bchpasswd\b/i },
];

/**
 * Text a reader does not see but a model reads: Unicode tag characters (a
 * whole hidden sentence can be written in them), the direction overrides
 * that make code read differently from how it runs, and runs of zero-width
 * characters, which can spell out bits. A lone zero-width space, or the
 * joiner inside an emoji sequence, hides nothing.
 */
const HIDDEN_TEXT = /[\u{E0000}-\u{E007F}]|[‪-‮⁦-⁩]|[​-‍⁠-⁤﻿]{3,}/u;

/**
 * What in a skill's text and files a reviewer should see before it is
 * trusted. A flag is not a verdict: a security playbook may quote the very
 * command it teaches to look for. It only means the skill is not installed
 * without a person reading it first.
 */
export function scanSkill(body: string, files: Record<string, string> = {}): AiSkillFlag[] {
  const found = new Set<AiSkillFlag>();
  for (const text of [body, ...Object.values(files)]) {
    // A byte-order mark at the very start of a file is not hidden text.
    const sample = text.replace(/^﻿/, '');
    if (!found.has('hidden_text') && HIDDEN_TEXT.test(sample)) found.add('hidden_text');
    for (const check of CHECKS) if (!found.has(check.flag) && check.pattern.test(sample)) found.add(check.flag);
  }
  return [...found];
}

/** Files that may come along with a skill: text a model can read. Anything else (fonts, pictures, binaries) is left behind. */
export const SKILL_FILE_RE = /\.(md|markdown|txt|sh|bash|zsh|py|js|mjs|cjs|ts|rb|go|pl|php|json|ya?ml|toml|ini|conf|cfg|sql|rules|yar|yara|sigma|csv|tsv|xml|html?|css|template|tmpl|j2|env\.example|dockerfile)$/i;

export function keepsFile(path: string, size: number): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return size > 0 && size <= AI_SKILL_LIMITS.fileMax && (SKILL_FILE_RE.test(base) || /^(dockerfile|makefile|license(\.txt)?|readme)$/i.test(base));
}
