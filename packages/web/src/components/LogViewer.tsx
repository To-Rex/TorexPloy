/**
 * Log viewer: virtualized (tens of thousands of lines stay smooth), ANSI
 * colours, search with highlighting, severity filter, timestamps on or off,
 * pause, copy, download, line wrapping, full screen, and "follow the tail"
 * that pauses as soon as the reader scrolls up.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Check, Clock, Copy, Download, Eraser, Maximize2, Minimize2, Pause, Play, Search, WrapText } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import { logLevel, type LogLevel } from '../lib/logLevel.ts';
import type { StreamLine } from '../lib/logs.ts';
import { writeClipboard } from './Copy.tsx';
import { Button } from './ui.tsx';

// ---------------------------------------------------------------------------
// ANSI SGR → styled segments
// ---------------------------------------------------------------------------

const ANSI_COLORS = ['#5c6370', '#ff7b85', '#7ee2a8', '#f5c96a', '#86a8ff', '#d79bff', '#6fd8e8', '#d9def0'];
const ANSI_BRIGHT = ['#8a93a6', '#ff9aa1', '#a6f0c3', '#ffe08f', '#a9c1ff', '#e6bcff', '#9cebf5', '#ffffff'];

interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex
const OTHER_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g;

export function parseAnsi(input: string): Segment[] {
  const text = input.replace(OTHER_ESCAPES, (match) => (match.endsWith('m') && match.startsWith('\x1b[') ? match : ''));
  const segments: Segment[] = [];
  let color: string | undefined;
  let bold = false;
  let last = 0;
  for (const match of text.matchAll(ANSI_RE)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), ...(color === undefined ? {} : { color }), bold });
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        color = undefined;
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = undefined;
      else if (code >= 30 && code <= 37) color = ANSI_COLORS[code - 30];
      else if (code >= 90 && code <= 97) color = ANSI_BRIGHT[code - 90];
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), ...(color === undefined ? {} : { color }), bold });
  return segments;
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** Plain text with every match of `needle` wrapped in <mark>; colours are dropped while searching. */
function highlight(text: string, needle: string): ReactNode {
  const plain = stripAnsi(text);
  const lower = plain.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) parts.push(plain.slice(from, at));
    parts.push(<mark key={at}>{plain.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < plain.length) parts.push(plain.slice(from));
  return parts;
}

function renderText(text: string, needle: string): ReactNode {
  if (needle.length > 0) return highlight(text, needle);
  if (!text.includes('\x1b')) return text;
  return parseAnsi(text).map((segment, index) => (
    <span key={index} style={{ color: segment.color, fontWeight: segment.bold ? 650 : undefined }}>
      {segment.text}
    </span>
  ));
}

const pad = (value: number): string => String(value).padStart(2, '0');
const clock = (value: number): string => {
  const date = new Date(value);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
const stamp = (value: number): string => {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(value)}`;
};

/** Text of the lines as they are shown, for the clipboard and downloads. */
function toText(lines: StreamLine[], timestamps: boolean): string {
  return lines
    .map((line) => {
      const tag = line.source ?? (line.replica === undefined ? null : `#${line.replica + 1}`);
      return `${timestamps ? `${stamp(line.t)} ` : ''}${tag === null ? '' : `[${tag}] `}${stripAnsi(line.text)}`;
    })
    .join('\n');
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

// ---------------------------------------------------------------------------

export type LevelFilter = 'all' | LogLevel;

export interface LogViewerProps {
  lines: StreamLine[];
  /** Fill the remaining viewport height. */
  height?: number | string;
  showReplica?: boolean;
  empty?: ReactNode;
  toolbar?: ReactNode;
  live?: boolean;
  /** File name (without extension) for downloads; also the copy toast's subject. */
  name?: string;
  /** Offered when the page can drop what it holds (runtime streams). */
  onClear?: () => void;
  /** Hide the severity filter (build logs have no levels worth filtering). */
  levels?: boolean;
}

export function LogViewer({ lines, height = 'calc(100dvh - 330px)', showReplica = false, empty, toolbar, live = true, name = 'logs', onClear, levels = true }: LogViewerProps) {
  const { m, t, plural } = useI18n();
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [wrap, setWrap] = useState(false);
  const [timestamps, setTimestamps] = useState(true);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const frozen = useRef<StreamLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // While paused the view keeps the lines it had; new ones are counted, not shown.
  const shown = paused ? frozen.current : lines;
  const pending = paused ? Math.max(0, lines.length - frozen.current.length) : 0;

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (needle.length === 0 && level === 'all') return shown;
    return shown.filter((line) => (level === 'all' || logLevel(line.text) === level) && (needle.length === 0 || stripAnsi(line.text).toLowerCase().includes(needle)));
  }, [shown, needle, level]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 30,
    ...(wrap ? { measureElement: (element: Element) => element.getBoundingClientRect().height } : {}),
  });

  useEffect(() => {
    if (follow && visible.length > 0) virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
  }, [visible.length, follow, virtualizer]);

  useEffect(() => {
    virtualizer.measure();
  }, [wrap, timestamps, full, virtualizer]);

  // Esc leaves full screen, the way it closes everything else.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (element === null) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    if (bottom !== atBottom.current) {
      atBottom.current = bottom;
      setFollow(bottom);
    }
  };

  const togglePause = () => {
    if (!paused) frozen.current = lines;
    setPaused((value) => !value);
  };

  const copy = async () => {
    if (await writeClipboard(toText(visible, timestamps))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    }
  };

  const l = m.logs;
  return (
    <div className={full ? 'logview logview--full' : 'logview'} data-wrap={wrap || undefined}>
      <div className="logview__bar">
        <label className="logview__search">
          <Search aria-hidden="true" />
          <span className="sr-only">{l.filter}</span>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={l.filter} spellCheck={false} />
        </label>
        {levels && (
          <select className="logview__select" value={level} onChange={(event) => setLevel(event.target.value as LevelFilter)} aria-label={l.level}>
            <option value="all">{l.levels.all}</option>
            <option value="error">{l.levels.error}</option>
            <option value="warn">{l.levels.warn}</option>
            <option value="info">{l.levels.info}</option>
            <option value="debug">{l.levels.debug}</option>
          </select>
        )}
        <span className="logview__count tabular">
          {plural(l.lines, visible.length)}
          {pending > 0 && ` · +${pending}`}
        </span>
        <div className="logview__tools">
          {toolbar}
          {live && (
            <Button variant="ghost" size="sm" iconOnly icon={paused ? <Play /> : <Pause />} aria-pressed={paused} title={paused ? l.resume : l.pause} onClick={togglePause}>
              {paused ? l.resume : l.pause}
            </Button>
          )}
          <Button variant="ghost" size="sm" iconOnly icon={<Clock />} aria-pressed={timestamps} title={l.timestamps} onClick={() => setTimestamps((value) => !value)}>
            {l.timestamps}
          </Button>
          <Button variant="ghost" size="sm" iconOnly icon={<WrapText />} aria-pressed={wrap} title={m.deployment.wrap} onClick={() => setWrap((value) => !value)}>
            {m.deployment.wrap}
          </Button>
          <Button variant="ghost" size="sm" iconOnly icon={copied ? <Check /> : <Copy />} title={l.copy} disabled={visible.length === 0} onClick={() => void copy()} aria-live="polite">
            {copied ? m.common.copied : l.copy}
          </Button>
          <Button variant="ghost" size="sm" iconOnly icon={<Download />} title={l.download} disabled={visible.length === 0} onClick={() => download(`${name}.txt`, toText(visible, true))}>
            {l.download}
          </Button>
          {onClear !== undefined && (
            <Button variant="ghost" size="sm" iconOnly icon={<Eraser />} title={l.clear} disabled={lines.length === 0} onClick={() => { frozen.current = []; onClear(); }}>
              {l.clear}
            </Button>
          )}
          <Button variant="ghost" size="sm" iconOnly icon={full ? <Minimize2 /> : <Maximize2 />} aria-pressed={full} title={full ? l.exitFullscreen : l.fullscreen} onClick={() => setFull((value) => !value)}>
            {full ? l.exitFullscreen : l.fullscreen}
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="logview__scroll" style={{ height: full ? undefined : height }} onScroll={onScroll} tabIndex={0} role="log" aria-live={live && follow && !paused ? 'polite' : 'off'} aria-label={m.app.tabs.logs}>
        {visible.length === 0 ? (
          <div className="logview__empty">{needle.length > 0 || level !== 'all' ? m.palette.noResults : (empty ?? l.empty)}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = visible[item.index]!;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={wrap ? virtualizer.measureElement : undefined}
                  className="logline"
                  data-stream={line.stream}
                  data-stage={line.stage === undefined ? undefined : true}
                  data-level={levels ? logLevel(line.text) : undefined}
                  style={{ transform: `translateY(${item.start}px)`, ...(wrap ? {} : { height: 20 }) }}
                >
                  {timestamps && (
                    <span className="logline__time" title={stamp(line.t)}>
                      {clock(line.t)}
                    </span>
                  )}
                  {line.source !== undefined ? (
                    <span className="logline__replica">{line.source}</span>
                  ) : (
                    showReplica && line.replica !== undefined && <span className="logline__replica">{t(l.replica, { n: line.replica + 1 })}</span>
                  )}
                  <span className="logline__text">{renderText(line.text, needle)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!follow && visible.length > 0 && (
        <button
          type="button"
          className="logview__jump"
          onClick={() => {
            setFollow(true);
            atBottom.current = true;
            virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
          }}
        >
          <ArrowDownToLine aria-hidden="true" />
          {m.deployment.follow}
        </button>
      )}
    </div>
  );
}
