/**
 * A small code editor: line numbers, the caret's line picked out, lines
 * flagged where something is wrong, and each line drawn by the caller (so
 * the caller decides what is a keyword and what is a comment).
 *
 * It is a plain <textarea> with its text made transparent, lying exactly
 * over a <pre> that draws the same text in colour. Everything a textarea
 * does (selection, undo, IME, the phone keyboard, screen readers) keeps
 * working, because it still is one.
 */
import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { DotenvLine } from '@ploy/shared';

export interface Caret {
  /** 0-based. */
  line: number;
  column: number;
}

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Draws one line. `active` is true for the line the caret is on. */
  renderLine: (line: string, index: number, active: boolean) => ReactNode;
  label: string;
  readOnly?: boolean;
  minRows?: number;
  maxRows?: number;
  /** Lines to flag in the gutter and the text, by 0-based index. */
  marks?: ReadonlyMap<number, 'bad' | 'warn'>;
  /** The line-comment prefix; with it, Ctrl+/ (⌘/) comments the selected lines in and out. */
  comment?: string;
  placeholder?: string;
  /** A row above the text (a file name, switches) and one below it (counts, hints), inside the same frame. */
  bar?: ReactNode;
  foot?: ReactNode;
  onCaret?: (caret: Caret | null) => void;
}

function caretOf(element: HTMLTextAreaElement): Caret {
  const before = element.value.slice(0, element.selectionStart);
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length - 1, column: before.length - lineStart };
}

/** Comment the selected lines out, or back in when every one of them already is. Returns false when there was nothing to do. */
function toggleComment(element: HTMLTextAreaElement, prefix: string): boolean {
  const { value, selectionStart, selectionEnd } = element;
  const from = value.lastIndexOf('\n', selectionStart - 1) + 1;
  // A selection that ends at the start of a line does not include that line.
  const last = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
  const newline = value.indexOf('\n', last);
  const to = newline === -1 ? value.length : newline;
  const lines = value.slice(from, to).split('\n');
  const filled = lines.filter((line) => line.trim().length > 0);
  if (filled.length === 0) return false;
  const commented = filled.every((line) => line.trimStart().startsWith(prefix));
  const next = lines
    .map((line) => {
      if (line.trim().length === 0) return line;
      const indent = line.length - line.trimStart().length;
      const body = line.slice(indent);
      if (!commented) return `${line.slice(0, indent)}${prefix} ${body}`;
      const rest = body.slice(prefix.length);
      return `${line.slice(0, indent)}${rest.startsWith(' ') ? rest.slice(1) : rest}`;
    })
    .join('\n');
  element.focus();
  element.setSelectionRange(from, to);
  // execCommand keeps the change in the textarea's own undo history; setRangeText is the fallback where it is gone.
  let done = false;
  try {
    done = document.execCommand('insertText', false, next);
  } catch {
    done = false;
  }
  if (!done) {
    element.setRangeText(next, from, to, 'end');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  element.setSelectionRange(from, from + next.length);
  return true;
}

export function CodeEditor({ value, onChange, renderLine, label, readOnly = false, minRows = 8, maxRows = 26, marks, comment, placeholder, bar, foot, onCaret }: CodeEditorProps) {
  const [caret, setCaret] = useState<Caret | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lines = value.split('\n');
  const digits = String(lines.length).length;

  const track = useCallback(
    (element: HTMLTextAreaElement | null) => {
      const next = element === null || document.activeElement !== element ? null : caretOf(element);
      setCaret((current) => (current?.line === next?.line && current?.column === next?.column ? current : next));
      onCaret?.(next);
    },
    [onCaret],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (comment !== undefined && !readOnly && (event.metaKey || event.ctrlKey) && !event.altKey && event.key === '/') {
      event.preventDefault();
      if (toggleComment(event.currentTarget, comment)) {
        onChange(event.currentTarget.value);
        track(event.currentTarget);
      }
    }
  };

  return (
    <div className="code" data-readonly={readOnly || undefined}>
      {bar !== undefined && <div className="code__bar">{bar}</div>}
      <div className="code__scroll" style={{ '--code-min': minRows, '--code-max': maxRows, '--code-digits': digits } as React.CSSProperties}>
        <div className="code__gutter" aria-hidden="true">
          {lines.map((_, index) => (
            <span key={index} data-active={caret?.line === index || undefined} data-mark={marks?.get(index)}>
              {index + 1}
            </span>
          ))}
        </div>
        <div className="code__stage">
          <pre className="code__paint" aria-hidden="true">
            {value.length === 0 && placeholder !== undefined ? (
              <span className="code__placeholder">{placeholder}</span>
            ) : (
              lines.map((line, index) => (
                <span key={index} className="code__line" data-active={caret?.line === index || undefined} data-mark={marks?.get(index)}>
                  {line.length === 0 ? '​' : renderLine(line, index, caret?.line === index)}
                </span>
              ))
            )}
          </pre>
          <textarea
            ref={input}
            className="code__input"
            value={value}
            readOnly={readOnly}
            aria-label={label}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            onChange={(event) => {
              onChange(event.target.value);
              track(event.target);
            }}
            onKeyDown={onKeyDown}
            onSelect={(event) => track(event.currentTarget)}
            onFocus={(event) => track(event.currentTarget)}
            onBlur={() => track(null)}
          />
        </div>
      </div>
      {foot !== undefined && <div className="code__foot">{foot}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------

/** Which lines of `.env` text to flag: those that are not `KEY=value`, and those a later line overrides. */
export function dotenvMarks(lines: readonly DotenvLine[]): Map<number, 'bad' | 'warn'> {
  const marks = new Map<number, 'bad' | 'warn'>();
  lines.forEach((line, index) => {
    if (line.kind === 'bad') marks.set(index, 'bad');
    else if (line.shadowed) marks.set(index, 'warn');
  });
  return marks;
}

const DISABLED_RE = /^(#\s*)((?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;
const ASSIGN_RE = /^(export\s+)?([^=\s]+)(\s*=\s*)(.*)$/;
const REFERENCE_RE = /(\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?][^}]*)?\}|\$[A-Za-z_][A-Za-z0-9_]*)/g;

/** Text with `${NAME}` references picked out; `escapes` also picks out backslash escapes (inside double quotes). */
function withReferences(text: string, className: string, escapes: boolean, keyPrefix: string): ReactNode[] {
  const pattern = escapes ? new RegExp(`${REFERENCE_RE.source}|(\\\\.)`, 'g') : new RegExp(REFERENCE_RE.source, 'g');
  const out: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) out.push(<span key={`${keyPrefix}${at}`} className={className}>{text.slice(at, match.index)}</span>);
    out.push(<span key={`${keyPrefix}${match.index}r`} className={match[1] !== undefined ? 'tok-ref' : 'tok-esc'}>{match[0]}</span>);
    at = match.index + match[0].length;
  }
  if (at < text.length) out.push(<span key={`${keyPrefix}${at}`} className={className}>{text.slice(at)}</span>);
  return out;
}

/** The right-hand side of `KEY=`: a quoted or bare value, then perhaps a comment. */
function valueTokens(source: string, conceal: boolean): ReactNode[] {
  if (source.length === 0) return [];
  const quote = source[0];
  let valueEnd = source.length;
  let quoted = false;
  if (quote === '"' || quote === "'") {
    let close = -1;
    for (let index = 1; index < source.length; index += 1) {
      if (quote === '"' && source[index] === '\\') index += 1;
      else if (source[index] === quote) {
        close = index;
        break;
      }
    }
    if (close !== -1 && /^\s*(#.*)?$/.test(source.slice(close + 1))) {
      valueEnd = close + 1;
      quoted = true;
    } else if (source.endsWith(quote) && source.length >= 2) {
      quoted = true;
    }
  }
  if (!quoted) {
    const trailing = /\s+#.*$/.exec(source);
    if (trailing !== null) valueEnd = trailing.index;
  }
  const value = source.slice(0, valueEnd);
  const rest = source.slice(valueEnd);
  const out: ReactNode[] = [];
  if (conceal) {
    // Same number of characters, so the caret still lands where it looks like it does.
    out.push(<span key="v" className="tok-mask">{'•'.repeat(value.length)}</span>);
  } else if (quoted) {
    out.push(<span key="q1" className="tok-quote">{quote}</span>);
    out.push(...withReferences(value.slice(1, -1), 'tok-str', quote === '"', 's'));
    out.push(<span key="q2" className="tok-quote">{quote}</span>);
  } else if (/^-?\d+(\.\d+)?$/.test(value)) {
    out.push(<span key="v" className="tok-num">{value}</span>);
  } else if (/^(true|false|yes|no|on|off|null)$/i.test(value)) {
    out.push(<span key="v" className="tok-kw">{value}</span>);
  } else {
    out.push(...withReferences(value, 'tok-val', false, 'v'));
  }
  if (rest.length > 0) out.push(<span key="c" className="tok-comment">{rest}</span>);
  return out;
}

/**
 * One line of `.env` text, coloured: comments, variables switched off with
 * a `#`, `export`, the name, the value (quoted text, numbers, `${NAME}`
 * references), and lines that are not `KEY=value` at all. With `conceal`
 * the values are drawn as dots.
 */
export function renderDotenvLine(line: string, info: DotenvLine | undefined, conceal: boolean): ReactNode {
  const indent = line.length - line.trimStart().length;
  const lead = line.slice(0, indent);
  const body = line.slice(indent);
  if (body.startsWith('#')) {
    const off = info?.kind === 'disabled' ? DISABLED_RE.exec(body) : null;
    if (off === null) return <span className="tok-comment">{line}</span>;
    return (
      <span className="tok-off">
        {lead}
        <span className="tok-comment">{off[1]}{off[2]}</span>
        <span className="tok-off-key">{off[3]}</span>
        <span className="tok-comment">{off[4]}{conceal ? '•'.repeat(off[5]!.length) : off[5]}</span>
      </span>
    );
  }
  const match = info?.kind === 'bad' ? null : ASSIGN_RE.exec(body);
  if (match === null) return <span className="tok-bad">{line}</span>;
  return (
    <>
      {lead}
      {match[1] !== undefined && <span className="tok-kw">{match[1]}</span>}
      <span className={info?.shadowed === true ? 'tok-key tok-key--shadowed' : 'tok-key'}>{match[2]}</span>
      <span className="tok-op">{match[3]}</span>
      {valueTokens(match[4]!, conceal)}
    </>
  );
}
