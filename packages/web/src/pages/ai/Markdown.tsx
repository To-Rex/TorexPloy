/**
 * Markdown as TorexAi writes it, drawn as React elements (never as HTML
 * strings, so nothing a model writes can become markup). It is rendered
 * while the reply is still arriving: an unfinished code fence is simply a
 * code block that has not ended yet.
 *
 * Supported: headings, paragraphs, lists (nested, ordered, task lists),
 * block quotes, tables, rules, fenced code, and inline code, bold, italic,
 * strikethrough and links. A fenced block with the language `chart` becomes
 * a chart.
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Check, Copy } from 'lucide-react';
import { writeClipboard } from '../../components/Copy.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { ChartBlock } from './ChartBlock.tsx';

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; lang: string; code: string; closed: boolean }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: { blocks: Block[]; checked: boolean | null }[] }
  | { kind: 'table'; head: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { kind: 'rule' };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w.+#-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      out.push(current.trim());
      current = '';
    } else current += char;
  }
  out.push(current.trim());
  return out;
}

const startsBlock = (line: string): boolean => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^ {0,3}>/.test(line) || ITEM.test(line);

export function parseMarkdown(source: string): Block[] {
  return parseLines(source.replace(/\r\n?/g, '\n').split('\n'));
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      const body: string[] = [];
      let closed = false;
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]!;
        const end = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(candidate);
        if (end !== null && end[1]![0] === marker[0] && end[1]!.length >= marker.length) {
          closed = true;
          index += 1;
          break;
        }
        body.push(candidate);
        index += 1;
      }
      blocks.push({ kind: 'code', lang: (fence[2] ?? '').toLowerCase(), code: body.join('\n'), closed });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index]!)) {
        inner.push(lines[index]!.replace(/^ {0,3}>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseLines(inner) });
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1]!) && lines[index + 1]!.includes('-')) {
      const head = cells(line);
      const align = cells(lines[index + 1]!).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null));
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.includes('|') && lines[index]!.trim().length > 0) {
        rows.push(cells(lines[index]!));
        index += 1;
      }
      blocks.push({ kind: 'table', head, align, rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      const base = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      const items: { blocks: Block[]; checked: boolean | null }[] = [];
      let current: string[] | null = null;
      const flush = (): void => {
        if (current === null) return;
        let checked: boolean | null = null;
        const task = /^\[( |x|X)\]\s+/.exec(current[0] ?? '');
        if (task !== null) {
          checked = task[1] !== ' ';
          current[0] = current[0]!.slice(task[0].length);
        }
        items.push({ blocks: parseLines(current), checked });
        current = null;
      };
      while (index < lines.length) {
        const candidate = lines[index]!;
        const next = ITEM.exec(candidate);
        if (next !== null && next[1]!.length <= base + 1 && /\d/.test(next[2]!) === ordered) {
          flush();
          current = [next[3]!];
          index += 1;
          continue;
        }
        if (candidate.trim().length === 0) {
          // A blank line ends the list unless what follows is still part of it.
          const after = lines[index + 1];
          if (after === undefined || (after.trim().length > 0 && !/^\s{2,}/.test(after) && ITEM.exec(after) === null)) break;
          current?.push('');
          index += 1;
          continue;
        }
        const indent = /^\s*/.exec(candidate)![0].length;
        if (indent > base || (next === null && !startsBlock(candidate))) {
          // A continuation of the item, or something nested in it: kept with its own indentation, less the item's.
          current?.push(candidate.slice(Math.min(indent, base + 2)));
          index += 1;
          continue;
        }
        break;
      }
      flush();
      blocks.push({ kind: 'list', ordered, start: ordered ? Number.parseInt(item[2]!, 10) || 1 : 1, items });
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim().length > 0 && !startsBlock(lines[index]!)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const INLINE = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*(?=\S)([\s\S]+?\S)\*\*|~~(?=\S)([\s\S]+?\S)~~|\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)|(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])/;

function safeHref(url: string): { href: string; internal: boolean } | null {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return { href: url, internal: false };
  if (/^\/(?!\/)/.test(url)) return { href: url, internal: true };
  return null;
}

function inline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const next = (): string => `${keyPrefix}${(key += 1)}`;
  const plain = (value: string): void => {
    // A line break inside a paragraph is kept: replies are written the way chat messages are.
    value.split('\n').forEach((part, index) => {
      if (index > 0) out.push(<br key={next()} />);
      if (part.length > 0) out.push(part);
    });
  };
  for (;;) {
    const match = INLINE.exec(rest);
    if (match === null) {
      plain(rest);
      break;
    }
    plain(rest.slice(0, match.index));
    const id = next();
    if (match[1] !== undefined) out.push(<code key={id}>{match[2]!.replace(/^ (.+) $/, '$1')}</code>);
    else if (match[3] !== undefined) {
      const link = safeHref(match[4]!);
      const label = inline(match[3], `${id}-`);
      if (link === null) out.push(<span key={id}>{label}</span>);
      else if (link.internal) out.push(<Link key={id} to={link.href}>{label}</Link>);
      else out.push(<a key={id} href={link.href} target="_blank" rel="noreferrer noopener">{label}</a>);
    } else if (match[5] !== undefined) out.push(<strong key={id}>{inline(match[5], `${id}-`)}</strong>);
    else if (match[6] !== undefined) out.push(<del key={id}>{inline(match[6], `${id}-`)}</del>);
    else if (match[7] !== undefined) out.push(<em key={id}>{inline(match[7], `${id}-`)}</em>);
    else if (match[8] !== undefined) out.push(<a key={id} href={match[8]} target="_blank" rel="noreferrer noopener">{match[8]}</a>);
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(
  'if else elif fi then for while do done case esac in function return import from export default const let var class extends new try catch finally throw async await yield def lambda pass with as is not and or true false null None True False nil undefined package func go defer type struct interface public private protected static void int string bool select insert update delete where join left right inner outer on group by order limit create alter drop table index into values set begin commit rollback FROM RUN CMD COPY ADD ENV EXPOSE WORKDIR ENTRYPOINT ARG USER VOLUME LABEL HEALTHCHECK echo sudo cd'.split(' '),
);
const HIGHLIGHTED = new Set(['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'json', 'bash', 'sh', 'shell', 'zsh', 'yaml', 'yml', 'sql', 'python', 'py', 'go', 'rust', 'rs', 'dockerfile', 'docker', 'toml', 'ini', 'php', 'java', 'c', 'cpp', 'css', 'nginx', 'caddyfile', 'env', 'conf']);
const HASH_COMMENTS = new Set(['bash', 'sh', 'shell', 'zsh', 'yaml', 'yml', 'python', 'py', 'dockerfile', 'docker', 'toml', 'ini', 'nginx', 'caddyfile', 'env', 'conf', 'php']);
const TOKEN = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(#[^\n]*)|(--[^\n]*)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

function highlight(code: string, lang: string): ReactNode[] {
  if (lang === 'diff' || lang === 'patch') {
    return code.split('\n').map((line, index) => (
      <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'tk-add' : line.startsWith('-') && !line.startsWith('---') ? 'tk-del' : line.startsWith('@@') ? 'tk-com' : undefined}>
        {line}
        {'\n'}
      </span>
    ));
  }
  if (!HIGHLIGHTED.has(lang) || code.length > 60_000) return [code];
  const hash = HASH_COMMENTS.has(lang);
  // Shell output is mostly prose: words like "in" and "and" are not keywords there.
  const keywords = !['bash', 'sh', 'shell', 'zsh', 'env', 'conf', 'ini'].includes(lang);
  const sql = lang === 'sql';
  const slashes = !hash && !sql && lang !== 'json';
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of code.matchAll(TOKEN)) {
    const [whole, string, slash, hashComment, dash, number, word] = match;
    let className: string | null = null;
    if (string !== undefined) className = 'tk-str';
    else if (slash !== undefined) className = slashes || lang === 'css' ? 'tk-com' : null;
    else if (hashComment !== undefined) className = hash && (match.index === 0 || /\s/.test(code[match.index - 1]!)) ? 'tk-com' : null;
    else if (dash !== undefined) className = sql ? 'tk-com' : null;
    else if (number !== undefined) className = 'tk-num';
    else if (word !== undefined) className = keywords && (KEYWORDS.has(word) || (sql && KEYWORDS.has(word.toLowerCase()))) ? 'tk-key' : null;
    if (className === null) continue;
    if (match.index > last) out.push(code.slice(last, match.index));
    out.push(
      <span key={(key += 1)} className={className}>
        {whole}
      </span>,
    );
    last = match.index + whole.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { m } = useI18n();
  const [copied, setCopied] = useState(false);
  const body = useMemo(() => highlight(code, lang), [code, lang]);
  const copy = async (): Promise<void> => {
    if (!(await writeClipboard(code))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <div className="tai-code">
      <div className="tai-code__bar">
        <span>{lang.length > 0 ? lang : 'text'}</span>
        <button type="button" onClick={() => void copy()} aria-label={m.common.copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? m.common.copied : m.common.copy}
        </button>
      </div>
      <pre>
        <code>{body}</code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${Math.min(6, block.level + 1)}` as 'h2';
      return <Tag key={key}>{inline(block.text)}</Tag>;
    }
    case 'paragraph':
      return <p key={key}>{inline(block.text)}</p>;
    case 'rule':
      return <hr key={key} />;
    case 'quote':
      return <blockquote key={key}>{block.blocks.map(renderBlock)}</blockquote>;
    case 'code':
      if (block.lang === 'chart') return <ChartBlock key={key} source={block.code} complete={block.closed} />;
      return <CodeBlock key={key} code={block.code} lang={block.lang} />;
    case 'table':
      return (
        <div key={key} className="tai-table">
          <table>
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index} style={block.align[index] == null ? undefined : { textAlign: block.align[index]! }}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {block.head.map((_cell, index) => (
                    <td key={index} style={block.align[index] == null ? undefined : { textAlign: block.align[index]! }}>
                      {inline(row[index] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'list': {
      const items = block.items.map((item, index) => {
        // A one-paragraph item is drawn without the paragraph's own margins.
        const first = item.blocks[0];
        const only = item.blocks.length === 1 && first !== undefined && first.kind === 'paragraph' ? first : null;
        return (
          <li key={index} className={item.checked === null ? undefined : 'tai-task'}>
            {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly disabled />}
            {only !== null ? inline(only.text) : item.blocks.map(renderBlock)}
          </li>
        );
      });
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="tai-md">{blocks.map(renderBlock)}</div>;
});
