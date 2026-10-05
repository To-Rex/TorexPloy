/**
 * Streaming logs over SSE.
 *
 * Lines arrive in bursts (a build can print thousands per second), so they
 * are buffered and committed to React state once per animation frame. A cap
 * keeps memory bounded on very long runtime streams.
 */
import { useEffect, useRef, useState } from 'react';
import type { LogLine, UpdateProgressDto } from '@ploy/shared';

export interface StreamLine extends LogLine {
  replica?: number;
  /** Compose service that printed the line. */
  source?: string;
  /** A self-update progress marker carried by this line. */
  progress?: UpdateProgressDto;
}

export type StreamState = 'connecting' | 'streaming' | 'ended' | 'error';

const MAX_LINES = 50_000;

export function useLogStream(url: string | null): { lines: StreamLine[]; state: StreamState; endStatus: string | null; clear: () => void } {
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const [endStatus, setEndStatus] = useState<string | null>(null);
  const buffer = useRef<StreamLine[]>([]);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    if (url === null) return;
    setLines([]);
    setState('connecting');
    setEndStatus(null);
    buffer.current = [];
    seen.current = new Set();
    let frame = 0;
    let closed = false;

    const flush = (): void => {
      frame = 0;
      if (buffer.current.length === 0) return;
      const batch = buffer.current;
      buffer.current = [];
      setLines((previous) => {
        const next = previous.concat(batch);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    };

    const source = new EventSource(url);
    source.addEventListener('line', (message) => {
      const line = JSON.parse((message as MessageEvent<string>).data) as StreamLine;
      if (seen.current.has(line.seq)) return;
      seen.current.add(line.seq);
      buffer.current.push(line);
      setState('streaming');
      if (frame === 0) frame = requestAnimationFrame(flush);
    });
    source.addEventListener('meta', () => setState('streaming'));
    source.addEventListener('end', (message) => {
      closed = true;
      source.close();
      flush();
      try {
        setEndStatus((JSON.parse((message as MessageEvent<string>).data) as { status?: string }).status ?? null);
      } catch {
        setEndStatus(null);
      }
      setState('ended');
    });
    source.onerror = () => {
      if (closed) return;
      // EventSource retries on its own; reflect the gap without dropping lines.
      setState((current) => (current === 'ended' ? current : 'error'));
    };
    return () => {
      closed = true;
      source.close();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [url]);

  return {
    lines,
    state,
    endStatus,
    clear: () => {
      buffer.current = [];
      setLines([]);
    },
  };
}
