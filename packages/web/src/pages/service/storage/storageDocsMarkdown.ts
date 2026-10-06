/**
 * The file store docs as one Markdown document — the same sections, in the
 * same language, with the same endpoint, bucket and key filled in — so the
 * integration guide can travel to a wiki, a repository or a colleague.
 */
import type { Messages } from '../../../i18n/uz.ts';
import { browserUploadSnippet, linkEnvRows, linkedAppSnippet, panelApiSnippet, SDK_LABELS, SDKS, sdkSnippet, type Sdk, type SnippetInput } from './storageSnippets.ts';

export interface DocsMarkdownInput {
  m: Messages;
  serviceName: string;
  serviceId: string;
  /** The panel's origin (`https://deploy.example.uz`), for links and the API base. */
  origin: string;
  values: SnippetInput;
  external: string | null;
  internalEndpoint: string;
  rootAccessKeyId: string;
  envPrefix: string;
  generatedAt: string;
}

const FENCE: Record<Sdk, string> = { node: 'ts', python: 'python', php: 'php', go: 'go', java: 'java', dotnet: 'csharp', ruby: 'ruby', django: 'python', cli: 'bash', rclone: 'bash', s3cmd: 'bash', mc: 'bash' };

/** Inline markup is already Markdown; dashboard links become absolute, and placeholders in angle brackets stay literal. */
function text(value: string, origin: string): string {
  return value.replace(/\]\((\/[^)]*)\)/g, `](${origin}$1)`).replace(/<([A-Z_]+)>/g, '`<$1>`');
}

function fence(code: string, language = ''): string {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

function table(head: string[], rows: string[][]): string {
  const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');
}

function steps(items: readonly { title: string; text: string }[], origin: string): string {
  return items.map((step, index) => `${index + 1}. **${text(step.title, origin)}** — ${text(step.text, origin)}`).join('\n');
}

function bullets(items: readonly string[], origin: string): string {
  return items.map((item) => `- ${text(item, origin)}`).join('\n');
}

export function storageDocsMarkdown(input: DocsMarkdownInput): string {
  const { m, origin, values, external, internalEndpoint, rootAccessKeyId, envPrefix } = input;
  const d = m.fileStore.docs;
  const f = m.fileStore;
  const t = (value: string) => text(value, origin);
  const out: string[] = [];

  out.push(`# ${d.title} — ${input.serviceName}`, '', t(d.subtitle), '', `_${input.generatedAt} · ${origin}/services/${input.serviceId}/docs_`, '', `> ${t(d.secretNote)}`, '');

  out.push(`## ${d.quickstart.title}`, '', steps(d.quickstart.steps, origin), '');

  out.push(`## ${d.connection.title}`, '', t(d.connection.hint), '');
  if (external === null) out.push(`> ${t(d.connection.externalNone)}`, '');
  out.push(
    table(
      ['', ''],
      [
        [d.connection.rows.endpointExternal, external === null ? f.endpointNone : `\`${external}\``],
        [d.connection.rows.endpointInternal, `\`${internalEndpoint}\` — ${d.connection.internalOnly}`],
        [d.connection.rows.region, `\`${values.region}\``],
        [d.connection.rows.pathStyle, `\`${values.endpoint}/${values.bucket}/<key>\``],
        [d.connection.rows.key, `\`${values.key}\``],
        [d.connection.rows.secret, t(d.connection.rows.secretHint)],
      ],
    ),
    '',
  );

  out.push(`## ${d.linked.title}`, '', t(d.linked.text), '', steps(d.linked.steps, origin), '', `${d.linked.prefix}: \`${envPrefix}\``, '');
  out.push(
    table(
      [d.linked.cols.name, d.linked.cols.value, d.linked.cols.note],
      linkEnvRows(envPrefix, internalEndpoint, values.region, rootAccessKeyId).map(([name, value, note]) => [`\`${name}\``, value.length === 0 ? '—' : `\`${value}\``, d.linked.notes[note as keyof typeof d.linked.notes]]),
    ),
    '',
    `> ${t(d.linked.rootWarning)}`,
    '',
    fence(linkedAppSnippet(envPrefix), 'ts'),
    '',
  );

  out.push(`## ${d.sdk.title}`, '', t(d.sdk.hint), '');
  for (const sdk of SDKS) out.push(`### ${SDK_LABELS[sdk]}`, '', fence(sdkSnippet(sdk, values), FENCE[sdk]), '');
  out.push(bullets(d.sdk.notes, origin), '');

  out.push(`## ${d.links.title}`, '', t(d.links.public), '', fence(`${values.endpoint}/${values.bucket}/photos/photo.png`), '', t(d.links.private), '', bullets(d.links.notes, origin), '');

  out.push(`## ${d.browser.title}`, '', t(d.browser.text), '', fence(browserUploadSnippet(), 'ts'), '', `> ${t(d.browser.cors)}`, '');

  out.push(`## ${d.keys.title}`, '', bullets(d.keys.items, origin), '', `> **${d.keys.rotateTitle}** — ${t(d.keys.rotate)}`, '');

  out.push(`## ${d.backups.title}`, '', t(d.backups.text), '');

  out.push(`## ${d.limits.title}`, '', bullets(d.limits.items, origin), '');

  out.push(`## ${d.faq.title}`, '');
  for (const item of d.faq.items) out.push(`**${t(item.q)}**`, '', t(item.a), '');

  out.push(`## ${d.api.title}`, '', t(d.api.text), '', fence(panelApiSnippet(origin, input.serviceId, values.bucket), 'bash'), '', bullets(d.api.notes, origin), '');

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Hand the document to the browser as a `.md` download. */
export function downloadMarkdown(name: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
