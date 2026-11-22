/**
 * The grid every result and every table is shown in.
 *
 * Rows are virtualised (ten thousand rows scroll as smoothly as ten), the
 * header and the row numbers stay put, columns can be widened by dragging,
 * the keyboard moves between cells (arrows, Home/End, Enter to edit, Ctrl+C
 * to copy) and, when the caller allows it, cells are edited in place: a line
 * input, a list for ENUM and boolean columns, a larger box for JSON and long
 * text, with NULL (and DEFAULT for new rows) one click away.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Copy, KeyRound, Link2 } from 'lucide-react';
import type { DbCell, DbColumnMetaDto, DbSort } from '@ploy/shared';
import { useToast } from '../../components/Toast.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { booleanOf, cellPreview, initialWidth, isRightAligned, KIND_GLYPH, prettyValue, toTsv } from './format.ts';

export interface GridColumn extends DbColumnMetaDto {
  key?: boolean;
  references?: string | null;
  nullable?: boolean;
  options?: string[] | null;
  readOnly?: boolean;
}

export interface CellRef {
  row: number;
  column: number;
}

interface ResultGridProps {
  columns: GridColumn[];
  rows: DbCell[][];
  label: string;
  clipped?: ReadonlySet<string>;
  /** Number shown for the first row minus one (a page offset). */
  offset?: number;
  editable?: boolean;
  onEdit?: (row: number, column: number, value: DbCell | undefined) => void;
  rowState?: (row: number) => 'inserted' | 'deleted' | undefined;
  cellChanged?: (row: number, column: number) => boolean;
  /** A new row's cell that was never set: the database fills in its default. */
  cellUnset?: (row: number, column: number) => boolean;
  selected?: ReadonlySet<number>;
  onSelect?: (rows: Set<number>) => void;
  sort?: DbSort[];
  onSort?: (column: string, additive: boolean) => void;
  onActiveCell?: (cell: CellRef | null) => void;
  empty?: ReactNode;
}

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 42;
const NUMBER_WIDTH = 56;
const CHECK_WIDTH = 34;

interface Editing extends CellRef {
  draft: string;
  large: boolean;
}

function CellValue({ value, column, unset }: { value: DbCell; column: GridColumn; unset: boolean }) {
  if (unset) return <span className="grid__default">DEFAULT</span>;
  if (value === null) return <span className="grid__null">NULL</span>;
  if (column.kind === 'boolean') {
    const on = booleanOf(value);
    if (on !== null) return <span className="grid__bool" data-on={on}>{on ? 'true' : 'false'}</span>;
  }
  const text = cellPreview(value);
  if (column.kind === 'json' || column.kind === 'array') return <span className="grid__json">{text}</span>;
  if (column.kind === 'binary') return <span className="grid__bin">{text}</span>;
  if (column.kind === 'uuid') return <span className="grid__uuid">{text}</span>;
  return <>{text}</>;
}

export function ResultGrid({
  columns,
  rows,
  label,
  clipped,
  offset = 0,
  editable = false,
  onEdit,
  rowState,
  cellChanged,
  cellUnset,
  selected,
  onSelect,
  sort,
  onSort,
  onActiveCell,
  empty,
}: ResultGridProps) {
  const { m } = useI18n();
  const toast = useToast();
  const scroll = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const signature = columns.map((column) => `${column.name}:${column.type}`).join('|');
  const [widths, setWidths] = useState<number[]>(() => columns.map((column, index) => initialWidth(column, rows, index)));
  const [widthsFor, setWidthsFor] = useState(signature);
  const [active, setActive] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const anchor = useRef<number | null>(null);

  const [sized, setSized] = useState(rows.length > 0);
  if (widthsFor !== signature) {
    setWidthsFor(signature);
    setWidths(columns.map((column, index) => initialWidth(column, rows, index)));
    setSized(rows.length > 0);
    setActive(null);
    setEditing(null);
  } else if (!sized && rows.length > 0) {
    // The first rows arrived after the columns: size the columns to them once.
    setSized(true);
    setWidths(columns.map((column, index) => initialWidth(column, rows, index)));
  }

  const lead = NUMBER_WIDTH + (onSelect === undefined ? 0 : CHECK_WIDTH);
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = lead;
    for (const width of widths) {
      out.push(x);
      x += width;
    }
    return out;
  }, [widths, lead]);
  const total = lead + widths.reduce((sum, width) => sum + width, 0);

  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => ROW_HEIGHT, overscan: 14 });

  useEffect(() => onActiveCell?.(active), [active, onActiveCell]);
  useEffect(() => {
    if (active !== null && active.row >= rows.length) setActive(rows.length === 0 ? null : { row: rows.length - 1, column: active.column });
  }, [rows.length, active]);

  const reveal = (cell: CellRef) => {
    virtual.scrollToIndex(cell.row, { align: 'auto' });
    const element = scroll.current;
    if (element === null) return;
    const left = lefts[cell.column] ?? 0;
    const right = left + (widths[cell.column] ?? 0);
    if (left - lead < element.scrollLeft) element.scrollLeft = left - lead;
    else if (right > element.scrollLeft + element.clientWidth) element.scrollLeft = right - element.clientWidth;
  };

  const canEdit = (cell: CellRef) => editable && onEdit !== undefined && columns[cell.column]?.readOnly !== true && rowState?.(cell.row) !== 'deleted';

  const startEdit = (cell: CellRef, initial?: string) => {
    if (!canEdit(cell)) return;
    const column = columns[cell.column]!;
    const current = rows[cell.row]?.[cell.column] ?? null;
    const draft = initial ?? (cellUnset?.(cell.row, cell.column) ? '' : (current ?? ''));
    const large = column.kind === 'json' || column.kind === 'array' || draft.includes('\n') || draft.length > 80;
    setEditing({ ...cell, draft: large && initial === undefined ? prettyValue(current, column.kind) : draft, large });
  };

  const commit = (value: DbCell | undefined, move?: 'down' | 'right') => {
    if (editing === null) return;
    const column = columns[editing.column]!;
    let next = value;
    // Pretty-printed JSON goes back compact if it is still valid.
    if (typeof next === 'string' && column.kind === 'json') {
      try {
        next = JSON.stringify(JSON.parse(next));
      } catch {
        // Leave it: the database will say what is wrong.
      }
    }
    onEdit?.(editing.row, editing.column, next);
    const cell = { row: editing.row, column: editing.column };
    setEditing(null);
    root.current?.focus();
    if (move === 'down' && cell.row + 1 < rows.length) setActive({ row: cell.row + 1, column: cell.column });
    if (move === 'right' && cell.column + 1 < columns.length) setActive({ row: cell.row, column: cell.column + 1 });
  };

  const copy = async () => {
    let text: string;
    if (selected !== undefined && selected.size > 0) text = toTsv(columns, [...selected].sort((a, b) => a - b).map((index) => rows[index] ?? []), true);
    else if (active !== null) text = rows[active.row]?.[active.column] ?? '';
    else return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(m.common.copied);
    } catch {
      toast.failure(m.db.grid.copyFailed);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (editing !== null || event.target !== event.currentTarget) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key === 'c') {
      event.preventDefault();
      void copy();
      return;
    }
    if (rows.length === 0 || columns.length === 0) return;
    const cell = active ?? { row: 0, column: 0 };
    const move = (row: number, column: number) => {
      const next = { row: Math.max(0, Math.min(rows.length - 1, row)), column: Math.max(0, Math.min(columns.length - 1, column)) };
      event.preventDefault();
      setActive(next);
      reveal(next);
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(cell.row + 1, cell.column);
      case 'ArrowUp':
        return move(cell.row - 1, cell.column);
      case 'ArrowRight':
        return move(cell.row, cell.column + 1);
      case 'ArrowLeft':
        return move(cell.row, cell.column - 1);
      case 'PageDown':
        return move(cell.row + 15, cell.column);
      case 'PageUp':
        return move(cell.row - 15, cell.column);
      case 'Home':
        return move(mod ? 0 : cell.row, 0);
      case 'End':
        return move(mod ? rows.length - 1 : cell.row, columns.length - 1);
      case 'Enter':
      case 'F2':
        if (active !== null) {
          event.preventDefault();
          startEdit(active);
        }
        return;
      case 'Escape':
        setActive(null);
        return;
    }
    if (active !== null && event.key.length === 1 && !mod && !event.altKey && canEdit(active)) {
      const column = columns[active.column]!;
      if (column.kind !== 'boolean' && column.kind !== 'enum') {
        event.preventDefault();
        startEdit(active, event.key);
      }
    }
  };

  const resize = (index: number, startX: number) => {
    const startWidth = widths[index] ?? 120;
    const onMove = (event: PointerEvent) => {
      const width = Math.max(56, Math.min(900, startWidth + event.clientX - startX));
      setWidths((current) => current.map((value, at) => (at === index ? width : value)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleRow = (index: number, range: boolean) => {
    if (onSelect === undefined) return;
    const next = new Set(selected);
    if (range && anchor.current !== null) {
      const [from, to] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      for (let row = from; row <= to; row += 1) next.add(row);
    } else if (next.has(index)) next.delete(index);
    else next.add(index);
    anchor.current = index;
    onSelect(next);
  };

  const sortOf = (name: string): { direction: 'asc' | 'desc'; order: number } | null => {
    const at = sort?.findIndex((entry) => entry.column === name) ?? -1;
    return at === -1 ? null : { direction: sort![at]!.direction, order: at + 1 };
  };

  const allSelected = selected !== undefined && rows.length > 0 && selected.size === rows.length;

  return (
    <div
      ref={root}
      className="grid"
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div className="grid__scroll" ref={scroll}>
        <div className="grid__inner" style={{ width: total, height: HEADER_HEIGHT + virtual.getTotalSize() }}>
          <div className="grid__head" style={{ width: total }} role="row">
            <div className="grid__num grid__corner" style={{ width: NUMBER_WIDTH }} aria-hidden="true">
              #
            </div>
            {onSelect !== undefined && (
              <div className="grid__check grid__check--head" style={{ width: CHECK_WIDTH, left: NUMBER_WIDTH }}>
                <input type="checkbox" aria-label={m.db.grid.selectAll} checked={allSelected} onChange={() => onSelect(allSelected ? new Set() : new Set(rows.map((_, index) => index)))} />
              </div>
            )}
            {columns.map((column, index) => {
              const sorted = sortOf(column.name);
              return (
                <div key={`${column.name}-${index}`} className="grid__th" role="columnheader" style={{ width: widths[index] }} aria-sort={sorted === null ? undefined : sorted.direction === 'asc' ? 'ascending' : 'descending'}>
                  <button
                    type="button"
                    className="grid__th-button"
                    disabled={onSort === undefined}
                    title={onSort === undefined ? `${column.name} · ${column.type}` : `${column.name} · ${column.type} — ${m.db.grid.sortHint}`}
                    onClick={(event) => onSort?.(column.name, event.shiftKey)}
                  >
                    <span className="grid__th-name">
                      {column.key === true && <KeyRound className="grid__key" aria-label={m.db.structure.primaryKey} />}
                      {column.references !== null && column.references !== undefined && <Link2 className="grid__fk" aria-label={column.references} />}
                      <span className="truncate">{column.name}</span>
                      {sorted !== null && (
                        <span className="grid__sort">
                          {sorted.direction === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
                          {(sort?.length ?? 0) > 1 && sorted.order}
                        </span>
                      )}
                    </span>
                    <span className="grid__th-type">
                      <span className="grid__glyph" data-kind={column.kind}>
                        {KIND_GLYPH[column.kind]}
                      </span>
                      <span className="truncate">{column.type}</span>
                    </span>
                  </button>
                  <span className="grid__resize" role="separator" aria-orientation="vertical" onPointerDown={(event) => resize(index, event.clientX)} />
                </div>
              );
            })}
          </div>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index] ?? [];
            const state = rowState?.(item.index);
            const isSelected = selected?.has(item.index) ?? false;
            return (
              <div
                key={item.key}
                className="grid__row"
                role="row"
                data-state={state}
                data-selected={isSelected || undefined}
                data-odd={item.index % 2 === 1 || undefined}
                style={{ width: total, transform: `translateY(${HEADER_HEIGHT + item.start}px)` }}
              >
                <div className="grid__num" style={{ width: NUMBER_WIDTH }}>
                  {state === 'inserted' ? '+' : offset + item.index + 1}
                </div>
                {onSelect !== undefined && (
                  <div className="grid__check" style={{ width: CHECK_WIDTH, left: NUMBER_WIDTH }}>
                    <input
                      type="checkbox"
                      aria-label={`${m.db.grid.selectRow} ${offset + item.index + 1}`}
                      checked={isSelected}
                      onChange={() => undefined}
                      onClick={(event) => toggleRow(item.index, event.shiftKey)}
                    />
                  </div>
                )}
                {columns.map((column, index) => {
                  const value = row[index] ?? null;
                  const isActive = active?.row === item.index && active.column === index;
                  return (
                    <div
                      key={index}
                      role="gridcell"
                      className="grid__cell"
                      data-align={isRightAligned(column.kind) ? 'end' : undefined}
                      data-active={isActive || undefined}
                      data-changed={cellChanged?.(item.index, index) || undefined}
                      data-clipped={clipped?.has(`${item.index}:${index}`) || undefined}
                      style={{ width: widths[index] }}
                      onMouseDown={() => setActive({ row: item.index, column: index })}
                      onDoubleClick={() => startEdit({ row: item.index, column: index })}
                    >
                      <CellValue value={value} column={column} unset={cellUnset?.(item.index, index) ?? false} />
                    </div>
                  );
                })}
              </div>
            );
          })}
          {editing !== null && (
            <CellEditor
              key={`${editing.row}:${editing.column}`}
              editing={editing}
              column={columns[editing.column]!}
              inserted={rowState?.(editing.row) === 'inserted'}
              left={lefts[editing.column] ?? 0}
              top={HEADER_HEIGHT + editing.row * ROW_HEIGHT}
              width={widths[editing.column] ?? 120}
              onCommit={commit}
              onCancel={() => {
                setEditing(null);
                root.current?.focus();
              }}
            />
          )}
        </div>
        {rows.length === 0 && empty !== undefined && <div className="grid__empty">{empty}</div>}
      </div>
    </div>
  );
}

function CellEditor({
  editing,
  column,
  inserted,
  left,
  top,
  width,
  onCommit,
  onCancel,
}: {
  editing: Editing;
  column: GridColumn;
  inserted: boolean;
  left: number;
  top: number;
  width: number;
  onCommit: (value: DbCell | undefined, move?: 'down' | 'right') => void;
  onCancel: () => void;
}) {
  const { m } = useI18n();
  const [draft, setDraft] = useState(editing.draft);
  const field = useRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement>(null);
  useLayoutEffect(() => {
    field.current?.focus();
    if (field.current !== null && 'select' in field.current && typeof field.current.select === 'function' && editing.draft.length > 1) field.current.select();
  }, [editing.draft.length]);

  const keys = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter' && (!editing.large || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onCommit(draft, 'down');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      onCommit(draft, 'right');
    }
  };

  const choices = column.kind === 'boolean' ? ['true', 'false'] : (column.options ?? null);
  return (
    <div className="grid__editor" data-large={editing.large || undefined} style={{ left, top, minWidth: Math.max(width, editing.large ? 380 : 280) }} onMouseDown={(event) => event.stopPropagation()}>
      {choices !== null ? (
        <select ref={field} className="grid__editor-field" value={draft} onChange={(event) => onCommit(event.target.value)} onKeyDown={keys} aria-label={column.name}>
          {!choices.includes(draft) && <option value={draft}>{draft === '' ? '—' : draft}</option>}
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : editing.large ? (
        <textarea ref={field} className="grid__editor-field" value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onKeyDown={keys} aria-label={column.name} rows={8} />
      ) : (
        <input ref={field} className="grid__editor-field" value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onKeyDown={keys} aria-label={column.name} />
      )}
      <div className="grid__editor-bar">
        <span className="grid__editor-type">{column.type}</span>
        {inserted && (
          <button type="button" onClick={() => onCommit(undefined)}>
            DEFAULT
          </button>
        )}
        {column.nullable !== false && (
          <button type="button" onClick={() => onCommit(null)}>
            NULL
          </button>
        )}
        <span className="grid__editor-hint">{editing.large ? m.db.grid.editLargeHint : m.db.grid.editHint}</span>
        <button type="button" className="grid__editor-ok" onClick={() => onCommit(draft)}>
          {m.common.save}
        </button>
      </div>
    </div>
  );
}

/** The selected cell in full: JSON laid out, long text wrapped, with its size and a copy button. */
export function ValuePanel({ column, value, onClose }: { column: GridColumn; value: DbCell; onClose: () => void }) {
  const { m, formatNumber } = useI18n();
  const toast = useToast();
  const text = prettyValue(value, column.kind);
  return (
    <aside className="valuepanel" aria-label={m.db.grid.value}>
      <header className="valuepanel__head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="valuepanel__name truncate">{column.name}</div>
          <div className="valuepanel__type">{column.type}</div>
        </div>
        <button
          type="button"
          className="valuepanel__btn"
          aria-label={m.common.copy}
          disabled={value === null}
          onClick={async () => {
            await navigator.clipboard.writeText(value ?? '');
            toast.success(m.common.copied);
          }}
        >
          <Copy aria-hidden="true" />
        </button>
        <button type="button" className="valuepanel__btn" aria-label={m.common.close} onClick={onClose}>
          ×
        </button>
      </header>
      {value === null ? <div className="valuepanel__null">NULL</div> : <pre className="valuepanel__body">{text}</pre>}
      {value !== null && (
        <footer className="valuepanel__foot">
          {formatNumber(value.length)} {m.db.grid.characters}
        </footer>
      )}
    </aside>
  );
}
