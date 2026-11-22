/**
 * A query tab: the editor above, results below, a handle between them.
 *
 * Each tab has its own connection, so a transaction begun here stays open
 * across runs (the bar says so and offers Commit and Rollback). A run stops
 * at the first failing statement, which is underlined in the editor. Results
 * come one tab per statement that returned rows; everything else (row
 * counts, notices, timings, the error) is under Messages. EXPLAIN draws the
 * plan.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Ban,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Download,
  FileUp,
  History,
  ListTree,
  Lock,
  Play,
  PlayCircle,
  Search,
  Square,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { splitSql, statementAt, type DbCell, type DbRunResultDto, type DbStatementResultDto } from '@ploy/shared';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Callout, Input, Kbd, Select, Switch } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { errorText } from '../../lib/errors.ts';
import { useConsole, type ConsoleTab } from './ConsoleContext.tsx';
import { cancelRun, clearHistory, download, pushHistory, readHistory, readStored, runSql, writeStored, type HistoryEntry } from './dbApi.ts';
import { formatMs, toCsv, toJson, toTsv } from './format.ts';
import { parsePlan, PlanView } from './Plan.tsx';
import { ResultGrid, ValuePanel, type CellRef, type GridColumn } from './ResultGrid.tsx';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor.tsx';

type QueryState = Extract<ConsoleTab, { kind: 'query' }>;

const LIMITS = [100, 500, 1_000, 5_000, 10_000];
const SPLIT_KEY = 'ploy.db.split';

function wordEnd(text: string, at: number): number {
  const match = /^("[^"]*"|`[^`]*`|[\w$.]+)/.exec(text.slice(at));
  return at + Math.max(1, match?.[0].length ?? 1);
}

export function QueryTab({ tab, onChange, visible }: { tab: QueryState; onChange: (patch: Partial<QueryState>) => void; visible: boolean }) {
  const { m, plural, formatNumber, formatRelative } = useI18n();
  const toast = useToast();
  const { service, dialect, type, overview, completions } = useConsole();
  const editor = useRef<SqlEditorHandle>(null);
  const area = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState<DbRunResultDto | null>(null);
  const [base, setBase] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [view, setView] = useState<number | 'messages' | 'plan'>('messages');
  const [plan, setPlan] = useState<ReturnType<typeof parsePlan> | string | null>(null);
  const [transaction, setTransaction] = useState<'idle' | 'open' | 'failed'>('idle');
  const [split, setSplit] = useState(() => readStored<number>(SPLIT_KEY, 0.42));
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyFilter, setHistoryFilter] = useState('');
  const [cell, setCell] = useState<CellRef | null>(null);
  const [showValue, setShowValue] = useState(false);

  useEffect(() => {
    if (running === null) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);

  const databases = overview.databases.filter((db) => !db.system || db.name === tab.database);
  const error = result?.error ?? null;
  const errorRange = error !== null && error.position !== null ? { start: base + error.position, end: wordEnd(tab.sql, base + error.position) } : null;
  const resultTabs = (result?.results ?? []).map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.columns !== null);
  const current: DbStatementResultDto | null = typeof view === 'number' ? (result?.results[view] ?? null) : null;

  const pick = (sql: string, mode: 'statement' | 'all'): { text: string; start: number } | null => {
    const selection = editor.current?.selection() ?? { start: 0, end: 0, text: '' };
    if (selection.text.trim().length > 0) return { text: selection.text, start: selection.start };
    if (mode === 'all') return sql.trim().length === 0 ? null : { text: sql, start: 0 };
    const statement = statementAt(splitSql(sql, dialect), editor.current?.caret() ?? 0);
    return statement === null ? null : { text: statement.text, start: statement.start };
  };

  const execute = useCallback(
    async (sql: string, start: number, options: { explain?: 'plain' | 'analyze' } = {}) => {
      setRunning(Date.now());
      setFailure(null);
      setLost(false);
      try {
        const response = await runSql(service.id, { database: tab.database, session: tab.session, sql, limit: tab.limit, readOnly: tab.readOnly });
        if (response.newSession && transaction === 'open') setLost(true);
        setResult(response);
        setBase(start);
        setTransaction(response.transaction);
        setCell(null);
        if (response.database !== tab.database) onChange({ database: response.database });
        if (options.explain !== undefined && response.error === null) {
          const rows = response.results.at(-1)?.rows ?? [];
          const parsed = dialect === 'postgres' ? parsePlan(rows[0]?.[0]) : null;
          setPlan(parsed ?? rows.map((row) => row.filter((value) => value !== null).join('  ')).join('\n'));
          setView('plan');
        } else {
          const withRows = response.results.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.columns !== null);
          setView(response.error !== null || withRows.length === 0 ? 'messages' : withRows.at(-1)!.index);
          if (options.explain === undefined) setPlan(null);
        }
        if (options.explain === undefined) {
          pushHistory(service.id, {
            sql,
            database: tab.database,
            at: Date.now(),
            ok: response.error === null,
            ms: response.durationMs,
            rows: response.results.at(-1)?.rowCount ?? null,
          });
        }
      } catch (failed) {
        setFailure(errorText(m, failed));
        setResult(null);
        setView('messages');
      } finally {
        setRunning(null);
      }
    },
    [service.id, tab.database, tab.session, tab.limit, tab.readOnly, transaction, dialect, onChange, m],
  );

  const run = (mode: 'statement' | 'all') => {
    if (running !== null) return;
    const target = pick(tab.sql, mode);
    if (target === null) return;
    void execute(target.text, target.start);
  };

  const explain = (analyze: boolean) => {
    if (running !== null) return;
    const target = pick(tab.sql, 'statement');
    if (target === null) return;
    const statement = target.text.trim().replace(/;\s*$/, '');
    let sql: string;
    if (dialect === 'postgres') sql = `EXPLAIN (FORMAT JSON${analyze ? ', ANALYZE, BUFFERS' : ''}) ${statement}`;
    else if (type === 'mariadb') sql = analyze ? `ANALYZE FORMAT=JSON ${statement}` : `EXPLAIN FORMAT=JSON ${statement}`;
    else sql = analyze ? `EXPLAIN ANALYZE ${statement}` : `EXPLAIN FORMAT=TREE ${statement}`;
    void execute(sql, target.start - (sql.length - statement.length), { explain: analyze ? 'analyze' : 'plain' });
  };

  const stop = async () => {
    try {
      await cancelRun(service.id, tab.session);
    } catch (failed) {
      toast.error(failed);
    }
  };

  const finish = (word: 'COMMIT' | 'ROLLBACK') => void execute(word, 0);

  const dragSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = area.current;
    if (element === null) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const onMove = (move: PointerEvent) => setSplit(Math.min(0.85, Math.max(0.12, (move.clientY - rect.top) / rect.height)));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setSplit((value) => {
        writeStored(SPLIT_KEY, value);
        return value;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const columns: GridColumn[] = current?.columns ?? [];
  const clipped = useMemo(() => new Set((current?.clipped ?? []).map(([row, column]) => `${row}:${column}`)), [current]);
  const exportResult = (format: 'csv' | 'json' | 'tsv') => {
    if (current?.columns === null || current === null) return;
    const name = `result-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    if (format === 'csv') download(`${name}.csv`, toCsv(current.columns!, current.rows), 'text/csv');
    else if (format === 'json') download(`${name}.json`, toJson(current.columns!, current.rows), 'application/json');
    else void navigator.clipboard.writeText(toTsv(current.columns!, current.rows)).then(() => toast.success(m.common.copied));
  };

  const shownHistory = (history ?? []).filter((entry) => historyFilter.length === 0 || entry.sql.toLowerCase().includes(historyFilter.toLowerCase()));
  const activeValue: DbCell | undefined = cell === null ? undefined : current?.rows[cell.row]?.[cell.column];

  return (
    <div className="qtab" hidden={!visible}>
      <div className="qtab__bar">
        <div className="qtab__run">
          <Button variant="primary" size="sm" icon={<Play />} onClick={() => run('statement')} disabled={running !== null} title={m.db.query.runHint}>
            {m.db.query.run}
          </Button>
          <Button size="sm" icon={<PlayCircle />} onClick={() => run('all')} disabled={running !== null} title={m.db.query.runAllHint}>
            {m.db.query.runAll}
          </Button>
          <Menu
            align="start"
            trigger={(props) => (
              <Button {...props} size="sm" icon={<ListTree />} disabled={running !== null}>
                {m.db.query.explain}
                <ChevronDown className="btn__chevron" aria-hidden="true" />
              </Button>
            )}
          >
            <MenuItem icon={<ListTree />} onSelect={() => explain(false)}>
              {m.db.query.explainPlan}
            </MenuItem>
            <MenuItem icon={<Clock />} onSelect={() => explain(true)}>
              {m.db.query.explainAnalyze}
            </MenuItem>
          </Menu>
          {running !== null && (
            <Button size="sm" variant="danger" icon={<Square />} onClick={() => void stop()}>
              {m.db.query.stop}
            </Button>
          )}
        </div>
        <div className="qtab__opts">
          <label className="qtab__opt">
            <span className="sr-only">{m.db.query.database}</span>
            <Select value={tab.database} onChange={(event) => onChange({ database: event.target.value })} aria-label={m.db.query.database}>
              {databases.map((db) => (
                <option key={db.name} value={db.name}>
                  {db.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="qtab__opt">
            <span className="qtab__opt-label">{m.db.query.limit}</span>
            <Select value={String(tab.limit)} onChange={(event) => onChange({ limit: Number(event.target.value) })} aria-label={m.db.query.limit}>
              {LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  {formatNumber(limit)}
                </option>
              ))}
            </Select>
          </label>
          <Switch checked={tab.readOnly} onChange={(readOnly) => onChange({ readOnly })} label={m.db.query.readOnly} />
          <Button
            size="sm"
            variant="ghost"
            icon={<History />}
            aria-pressed={history !== null}
            onClick={() => setHistory(history === null ? readHistory(service.id) : null)}
          >
            {m.db.query.history}
          </Button>
          <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<ChevronDown />}>{m.common.more}</Button>}>
            <MenuItem icon={<FileUp />} onSelect={() => file.current?.click()}>
              {m.db.query.openFile}
            </MenuItem>
            <MenuItem icon={<Download />} onSelect={() => download(`${(tab.title || 'query').replace(/[^\w.-]+/g, '_')}.sql`, tab.sql, 'application/sql')}>
              {m.db.query.saveFile}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} onSelect={() => onChange({ sql: '' })}>
              {m.db.query.clear}
            </MenuItem>
          </Menu>
          <input
            ref={file}
            type="file"
            accept=".sql,.txt,text/plain"
            hidden
            onChange={async (event) => {
              const chosen = event.target.files?.[0];
              event.target.value = '';
              if (chosen === undefined) return;
              if (chosen.size > 2_000_000) return toast.failure(m.db.query.fileTooLarge);
              onChange({ sql: await chosen.text(), title: chosen.name.replace(/\.sql$/i, '') });
            }}
          />
        </div>
      </div>
      {(transaction !== 'idle' || lost || tab.readOnly) && (
        <div className="qtab__tx" data-state={lost ? 'lost' : transaction === 'idle' ? 'readonly' : transaction}>
          {lost ? (
            <>
              <TriangleAlert aria-hidden="true" />
              <span>{m.db.query.transactionLost}</span>
            </>
          ) : transaction === 'idle' ? (
            <>
              <Lock aria-hidden="true" />
              <span>{m.db.query.readOnlyOn}</span>
            </>
          ) : (
            <>
              <span className="qtab__tx-dot" />
              <span>{transaction === 'failed' ? m.db.query.transactionFailed : m.db.query.transactionOpen}</span>
              <span className="grow" />
              {transaction === 'open' && (
                <Button size="sm" variant="primary" icon={<CircleCheck />} onClick={() => finish('COMMIT')} disabled={running !== null}>
                  Commit
                </Button>
              )}
              <Button size="sm" icon={<Undo2 />} onClick={() => finish('ROLLBACK')} disabled={running !== null}>
                Rollback
              </Button>
            </>
          )}
        </div>
      )}
      <div className="qtab__area" ref={area} style={{ '--split': split } as React.CSSProperties}>
        <div className="qtab__editor">
          <SqlEditor
            ref={editor}
            value={tab.sql}
            onChange={(sql) => onChange({ sql })}
            dialect={dialect}
            label={m.db.query.editor}
            completions={completions}
            onRun={run}
            error={errorRange}
            fill
            placeholder={m.db.query.placeholder}
            foot={
              <>
                <span className="code__keys">
                  <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> {m.db.query.keyStatement}
                </span>
                <span className="code__keys">
                  <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> {m.db.query.keyAll}
                </span>
                <span className="code__keys">
                  <Kbd>Ctrl</Kbd>+<Kbd>Space</Kbd> {m.db.query.keyComplete}
                </span>
              </>
            }
          />
          {history !== null && (
            <aside className="qhistory" aria-label={m.db.query.history}>
              <header className="qhistory__head">
                <Search aria-hidden="true" />
                <Input value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)} placeholder={m.db.query.historySearch} aria-label={m.db.query.historySearch} />
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Trash2 />}
                  onClick={() => {
                    clearHistory(service.id);
                    setHistory([]);
                  }}
                >
                  {m.db.query.historyClear}
                </Button>
              </header>
              <ul className="qhistory__list">
                {shownHistory.length === 0 && <li className="qhistory__empty">{m.db.query.historyEmpty}</li>}
                {shownHistory.map((entry) => (
                  <li key={`${entry.at}`}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange({ sql: entry.sql, database: entry.database });
                        setHistory(null);
                      }}
                    >
                      <code>{entry.sql.slice(0, 300)}</code>
                      <span className="qhistory__meta">
                        {entry.ok ? <CircleCheck data-tone="ok" aria-hidden="true" /> : <CircleAlert data-tone="bad" aria-hidden="true" />}
                        {entry.database} · {formatMs(entry.ms)} · {formatRelative(entry.at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
        <div className="qtab__handle" role="separator" aria-orientation="horizontal" aria-label={m.db.query.resize} onPointerDown={dragSplit} />
        <div className="qtab__results">
          <div className="rtabs" role="tablist">
            {resultTabs.map(({ entry, index }) => (
              <button key={index} type="button" role="tab" aria-selected={view === index} onClick={() => setView(index)}>
                {resultTabs.length > 1 ? `${m.db.query.result} ${index + 1}` : m.db.query.result}
                <span className="rtabs__count">{formatNumber(entry.rows.length)}</span>
              </button>
            ))}
            {plan !== null && (
              <button type="button" role="tab" aria-selected={view === 'plan'} onClick={() => setView('plan')}>
                <ListTree aria-hidden="true" />
                {m.db.query.plan}
              </button>
            )}
            <button type="button" role="tab" aria-selected={view === 'messages'} onClick={() => setView('messages')} data-bad={error !== null || failure !== null || undefined}>
              {error !== null || failure !== null ? <CircleAlert aria-hidden="true" /> : null}
              {m.db.query.messages}
            </button>
            <span className="grow" />
            {current !== null && current.columns !== null && (
              <span className="rtabs__tools">
                <span className="rtabs__meta">
                  {plural(m.db.query.rowsCount, current.rows.length)}
                  {current.truncated && (
                    <Badge tone="work">{m.db.query.truncated}</Badge>
                  )}
                  · {formatMs(current.durationMs)}
                </span>
                <Button size="sm" variant="ghost" aria-pressed={showValue} onClick={() => setShowValue(!showValue)}>
                  {m.db.grid.value}
                </Button>
                <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" icon={<Download />}>{m.db.query.export}</Button>}>
                  <MenuItem onSelect={() => exportResult('csv')}>CSV</MenuItem>
                  <MenuItem onSelect={() => exportResult('json')}>JSON</MenuItem>
                  <MenuItem onSelect={() => exportResult('tsv')}>{m.db.query.copyTsv}</MenuItem>
                </Menu>
              </span>
            )}
          </div>
          <div className="qtab__pane">
            {running !== null && (
              <div className="qtab__running">
                <span className="spinner" aria-hidden="true" />
                <span>
                  {m.db.query.running} {formatMs(now - running)}
                </span>
                <Button size="sm" variant="danger" icon={<Square />} onClick={() => void stop()}>
                  {m.db.query.stop}
                </Button>
              </div>
            )}
            {view === 'plan' && plan !== null ? (
              typeof plan === 'string' ? (
                <pre className="qtab__plaintext">{plan}</pre>
              ) : (
                <PlanView plan={plan} />
              )
            ) : current !== null && current.columns !== null ? (
              <div className="qtab__grid">
                <ResultGrid
                  columns={columns}
                  rows={current.rows}
                  clipped={clipped}
                  label={m.db.query.result}
                  onActiveCell={setCell}
                  empty={<span>{m.db.query.noRows}</span>}
                />
                {showValue && cell !== null && activeValue !== undefined && columns[cell.column] !== undefined && (
                  <ValuePanel column={columns[cell.column]!} value={activeValue} onClose={() => setShowValue(false)} />
                )}
              </div>
            ) : (
              <Messages result={result} failure={failure} base={base} onJump={(offset) => editor.current?.reveal(offset)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Messages({ result, failure, base, onJump }: { result: DbRunResultDto | null; failure: string | null; base: number; onJump: (offset: number) => void }) {
  const { m, plural } = useI18n();
  if (failure !== null) {
    return (
      <div className="qmsg">
        <Callout tone="bad" title={m.db.query.couldNotRun}>
          {failure}
        </Callout>
      </div>
    );
  }
  if (result === null) {
    return (
      <div className="qmsg qmsg--empty">
        <Play aria-hidden="true" />
        <p>{m.db.query.nothingYet}</p>
      </div>
    );
  }
  const error = result.error;
  return (
    <div className="qmsg">
      <ol className="qmsg__list">
        {result.results.map((entry, index) => (
          <li key={index} className="qmsg__item" data-tone="ok">
            <CircleCheck aria-hidden="true" />
            <button type="button" className="qmsg__cmd" onClick={() => onJump(base + entry.start)}>
              {entry.command || '—'}
            </button>
            <span className="qmsg__detail">
              {entry.columns !== null ? plural(m.db.query.rowsCount, entry.rows.length) : entry.rowCount !== null ? plural(m.db.query.affected, entry.rowCount) : m.db.query.done}
              {entry.insertId !== null && ` · id ${entry.insertId}`}
            </span>
            <span className="qmsg__time">{formatMs(entry.durationMs)}</span>
            {entry.notices.map((notice, at) => (
              <div key={at} className="qmsg__notice">
                <span className="qmsg__sev">{notice.severity}</span> {notice.message}
              </div>
            ))}
          </li>
        ))}
        {error !== null && (
          <li className="qmsg__item" data-tone="bad">
            <Ban aria-hidden="true" />
            <span className="qmsg__cmd">
              {m.db.query.failedAt} {error.statement + 1}
            </span>
            <span className="qmsg__detail">{error.code === null ? '' : error.code}</span>
            <span />
            <div className="qmsg__error">{error.message}</div>
            {error.detail !== null && <div className="qmsg__notice">{error.detail}</div>}
            {error.hint !== null && (
              <div className="qmsg__notice">
                <span className="qmsg__sev">HINT</span> {error.hint}
              </div>
            )}
            {error.notices.map((notice, at) => (
              <div key={at} className="qmsg__notice">
                <span className="qmsg__sev">{notice.severity}</span> {notice.message}
              </div>
            ))}
            {error.position !== null && (
              <button type="button" className="qmsg__jump" onClick={() => onJump(base + error.position!)}>
                {m.db.query.showError}
              </button>
            )}
          </li>
        )}
      </ol>
      <p className="qmsg__total">
        {result.cancelled ? m.db.query.cancelled : m.db.query.finished} · {formatMs(result.durationMs)}
      </p>
    </div>
  );
}
