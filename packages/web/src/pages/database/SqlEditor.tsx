/**
 * The SQL editor: the code editor's transparent-textarea technique (so
 * selection, undo, IME and screen readers keep working) with SQL colouring
 * across lines, the failing part of a statement underlined, completion of
 * keywords, tables and columns as you type, and the keys people expect from
 * a database tool (Ctrl+Enter runs the statement, Ctrl+Shift+Enter or F5
 * the script, Ctrl+/ comments lines, Tab indents).
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { tokenizeSql, type SqlDialect, type SqlTokenKind } from '@ploy/shared';

export interface Completion {
  label: string;
  kind: 'keyword' | 'table' | 'view' | 'column' | 'function' | 'schema' | 'database' | 'snippet';
  detail?: string;
  /** Text to insert instead of the label (a quoted identifier). */
  insert?: string;
}

export interface CompletionContext {
  /** The word before a dot (`users.` → users). */
  qualifier: string | null;
  /** The statement the caret is in. */
  text: string;
}

export interface SqlEditorHandle {
  focus: () => void;
  /** The selected text and where it is (empty when nothing is selected). */
  selection: () => { start: number; end: number; text: string };
  caret: () => number;
  /** Replace the selection (or insert at the caret), keeping undo. */
  insert: (text: string) => void;
  /** Put the caret at an offset and show it. */
  reveal: (offset: number) => void;
}

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  dialect: SqlDialect;
  label: string;
  completions?: (context: CompletionContext) => Completion[];
  onRun?: (mode: 'statement' | 'all') => void;
  /** The part to underline (an error position), as offsets. */
  error?: { start: number; end: number } | null;
  readOnly?: boolean;
  /** Take the parent's height instead of growing with the text. */
  fill?: boolean;
  minRows?: number;
  maxRows?: number;
  placeholder?: string;
  bar?: ReactNode;
  foot?: ReactNode;
  onCaret?: (offset: number) => void;
}

const TOKEN_CLASS: Partial<Record<SqlTokenKind, string>> = {
  keyword: 'tok-sql-kw',
  string: 'tok-sql-str',
  number: 'tok-sql-num',
  comment: 'tok-comment',
  quoted: 'tok-sql-ident',
  operator: 'tok-sql-op',
  function: 'tok-sql-fn',
  param: 'tok-sql-param',
};

const COMPLETION_GLYPH: Record<Completion['kind'], string> = {
  keyword: 'K',
  table: 'T',
  view: 'V',
  column: 'C',
  function: 'ƒ',
  schema: 'S',
  database: 'D',
  snippet: '…',
};

const LINE_HEIGHT = 21;
const PAD_Y = 12;
const PAD_X = 14;

let measured: number | null = null;
function charWidth(element: HTMLElement): number {
  if (measured !== null) return measured;
  const canvas = document.createElement('canvas').getContext('2d');
  if (canvas === null) return 7.8;
  const style = getComputedStyle(element);
  canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  measured = canvas.measureText('M'.repeat(40)).width / 40;
  return measured;
}

/** Insert text over the selection so it lands in the textarea's own undo history. */
function insertText(element: HTMLTextAreaElement, text: string): void {
  element.focus();
  let done = false;
  try {
    done = document.execCommand('insertText', false, text);
  } catch {
    done = false;
  }
  if (!done) {
    element.setRangeText(text, element.selectionStart, element.selectionEnd, 'end');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Comment the selected lines out with `--`, or back in when all of them are. */
function toggleComment(element: HTMLTextAreaElement): void {
  const { value, selectionStart, selectionEnd } = element;
  const from = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const last = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? selectionEnd - 1 : selectionEnd;
  const newline = value.indexOf('\n', last);
  const to = newline === -1 ? value.length : newline;
  const lines = value.slice(from, to).split('\n');
  const filled = lines.filter((line) => line.trim().length > 0);
  if (filled.length === 0) return;
  const commented = filled.every((line) => line.trimStart().startsWith('--'));
  const next = lines
    .map((line) => {
      if (line.trim().length === 0) return line;
      const indent = line.length - line.trimStart().length;
      const body = line.slice(indent);
      if (!commented) return `${line.slice(0, indent)}-- ${body}`;
      const rest = body.slice(2);
      return `${line.slice(0, indent)}${rest.startsWith(' ') ? rest.slice(1) : rest}`;
    })
    .join('\n');
  element.setSelectionRange(from, to);
  insertText(element, next);
  element.setSelectionRange(from, from + next.length);
}

/** Indent (or outdent) every selected line by two spaces. */
function shiftLines(element: HTMLTextAreaElement, outdent: boolean): void {
  const { value, selectionStart, selectionEnd } = element;
  const from = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const newline = value.indexOf('\n', selectionEnd - (selectionEnd > selectionStart && value[selectionEnd - 1] === '\n' ? 1 : 0));
  const to = newline === -1 ? value.length : newline;
  const next = value
    .slice(from, to)
    .split('\n')
    .map((line) => (outdent ? line.replace(/^ {1,2}/, '') : `  ${line}`))
    .join('\n');
  element.setSelectionRange(from, to);
  insertText(element, next);
  element.setSelectionRange(from, from + next.length);
}

export const SqlEditor = forwardRef<SqlEditorHandle, SqlEditorProps>(function SqlEditor(
  { value, onChange, dialect, label, completions, onRun, error, readOnly = false, fill = false, minRows = 6, maxRows = 30, placeholder, bar, foot, onCaret },
  ref,
) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const [popup, setPopup] = useState<{ items: Completion[]; index: number; from: number; x: number; y: number } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      selection: () => {
        const element = input.current;
        if (element === null) return { start: 0, end: 0, text: '' };
        return { start: element.selectionStart, end: element.selectionEnd, text: element.value.slice(element.selectionStart, element.selectionEnd) };
      },
      caret: () => input.current?.selectionStart ?? 0,
      insert: (text) => {
        if (input.current !== null) insertText(input.current, text);
      },
      reveal: (offset) => {
        const element = input.current;
        if (element === null) return;
        element.focus();
        element.setSelectionRange(offset, offset);
        const line = element.value.slice(0, offset).split('\n').length - 1;
        const scroller = element.closest('.code__scroll');
        if (scroller !== null) scroller.scrollTop = Math.max(0, line * LINE_HEIGHT - scroller.clientHeight / 2);
      },
    }),
    [],
  );

  const lines = useMemo(() => {
    const out: ReactNode[][] = [[]];
    const tokens = tokenizeSql(value, dialect);
    let offset = 0;
    let key = 0;
    const piece = (text: string, kind: SqlTokenKind, start: number): ReactNode[] => {
      const className = TOKEN_CLASS[kind];
      const end = start + text.length;
      if (error !== null && error !== undefined && start < error.end && end > error.start) {
        const a = Math.max(0, error.start - start);
        const b = Math.min(text.length, error.end - start);
        return [
          a > 0 ? <span key={key++} className={className}>{text.slice(0, a)}</span> : null,
          <span key={key++} className={`${className ?? ''} tok-error`}>{text.slice(a, b)}</span>,
          b < text.length ? <span key={key++} className={className}>{text.slice(b)}</span> : null,
        ];
      }
      return [className === undefined ? text : <span key={key++} className={className}>{text}</span>];
    };
    for (const token of tokens) {
      const parts = token.text.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) {
          out.push([]);
          offset += 1;
        }
        if (part.length > 0) {
          out[out.length - 1]!.push(...piece(part, token.kind, offset));
          offset += part.length;
        }
      });
    }
    return out;
  }, [value, dialect, error]);

  const errorLine = useMemo(() => (error === null || error === undefined ? null : value.slice(0, error.start).split('\n').length - 1), [error, value]);
  const digits = String(lines.length).length;

  const track = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (element === null || document.activeElement !== element) {
        setCaretLine(null);
        return;
      }
      const offset = element.selectionStart;
      setCaretLine(element.value.slice(0, offset).split('\n').length - 1);
      onCaret?.(offset);
    },
    [onCaret],
  );

  const suggest = useCallback(
    (element: HTMLTextAreaElement, force: boolean) => {
      if (completions === undefined || readOnly) return;
      const caret = element.selectionStart;
      if (element.selectionEnd !== caret) return setPopup(null);
      const before = element.value.slice(0, caret);
      // Not inside a comment or an unfinished string.
      const last = tokenizeSql(before.slice(before.lastIndexOf('\n') + 1), dialect).at(-1);
      if (last?.kind === 'comment') return setPopup(null);
      if (last?.kind === 'string' && !(last.text.length > 1 && last.text.endsWith(last.text[0]!))) return setPopup(null);
      const match = /(?:([A-Za-z_][\w$]*)\.)?([A-Za-z_][\w$]*)?$/.exec(before);
      const qualifier = match?.[1] ?? null;
      const word = match?.[2] ?? '';
      if (!force && word.length === 0 && qualifier === null) return setPopup(null);
      const statementStart = Math.max(before.lastIndexOf(';') + 1, 0);
      const statementEnd = element.value.indexOf(';', caret);
      const text = element.value.slice(statementStart, statementEnd === -1 ? element.value.length : statementEnd);
      const lower = word.toLowerCase();
      const all = completions({ qualifier, text });
      const starts = all.filter((item) => item.label.toLowerCase().startsWith(lower));
      const contains = lower.length >= 2 ? all.filter((item) => !item.label.toLowerCase().startsWith(lower) && item.label.toLowerCase().includes(lower)) : [];
      const items = [...starts, ...contains].slice(0, 40);
      if (items.length === 0 || (items.length === 1 && items[0]!.label.toLowerCase() === lower && !force)) return setPopup(null);
      const lineStart = before.lastIndexOf('\n') + 1;
      const line = before.split('\n').length - 1;
      const column = caret - lineStart - word.length;
      const rect = element.getBoundingClientRect();
      const width = charWidth(element);
      const x = Math.min(window.innerWidth - 340, rect.left + PAD_X + column * width - 8);
      const below = rect.top + PAD_Y + (line + 1) * LINE_HEIGHT + 2;
      const y = below + 250 > window.innerHeight ? below - LINE_HEIGHT - 254 : below;
      setPopup({ items, index: 0, from: caret - word.length, x: Math.max(8, x), y: Math.max(8, y) });
    },
    [completions, dialect, readOnly],
  );

  const accept = (element: HTMLTextAreaElement, item: Completion) => {
    if (popup === null) return;
    element.setSelectionRange(popup.from, element.selectionStart);
    insertText(element, item.insert ?? item.label);
    setPopup(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;
    if (popup !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setPopup({ ...popup, index: (popup.index + step + popup.items.length) % popup.items.length });
        return;
      }
      if ((event.key === 'Enter' && !mod) || event.key === 'Tab') {
        event.preventDefault();
        accept(element, popup.items[popup.index]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPopup(null);
        return;
      }
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      onRun?.(event.shiftKey ? 'all' : 'statement');
      return;
    }
    if (event.key === 'F5') {
      event.preventDefault();
      onRun?.('all');
      return;
    }
    if (readOnly) return;
    if (mod && (event.key === ' ' || event.code === 'Space')) {
      event.preventDefault();
      suggest(element, true);
      return;
    }
    if (mod && !event.altKey && event.key === '/') {
      event.preventDefault();
      toggleComment(element);
      return;
    }
    if (event.key === 'Tab' && !mod && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey || element.value.slice(element.selectionStart, element.selectionEnd).includes('\n')) shiftLines(element, event.shiftKey);
      else insertText(element, '  ');
      return;
    }
    if (event.key === 'Enter' && !mod && !event.shiftKey && !event.altKey) {
      // Keep the indentation of the line, one step deeper after an opening bracket.
      const before = element.value.slice(0, element.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      event.preventDefault();
      insertText(element, `\n${indent}${/\(\s*$/.test(line) ? '  ' : ''}`);
    }
  };

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const element = event.currentTarget;
    if (native.inputType === 'insertText' && native.data !== null && /^[\w.$]$/.test(native.data)) suggest(element, false);
    else if (native.inputType?.startsWith('delete') && popup !== null) suggest(element, false);
    else setPopup(null);
  };

  return (
    <div className={`code sqled${fill ? ' code--fill' : ''}`} data-readonly={readOnly || undefined}>
      {bar !== undefined && <div className="code__bar">{bar}</div>}
      <div
        className="code__scroll"
        style={{ '--code-min': minRows, '--code-max': maxRows, '--code-digits': digits } as React.CSSProperties}
        onScroll={() => setPopup(null)}
      >
        <div className="code__gutter" aria-hidden="true">
          {lines.map((_, index) => (
            <span key={index} data-active={caretLine === index || undefined} data-mark={errorLine === index ? 'bad' : undefined}>
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
                <span key={index} className="code__line" data-active={caretLine === index || undefined} data-mark={errorLine === index ? 'bad' : undefined}>
                  {line.length === 0 ? '​' : line}
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
            aria-autocomplete="list"
            aria-expanded={popup !== null}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            onChange={(event) => {
              onChange(event.target.value);
              track(event.target);
            }}
            onInput={onInput}
            onKeyDown={onKeyDown}
            onSelect={(event) => track(event.currentTarget)}
            onFocus={(event) => track(event.currentTarget)}
            onBlur={() => {
              track(null);
              setTimeout(() => setPopup(null), 120);
            }}
            onMouseDown={() => setPopup(null)}
          />
        </div>
      </div>
      {foot !== undefined && <div className="code__foot">{foot}</div>}
      {popup !== null && (
        <ul className="sqled__popup" role="listbox" style={{ left: popup.x, top: popup.y }}>
          {popup.items.map((item, index) => (
            <li
              key={`${item.kind}:${item.label}:${item.detail ?? ''}`}
              role="option"
              aria-selected={index === popup.index}
              ref={index === popup.index ? (node) => node?.scrollIntoView({ block: 'nearest' }) : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                if (input.current !== null) accept(input.current, item);
              }}
            >
              <span className="sqled__glyph" data-kind={item.kind}>
                {COMPLETION_GLYPH[item.kind]}
              </span>
              <span className="sqled__label">{item.label}</span>
              {item.detail !== undefined && <span className="sqled__detail">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
