/**
 * A shell inside a container: xterm.js over the control plane's terminal
 * WebSocket. Binary frames carry bytes both ways; text frames carry JSON
 * control messages (resize from here; ready, exit and error from the server).
 */
import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RotateCcw, SquareTerminal } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import { Button } from './ui.tsx';

export type Shell = 'auto' | 'bash' | 'sh';

type Phase =
  | { kind: 'connecting' }
  | { kind: 'open'; container: string }
  | { kind: 'exited'; code: number | null }
  | { kind: 'error'; code: string };

const ERROR_CODES = ['not_running', 'server_unavailable', 'failed', 'idle', 'connection_lost', 'connection_failed', 'no_shell'] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

/** Terminal colours follow the log viewer so both read as one system. */
const PALETTE = {
  black: '#5c6370',
  red: '#ff7b85',
  green: '#7ee2a8',
  yellow: '#f5c96a',
  blue: '#86a8ff',
  magenta: '#d79bff',
  cyan: '#6fd8e8',
  white: '#d9def0',
  brightBlack: '#8a93a6',
  brightRed: '#ff9aa1',
  brightGreen: '#a6f0c3',
  brightYellow: '#ffe08f',
  brightBlue: '#a9c1ff',
  brightMagenta: '#e6bcff',
  brightCyan: '#9cebf5',
  brightWhite: '#ffffff',
};

function socketUrl(path: string, params: Record<string, string | number>): string {
  const url = new URL(path, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

/** `services`: a compose stack — the shell opens in the chosen service instead of a replica. */
export function TerminalView({ path, replicas, services }: { path: string; replicas: number; services?: string[] }) {
  const { m, t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState<Shell>('auto');
  const [replica, setReplica] = useState(0);
  const [service, setService] = useState(services?.[0] ?? '');
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let disposed = false;
    let cleanup = (): void => undefined;

    void (async () => {
      const styles = getComputedStyle(element);
      const fontFamily = styles.getPropertyValue('--font-mono').trim() || 'monospace';
      // xterm measures the cell size once; measuring before the web font arrives misaligns every glyph.
      await document.fonts.load(`13px ${fontFamily}`).catch(() => undefined);
      if (disposed) return;

      const term = new XTerm({
        fontFamily,
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: true,
        scrollback: 5_000,
        convertEol: false,
        theme: {
          background: styles.getPropertyValue('--code-bg').trim(),
          foreground: styles.getPropertyValue('--code-ink').trim(),
          cursor: styles.getPropertyValue('--code-ink').trim(),
          cursorAccent: styles.getPropertyValue('--code-bg').trim(),
          selectionBackground: 'rgba(255, 255, 255, 0.22)',
          ...PALETTE,
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(element);
      fit.fit();
      setPhase({ kind: 'connecting' });

      const ws = new WebSocket(socketUrl(path, { cols: term.cols, rows: term.rows, shell, ...(services === undefined ? { replica } : { service }) }));
      ws.binaryType = 'arraybuffer';
      const encoder = new TextEncoder();
      let opened = false;
      let finished = false;

      ws.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
        if (typeof event.data !== 'string') {
          term.write(new Uint8Array(event.data));
          return;
        }
        const message = JSON.parse(event.data) as { type: string; code?: number | string | null; container?: string };
        if (message.type === 'ready') {
          opened = true;
          setPhase({ kind: 'open', container: message.container ?? '' });
          term.focus();
        } else if (message.type === 'exit') {
          finished = true;
          const code = typeof message.code === 'number' ? message.code : null;
          // 126/127: the shell binary does not exist in this image.
          setPhase(code === 126 || code === 127 ? { kind: 'error', code: 'no_shell' } : { kind: 'exited', code });
        } else if (message.type === 'error') {
          finished = true;
          const code = String(message.code);
          setPhase({ kind: 'error', code: (ERROR_CODES as readonly string[]).includes(code) ? code : 'failed' });
        }
      };
      ws.onclose = () => {
        if (!finished) setPhase({ kind: 'error', code: opened ? 'connection_lost' : 'connection_failed' });
        term.options.cursorBlink = false;
      };

      const input = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
      });
      const resize = term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });
      const observer = new ResizeObserver(() => {
        if (element.clientWidth > 0) fit.fit();
      });
      observer.observe(element);

      cleanup = () => {
        observer.disconnect();
        input.dispose();
        resize.dispose();
        ws.onclose = null;
        ws.close();
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [path, shell, replica, service, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusText =
    phase.kind === 'connecting'
      ? m.terminal.connecting
      : phase.kind === 'open'
        ? m.terminal.connected
        : phase.kind === 'exited'
          ? phase.code === null
            ? m.terminal.exited
            : t(m.terminal.exitedWithCode, { code: phase.code })
          : m.terminal.errors[phase.code as ErrorCode];
  const tone = phase.kind === 'open' ? 'ok' : phase.kind === 'connecting' ? 'work' : phase.kind === 'exited' ? 'idle' : 'bad';

  return (
    <div className="logview term">
      <div className="logview__bar term__bar">
        <span className="term__status" data-tone={tone} role="status" aria-live="polite">
          <span className="term__dot" aria-hidden="true" />
          {statusText}
          {phase.kind === 'open' && phase.container.length > 0 && <code className="term__container">{phase.container}</code>}
        </span>
        <span className="grow" />
        {services !== undefined && services.length > 0 && (
          <label className="term__pick">
            <span>{m.terminal.service}</span>
            <select value={service} onChange={(event) => setService(event.target.value)}>
              {services.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {services === undefined && replicas > 1 && (
          <label className="term__pick">
            <span>{m.terminal.replica}</span>
            <select value={replica} onChange={(event) => setReplica(Number(event.target.value))}>
              {Array.from({ length: replicas }, (_, index) => (
                <option key={index} value={index}>
                  {t(m.terminal.replicaN, { n: index + 1 })}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="term__pick">
          <span>{m.terminal.shell}</span>
          <select value={shell} onChange={(event) => setShell(event.target.value as Shell)}>
            <option value="auto">{m.terminal.shellAuto}</option>
            <option value="bash">bash</option>
            <option value="sh">sh</option>
          </select>
        </label>
        <Button variant="ghost" size="sm" icon={<RotateCcw />} onClick={() => setAttempt((value) => value + 1)}>
          {m.terminal.reconnect}
        </Button>
      </div>
      <div className="term__screen" ref={host} aria-label={m.terminal.title} />
      <div className="term__foot">
        <SquareTerminal aria-hidden="true" />
        {m.terminal.audited}
      </div>
    </div>
  );
}
