/**
 * A table's rows: filtered, sorted and paged on the server, edited here.
 *
 * Edits collect as pending changes (changed cells tinted, new rows on top,
 * deleted rows struck through) until Save sends them as one transaction,
 * each row addressed by its key; if any of them fails, none is applied.
 * Rows can also arrive from a CSV file, shown as new rows to look over
 * before saving.
 */
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileUp, Filter, Plus, RefreshCw, Save, Trash2, Undo2, X } from 'lucide-react';
import { DB_FILTER_OPERATORS, type DbCell, type DbChange, type DbFilter, type DbFilterOperator, type DbSort, type DbTableDto } from '@ploy/shared';
import { Dialog, useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Callout, Field, Input, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { errorText } from '../../lib/errors.ts';
import { useConsole } from './ConsoleContext.tsx';
import { applyChanges, exportUrl, useDbRows } from './dbApi.ts';
import { formatMs } from './format.ts';
import { ResultGrid, ValuePanel, type CellRef, type GridColumn } from './ResultGrid.tsx';

const PAGE_SIZES = [50, 100, 250, 500, 1_000];
const NO_VALUE: ReadonlySet<DbFilterOperator> = new Set(['null', 'not_null', 'empty']);

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',' || char === ';' || char === '\t') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.length > 0));
}

interface Pending {
  edits: Map<number, Map<number, DbCell>>;
  inserted: Map<number, DbCell>[];
  deleted: Set<number>;
}

const emptyPending = (): Pending => ({ edits: new Map(), inserted: [], deleted: new Set() });

export function TableData({ table }: { table: DbTableDto }) {
  const { m, plural, formatNumber, t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { service, dialect, refresh } = useConsole();
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(100);
  const [sort, setSort] = useState<DbSort[]>([]);
  const [filters, setFilters] = useState<DbFilter[]>([]);
  const [where, setWhere] = useState('');
  const [whereDraft, setWhereDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending>(emptyPending);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [cell, setCell] = useState<CellRef | null>(null);
  const [showValue, setShowValue] = useState(false);
  const [csv, setCsv] = useState<{ name: string; rows: string[][] } | null>(null);

  const input = { database: table.database, schema: table.schema, table: table.name, offset, limit, sort, filters, where };
  const rows = useDbRows(service.id, input);
  const page = rows.data;
  const editable = table.kind === 'table' || table.kind === 'partitioned_table';
  const keyed = table.keyColumns.length > 0;

  const columns: GridColumn[] = useMemo(
    () =>
      table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        kind: column.kind,
        key: column.primaryKey,
        references: column.references === null ? null : `${column.references.table}.${column.references.column}`,
        nullable: column.nullable,
        options: column.options,
        readOnly: column.generated,
      })),
    [table],
  );

  const base = page?.rows ?? [];
  const inserted = pending.inserted.length;
  const shown = useMemo(() => {
    const fresh = pending.inserted.map((values) => columns.map((_, index) => values.get(index) ?? null));
    const current = base.map((row, index) => {
      const edits = pending.edits.get(index);
      return edits === undefined ? row : row.map((value, column) => (edits.has(column) ? edits.get(column)! : value));
    });
    return [...fresh, ...current];
  }, [base, pending, columns]);
  const clipped = useMemo(() => new Set((page?.clipped ?? []).map(([row, column]) => `${row + inserted}:${column}`)), [page, inserted]);
  const changeCount = pending.inserted.length + pending.deleted.size + [...pending.edits.values()].filter((edits) => edits.size > 0).length;

  const guard = async (): Promise<boolean> => {
    if (changeCount === 0) return true;
    const result = await confirm({ title: m.db.data.discardTitle, text: m.db.data.discardText, confirmLabel: m.db.data.discard, danger: true });
    if (result.confirmed) setPending(emptyPending());
    return result.confirmed;
  };

  const onEdit = (row: number, column: number, value: DbCell | undefined) => {
    setPending((current) => {
      const next: Pending = { edits: new Map(current.edits), inserted: [...current.inserted], deleted: new Set(current.deleted) };
      if (row < current.inserted.length) {
        const values = new Map(next.inserted[row]);
        if (value === undefined) values.delete(column);
        else values.set(column, value);
        next.inserted[row] = values;
        return next;
      }
      if (value === undefined) return current;
      const index = row - current.inserted.length;
      if (!keyed) {
        toast.failure(m.db.data.noKey);
        return current;
      }
      const original = base[index]?.[column] ?? null;
      const edits = new Map(next.edits.get(index));
      if (value === original) edits.delete(column);
      else edits.set(column, value);
      next.edits.set(index, edits);
      return next;
    });
  };

  const addRow = () => setPending((current) => ({ ...current, inserted: [new Map(), ...current.inserted] }));

  const removeSelected = () => {
    if (selected.size === 0) return;
    setPending((current) => {
      const keptInserted = current.inserted.filter((_, index) => !selected.has(index));
      const deleted = new Set(current.deleted);
      for (const row of selected) {
        if (row < current.inserted.length) continue;
        if (keyed) deleted.add(row - current.inserted.length);
      }
      // Rows shift up by the removed inserts, so selection is cleared rather than remapped.
      return { edits: current.edits, inserted: keptInserted, deleted };
    });
    setSelected(new Set());
  };

  const keyOf = (index: number): Record<string, DbCell> => {
    const row = base[index] ?? [];
    return Object.fromEntries(table.keyColumns.map((name) => [name, row[table.columns.findIndex((column) => column.name === name)] ?? null]));
  };

  const save = async () => {
    const changes: DbChange[] = [];
    for (const values of [...pending.inserted].reverse()) changes.push({ kind: 'insert', values: Object.fromEntries([...values].map(([column, value]) => [columns[column]!.name, value])) });
    for (const [index, edits] of pending.edits) {
      if (edits.size === 0 || pending.deleted.has(index)) continue;
      changes.push({ kind: 'update', key: keyOf(index), values: Object.fromEntries([...edits].map(([column, value]) => [columns[column]!.name, value])) });
    }
    for (const index of pending.deleted) changes.push({ kind: 'delete', key: keyOf(index) });
    if (changes.length === 0) return;
    setSaving(true);
    try {
      const result = await applyChanges(service.id, { database: table.database, schema: table.schema, table: table.name, changes });
      toast.success(m.db.data.saved, t(m.db.data.savedDetail, { inserted: result.inserted, updated: result.updated, deleted: result.deleted }));
      setPending(emptyPending());
      setSelected(new Set());
      await rows.refetch();
      refresh();
    } catch (error) {
      toast.failure(m.db.data.saveFailed, errorText(m, error));
    } finally {
      setSaving(false);
    }
  };

  const toggleSort = async (column: string, additive: boolean) => {
    if (!(await guard())) return;
    setSort((current) => {
      const existing = current.find((entry) => entry.column === column);
      const rest = additive ? current.filter((entry) => entry.column !== column) : [];
      if (existing === undefined) return [...rest, { column, direction: 'asc' }];
      if (existing.direction === 'asc') return additive ? current.map((entry) => (entry.column === column ? { column, direction: 'desc' } : entry)) : [{ column, direction: 'desc' }];
      return rest;
    });
    setOffset(0);
  };

  const go = async (next: number) => {
    if (!(await guard())) return;
    setOffset(Math.max(0, next));
    setSelected(new Set());
  };

  const importCsv = (rowsIn: string[][], header: boolean) => {
    const names = header ? (rowsIn[0] ?? []).map((name) => name.trim()) : columns.map((column) => column.name);
    const mapping = names.map((name) => columns.findIndex((column) => column.name === name));
    const body = (header ? rowsIn.slice(1) : rowsIn).slice(0, 5_000);
    const added = body.map((values) => {
      const map = new Map<number, DbCell>();
      values.forEach((value, index) => {
        const column = mapping[index];
        if (column !== undefined && column !== -1) map.set(column, value === '' && columns[column]!.nullable !== false ? null : value);
      });
      return map;
    });
    setPending((current) => ({ ...current, inserted: [...added, ...current.inserted] }));
    setCsv(null);
    toast.info(t(m.db.data.imported, { count: added.length }));
  };

  const total = page?.total ?? null;
  const estimate = page?.estimate ?? null;
  const from = base.length === 0 ? 0 : offset + 1;
  const to = offset + base.length;
  const activeColumn = cell === null ? undefined : columns[cell.column];
  const activeValue = cell === null ? undefined : shown[cell.row]?.[cell.column];
  const exportHref = (format: 'csv' | 'json' | 'sql') => exportUrl(service.id, { database: table.database, schema: table.schema, table: table.name, format, filters, sort, where });

  return (
    <div className="tdata">
      <div className="tdata__bar">
        <Button size="sm" variant="ghost" iconOnly icon={<RefreshCw />} onClick={() => void rows.refetch()} busy={rows.isFetching}>
          {m.common.refresh}
        </Button>
        <Button size="sm" icon={<Filter />} onClick={() => setAdding(true)}>
          {m.db.data.filter}
        </Button>
        {editable && (
          <>
            <Button size="sm" icon={<Plus />} onClick={addRow}>
              {m.db.data.addRow}
            </Button>
            <Button size="sm" icon={<Trash2 />} onClick={removeSelected} disabled={selected.size === 0}>
              {selected.size > 0 ? t(m.db.data.deleteCount, { count: selected.size }) : m.db.data.delete}
            </Button>
          </>
        )}
        <span className="grow" />
        {changeCount > 0 && (
          <span className="tdata__pending">
            <Badge tone="work">{plural(m.db.data.pending, changeCount)}</Badge>
            <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => setPending(emptyPending())}>
              {m.db.data.discard}
            </Button>
            <Button size="sm" variant="primary" icon={<Save />} onClick={() => void save()} busy={saving}>
              {m.common.save}
            </Button>
          </span>
        )}
        <Button size="sm" variant="ghost" aria-pressed={showValue} onClick={() => setShowValue(!showValue)}>
          {m.db.grid.value}
        </Button>
        <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" icon={<Download />}>{m.db.query.export}</Button>}>
          <MenuItem href={exportHref('csv')}>CSV</MenuItem>
          <MenuItem href={exportHref('json')}>JSON</MenuItem>
          <MenuItem href={exportHref('sql')}>SQL (INSERT)</MenuItem>
          {editable && (
            <MenuItem
              icon={<FileUp />}
              onSelect={() => {
                const picker = document.createElement('input');
                picker.type = 'file';
                picker.accept = '.csv,text/csv,text/plain';
                picker.onchange = async () => {
                  const chosen = picker.files?.[0];
                  if (chosen === undefined) return;
                  if (chosen.size > 20_000_000) return toast.failure(m.db.query.fileTooLarge);
                  setCsv({ name: chosen.name, rows: parseCsv(await chosen.text()) });
                };
                picker.click();
              }}
            >
              {m.db.data.importCsv}
            </MenuItem>
          )}
        </Menu>
      </div>
      {(filters.length > 0 || where.length > 0) && (
        <div className="tdata__filters">
          {filters.map((filter, index) => (
            <span key={index} className="chip">
              <code>{filter.column}</code> {m.db.data.ops[filter.op]} {!NO_VALUE.has(filter.op) && <code>{filter.value}</code>}
              <button
                type="button"
                aria-label={m.common.remove}
                onClick={async () => {
                  if (!(await guard())) return;
                  setFilters(filters.filter((_, at) => at !== index));
                  setOffset(0);
                }}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
          {where.length > 0 && (
            <span className="chip">
              WHERE <code>{where}</code>
              <button
                type="button"
                aria-label={m.common.remove}
                onClick={() => {
                  setWhere('');
                  setWhereDraft('');
                }}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
      )}
      {editable && !keyed && (
        <div className="tdata__note">
          <Callout tone="work">{m.db.data.noKey}</Callout>
        </div>
      )}
      {rows.error !== null && rows.error !== undefined && (
        <div className="tdata__note">
          <Callout tone="bad" title={m.db.data.loadFailed}>
            {errorText(m, rows.error)}
          </Callout>
        </div>
      )}
      <div className="tdata__grid">
        <ResultGrid
          columns={columns}
          rows={shown}
          label={table.name}
          clipped={clipped}
          offset={offset - inserted}
          editable={editable}
          onEdit={onEdit}
          rowState={(row) => (row < inserted ? 'inserted' : pending.deleted.has(row - inserted) ? 'deleted' : undefined)}
          cellChanged={(row, column) => (row < inserted ? pending.inserted[row]!.has(column) : (pending.edits.get(row - inserted)?.has(column) ?? false))}
          cellUnset={(row, column) => row < inserted && !pending.inserted[row]!.has(column)}
          selected={editable ? selected : undefined}
          onSelect={editable ? setSelected : undefined}
          sort={sort}
          onSort={(column, additive) => void toggleSort(column, additive)}
          onActiveCell={setCell}
          empty={rows.isLoading ? <span className="spinner" /> : <span>{filters.length > 0 || where.length > 0 ? m.db.data.noMatch : m.db.data.empty}</span>}
        />
        {showValue && activeColumn !== undefined && activeValue !== undefined && <ValuePanel column={activeColumn} value={activeValue} onClose={() => setShowValue(false)} />}
      </div>
      <div className="tdata__foot">
        <form
          className="tdata__where"
          onSubmit={(event) => {
            event.preventDefault();
            void guard().then((ok) => {
              if (!ok) return;
              setWhere(whereDraft.trim());
              setOffset(0);
            });
          }}
        >
          <span className="tdata__where-label">WHERE</span>
          <Input mono value={whereDraft} onChange={(event) => setWhereDraft(event.target.value)} placeholder={dialect === 'postgres' ? "created_at > now() - interval '1 day'" : 'created_at > NOW() - INTERVAL 1 DAY'} aria-label={m.db.data.where} />
        </form>
        <span className="tdata__count">
          {formatNumber(from)}–{formatNumber(to)} / {total !== null ? formatNumber(total) : estimate !== null ? `≈${formatNumber(estimate)}` : '?'}
          {page !== undefined && <span className="tdata__ms"> · {formatMs(page.durationMs)}</span>}
        </span>
        <Select value={String(limit)} onChange={(event) => void guard().then((ok) => ok && (setLimit(Number(event.target.value)), setOffset(0)))} aria-label={m.db.data.pageSize}>
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {t(m.db.data.perPage, { count: size })}
            </option>
          ))}
        </Select>
        <Button size="sm" iconOnly icon={<ChevronLeft />} disabled={offset === 0} onClick={() => void go(offset - limit)}>
          {m.db.data.previous}
        </Button>
        <Button size="sm" iconOnly icon={<ChevronRight />} disabled={base.length < limit || (total !== null && to >= total)} onClick={() => void go(offset + limit)}>
          {m.db.data.next}
        </Button>
      </div>
      {adding && (
        <FilterDialog
          table={table}
          onClose={() => setAdding(false)}
          onAdd={async (filter) => {
            if (!(await guard())) return;
            setFilters([...filters, filter]);
            setOffset(0);
            setAdding(false);
          }}
        />
      )}
      {csv !== null && <CsvDialog file={csv} table={table} onClose={() => setCsv(null)} onImport={importCsv} />}
    </div>
  );
}

function FilterDialog({ table, onClose, onAdd }: { table: DbTableDto; onClose: () => void; onAdd: (filter: DbFilter) => void }) {
  const { m } = useI18n();
  const [column, setColumn] = useState(table.columns[0]?.name ?? '');
  const [op, setOp] = useState<DbFilterOperator>('eq');
  const [value, setValue] = useState('');
  const kind = table.columns.find((entry) => entry.name === column);
  return (
    <Dialog
      open
      onClose={onClose}
      title={m.db.data.addFilter}
      onSubmit={() => onAdd({ column, op, value })}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" icon={<Filter />}>
            {m.db.data.apply}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label={m.db.data.column}>
          <Select value={column} onChange={(event) => setColumn(event.target.value)}>
            {table.columns.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} — {entry.type}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={m.db.data.operator}>
          <Select value={op} onChange={(event) => setOp(event.target.value as DbFilterOperator)}>
            {DB_FILTER_OPERATORS.map((entry) => (
              <option key={entry} value={entry}>
                {m.db.data.ops[entry]}
              </option>
            ))}
          </Select>
        </Field>
        {!NO_VALUE.has(op) &&
          (kind?.options !== null && kind?.options !== undefined && op === 'eq' ? (
            <Field label={m.db.data.value}>
              <Select value={value} onChange={(event) => setValue(event.target.value)} data-autofocus>
                <option value="">—</option>
                {kind.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={m.db.data.value} hint={op === 'in' ? m.db.data.inHint : undefined}>
              <Input mono value={value} onChange={(event) => setValue(event.target.value)} data-autofocus />
            </Field>
          ))}
      </div>
    </Dialog>
  );
}

function CsvDialog({ file, table, onClose, onImport }: { file: { name: string; rows: string[][] }; table: DbTableDto; onClose: () => void; onImport: (rows: string[][], header: boolean) => void }) {
  const { m, t, formatNumber } = useI18n();
  const first = file.rows[0] ?? [];
  const names = new Set(table.columns.map((column) => column.name));
  const looksLikeHeader = first.some((value) => names.has(value.trim()));
  const [header, setHeader] = useState(looksLikeHeader);
  const matched = header ? first.filter((value) => names.has(value.trim())) : table.columns.slice(0, first.length).map((column) => column.name);
  const count = file.rows.length - (header ? 1 : 0);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t(m.db.data.importTitle, { name: file.name })}
      onSubmit={() => onImport(file.rows, header)}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" icon={<FileUp />} disabled={count === 0 || matched.length === 0}>
            {t(m.db.data.importRows, { count: formatNumber(Math.min(count, 5_000)) })}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} />
          {m.db.data.firstRowHeader}
        </label>
        <p className="muted">{t(m.db.data.importMatched, { columns: matched.join(', ') || '—' })}</p>
        {count > 5_000 && <Callout tone="work">{m.db.data.importLimit}</Callout>}
        <div className="csvpreview">
          <table>
            <tbody>
              {file.rows.slice(0, 6).map((row, index) => (
                <tr key={index} data-header={header && index === 0 ? true : undefined}>
                  {row.slice(0, 12).map((value, at) => (
                    <td key={at}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">{m.db.data.importReview}</p>
      </div>
    </Dialog>
  );
}
