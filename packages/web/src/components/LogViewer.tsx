/**
 * Log viewer: virtualized (tens of thousands of lines stay smooth), ANSI
 * colours, filtering, line wrapping and "follow the tail" that pauses as
 * soon as the reader scrolls up.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Search, WrapText } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import type { StreamLine } from '../lib/logs.ts';
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

function renderText(text: string): ReactNode {
  if (!text.includes('\x1b')) return text;
  return parseAnsi(text).map((segment, index) => (
    <span key={index} style={{ color: segment.color, fontWeight: segment.bold ? 650 : undefined }}>
      {segment.text}
    </span>
  ));
}

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// ---------------------------------------------------------------------------

export interface LogViewerProps {
  lines: StreamLine[];
  /** Fill the remaining viewport height. */
  height?: number | string;
  showReplica?: boolean;
  empty?: ReactNode;
  toolbar?: ReactNode;
  live?: boolean;
}

export function LogViewer({ lines, height = 'calc(100dvh - 330px)', showReplica = false, empty, toolbar, live = true }: LogViewerProps) {
  const { m, t, plural } = useI18n();
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return lines;
    return lines.filter((line) => stripAnsi(line.text).toLowerCase().includes(needle));
  }, [lines, filter]);

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
  }, [wrap, virtualizer]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (element === null) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    if (bottom !== atBottom.current) {
      atBottom.current = bottom;
      setFollow(bottom);
    }
  };

  const time = (value: number) => {
    const date = new Date(value);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  };

  return (
    <div className="logview" data-wrap={wrap || undefined}>
      <div className="logview__bar">
        <label className="logview__search">
          <Search aria-hidden="true" />
          <span className="sr-only">{m.logs.filter}</span>
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={m.logs.filter} spellCheck={false} />
        </label>
        <span className="logview__count tabular">{plural(m.logs.lines, visible.length)}</span>
        <div className="row" style={{ marginLeft: 'auto', gap: 4 }}>
          {toolbar}
          <Button variant="ghost" size="sm" icon={<WrapText />} aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>
            {m.deployment.wrap}
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="logview__scroll" style={{ height }} onScroll={onScroll} tabIndex={0} role="log" aria-live={live && follow ? 'polite' : 'off'} aria-label={m.app.tabs.logs}>
        {visible.length === 0 ? (
          <div className="logview__empty">{filter.length > 0 ? m.palette.noResults : (empty ?? m.logs.empty)}</div>
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
                  style={{ transform: `translateY(${item.start}px)`, ...(wrap ? {} : { height: 20 }) }}
                >
                  <span className="logline__time">{time(line.t)}</span>
                  {showReplica && line.replica !== undefined && <span className="logline__replica">{t(m.logs.replica, { n: line.replica + 1 })}</span>}
                  <span className="logline__text">{renderText(line.text)}</span>
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
