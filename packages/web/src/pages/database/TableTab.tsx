/**
 * A table (or view) tab: its rows, its structure and its DDL, with the
 * table-level actions in one menu. Other objects (functions, procedures,
 * sequences, triggers, events) open as their source.
 */
import { useState } from 'react';
import {
  ArrowUpRight,
  Braces,
  ChevronDown,
  Columns3,
  Copy,
  Database,
  Eraser,
  FileCode2,
  KeyRound,
  Link2,
  ListPlus,
  Pencil,
  Plus,
  Rows3,
  Table2,
  Trash2,
  Wrench,
  Zap,
} from 'lucide-react';
import { sqlScripts, type DbObjectKind, type DbTableDto } from '@ploy/shared';
import { useConfirm } from '../../components/Dialog.tsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../components/Menu.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Badge, Button, Callout, Segmented, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { errorText } from '../../lib/errors.ts';
import { useConsole, type ConsoleTab, type TableView } from './ConsoleContext.tsx';
import { exportUrl, useDbSource, useDbTable } from './dbApi.ts';
import { KIND_GLYPH } from './format.ts';
import { AddColumnDialog, IndexDialog, NameDialog } from './SqlDialogs.tsx';
import { SqlEditor } from './SqlEditor.tsx';
import { TableData } from './TableData.tsx';

type TableState = Extract<ConsoleTab, { kind: 'table' }>;
type ObjectState = Extract<ConsoleTab, { kind: 'object' }>;

const BYTE_STATS = new Set(['data_size', 'index_size', 'total_size', 'free_size']);
const TIME_STATS = new Set(['last_vacuum', 'last_analyze', 'created', 'updated']);
const COUNT_STATS = new Set(['live_rows', 'dead_rows', 'seq_scans', 'index_scans', 'rows_inserted', 'rows_updated', 'rows_deleted', 'avg_row_length', 'auto_increment']);

export function TableTab({ tab, onChange, visible }: { tab: TableState; onChange: (patch: Partial<TableState>) => void; visible: boolean }) {
  const { m, formatNumber, formatBytes } = useI18n();
  const toast = useToast();
  const { service, dialect, execute, openQuery, closeTab } = useConsole();
  const table = useDbTable(service.id, tab.database, tab.schema, tab.name);
  const [dialog, setDialog] = useState<'column' | 'index' | 'rename' | null>(null);
  const data = table.data;
  const isTable = data?.kind === 'table' || data?.kind === 'partitioned_table';
  const columns = data?.columns.map((column) => column.name) ?? [];

  const script = (kind: 'select' | 'insert' | 'update' | 'delete') => {
    if (data === undefined) return;
    const sql =
      kind === 'select'
        ? sqlScripts.select(dialect, data.schema, data.name, columns)
        : kind === 'insert'
          ? sqlScripts.insert(dialect, data.schema, data.name, data.columns.filter((column) => !column.autoIncrement && !column.generated).map((column) => column.name))
          : kind === 'update'
            ? sqlScripts.update(dialect, data.schema, data.name, columns.filter((name) => !data.keyColumns.includes(name)), data.keyColumns)
            : sqlScripts.delete(dialect, data.schema, data.name, data.keyColumns);
    openQuery(sql, `${data.name} · ${kind.toUpperCase()}`);
  };

  return (
    <div className="ttab" hidden={!visible}>
      <header className="ttab__head">
        <span className="ttab__icon" data-kind={tab.objectKind}>
          <Table2 aria-hidden="true" />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ttab__title truncate">
            {tab.schema !== null && <span className="ttab__schema">{tab.schema}.</span>}
            {tab.name}
          </h2>
          <div className="ttab__meta">
            <Badge>{m.db.kinds[data?.kind ?? tab.objectKind]}</Badge>
            {data?.rowEstimate !== null && data?.rowEstimate !== undefined && <span>≈ {formatNumber(data.rowEstimate)} {m.db.tree.rows}</span>}
            {data?.sizeBytes !== null && data?.sizeBytes !== undefined && <span>{formatBytes(data.sizeBytes)}</span>}
            {data?.comment !== null && data?.comment !== undefined && <span className="ttab__comment truncate">{data.comment}</span>}
          </div>
        </div>
        <Segmented<TableView>
          value={tab.view}
          onChange={(view) => onChange({ view })}
          label={tab.name}
          options={[
            { value: 'data', label: m.db.table.data, icon: <Rows3 aria-hidden="true" /> },
            { value: 'structure', label: m.db.table.structure, icon: <Columns3 aria-hidden="true" /> },
            { value: 'ddl', label: 'DDL', icon: <FileCode2 aria-hidden="true" /> },
          ]}
        />
        <Menu
          trigger={(props) => (
            <Button {...props} size="sm" icon={<Wrench />} disabled={data === undefined}>
              {m.db.table.actions}
              <ChevronDown className="btn__chevron" aria-hidden="true" />
            </Button>
          )}
        >
          <MenuLabel>{m.db.table.scripts}</MenuLabel>
          <MenuItem icon={<Braces />} onSelect={() => script('select')}>
            SELECT
          </MenuItem>
          {isTable && (
            <>
              <MenuItem icon={<Braces />} onSelect={() => script('insert')}>
                INSERT
              </MenuItem>
              <MenuItem icon={<Braces />} onSelect={() => script('update')}>
                UPDATE
              </MenuItem>
              <MenuItem icon={<Braces />} onSelect={() => script('delete')}>
                DELETE
              </MenuItem>
            </>
          )}
          <MenuSeparator />
          <MenuItem href={exportUrl(service.id, { database: tab.database, schema: tab.schema, table: tab.name, format: 'csv' })}>{m.db.table.exportCsv}</MenuItem>
          <MenuItem href={exportUrl(service.id, { database: tab.database, schema: tab.schema, table: tab.name, format: 'sql' })}>{m.db.table.exportSql}</MenuItem>
          {isTable && data !== undefined && (
            <>
              <MenuSeparator />
              <MenuLabel>{m.db.table.maintenance}</MenuLabel>
              {(dialect === 'postgres' ? (['vacuum', 'vacuum_full', 'analyze', 'reindex'] as const) : (['optimize', 'analyze', 'check'] as const)).map((action) => (
                <MenuItem key={action} icon={<Zap />} onSelect={() => execute({ title: m.db.table.maintenanceActions[action], sql: sqlScripts.maintenance(dialect, action, data.schema, data.name), description: m.db.table.maintenanceHints[action] })}>
                  {m.db.table.maintenanceActions[action]}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem icon={<Pencil />} onSelect={() => setDialog('rename')}>
                {m.db.table.rename}
              </MenuItem>
              <MenuItem
                icon={<Eraser />}
                danger
                onSelect={() => execute({ title: m.db.table.truncate, sql: sqlScripts.truncate(dialect, data.schema, data.name), description: m.db.table.truncateText, danger: true, confirmLabel: m.db.table.truncate })}
              >
                {m.db.table.truncate}
              </MenuItem>
            </>
          )}
          {data !== undefined && (
            <MenuItem
              icon={<Trash2 />}
              danger
              onSelect={() =>
                execute({
                  title: m.db.table.drop,
                  sql: sqlScripts.dropObject(dialect, data.kind, data.schema, data.name),
                  description: m.db.table.dropText,
                  danger: true,
                  confirmLabel: m.db.table.drop,
                  onDone: () => closeTab(tab.id),
                })
              }
            >
              {m.db.table.drop}
            </MenuItem>
          )}
        </Menu>
      </header>
      {table.isLoading && (
        <div className="ttab__body">
          <SkeletonRows rows={6} />
        </div>
      )}
      {table.error !== null && table.error !== undefined && (
        <div className="ttab__body">
          <Callout tone="bad" title={m.db.table.loadFailed}>
            {errorText(m, table.error)}
          </Callout>
        </div>
      )}
      {data !== undefined && (
        <>
          {tab.view === 'data' && <TableData table={data} />}
          {tab.view === 'structure' && <TableStructure table={data} onDialog={setDialog} />}
          {tab.view === 'ddl' && <DdlView ddl={data.ddl} title={data.name} />}
        </>
      )}
      {data !== undefined && dialog === 'column' && <AddColumnDialog table={data} onClose={() => setDialog(null)} />}
      {data !== undefined && dialog === 'index' && <IndexDialog table={data} onClose={() => setDialog(null)} />}
      {data !== undefined && dialog === 'rename' && (
        <NameDialog
          title={m.db.table.rename}
          label={m.db.dialogs.newName}
          initial={data.name}
          build={(name) => {
            toast.info(m.db.table.renameNote);
            return sqlScripts.renameTable(dialect, data.schema, data.name, name);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function TableStructure({ table, onDialog }: { table: DbTableDto; onDialog: (dialog: 'column' | 'index') => void }) {
  const { m, formatNumber, formatBytes, formatRelative } = useI18n();
  const { dialect, execute, openTable } = useConsole();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState<string | null>(null);
  const isTable = table.kind === 'table' || table.kind === 'partitioned_table';
  const statValue = (key: string, value: string) => {
    if (BYTE_STATS.has(key)) return formatBytes(Number(value));
    if (TIME_STATS.has(key)) {
      const date = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
      return Number.isNaN(date.getTime()) ? value : formatRelative(date);
    }
    if (COUNT_STATS.has(key) && /^\d+$/.test(value)) return formatNumber(Number(value));
    return value;
  };
  return (
    <div className="tstruct">
      {table.stats.length > 0 && (
        <dl className="tstruct__stats">
          {table.stats.map((stat) => (
            <div key={stat.key}>
              <dt>{m.db.structure.stats[stat.key as keyof typeof m.db.structure.stats] ?? stat.key}</dt>
              <dd>{statValue(stat.key, stat.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <section className="tstruct__section">
        <header>
          <h3>
            {m.db.structure.columns} <span className="tstruct__count">{table.columns.length}</span>
          </h3>
          {isTable && (
            <Button size="sm" icon={<Plus />} onClick={() => onDialog('column')}>
              {m.db.dialogs.addColumn}
            </Button>
          )}
        </header>
        <div className="dbtable">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{m.db.structure.name}</th>
                <th>{m.db.structure.type}</th>
                <th>{m.db.structure.nullable}</th>
                <th>{m.db.structure.default}</th>
                <th>{m.db.structure.comment}</th>
                {isTable && <th aria-label={m.db.table.actions} />}
              </tr>
            </thead>
            <tbody>
              {table.columns.map((column, index) => (
                <tr key={column.name}>
                  <td className="dbtable__num">{index + 1}</td>
                  <td>
                    <span className="dbtable__name">
                      {column.primaryKey && <KeyRound className="grid__key" aria-label={m.db.structure.primaryKey} />}
                      <code>{column.name}</code>
                      {column.autoIncrement && <Badge tone="info">{m.db.structure.auto}</Badge>}
                      {column.generated && <Badge>{m.db.structure.generated}</Badge>}
                    </span>
                    {column.references !== null && (
                      <button type="button" className="dbtable__ref" onClick={() => openTable({ schema: column.references!.schema, name: column.references!.table })}>
                        <Link2 aria-hidden="true" /> {column.references.table}.{column.references.column}
                      </button>
                    )}
                  </td>
                  <td>
                    <span className="dbtable__type">
                      <span className="grid__glyph" data-kind={column.kind}>
                        {KIND_GLYPH[column.kind]}
                      </span>
                      <code>{column.type}</code>
                    </span>
                    {column.options !== null && <div className="dbtable__options">{column.options.join(' · ')}</div>}
                  </td>
                  <td>{column.nullable ? <span className="muted">NULL</span> : <Badge tone="work">NOT NULL</Badge>}</td>
                  <td>{column.defaultValue === null ? <span className="muted">—</span> : <code className="dbtable__default">{column.defaultValue}</code>}</td>
                  <td className="dbtable__comment">{column.comment ?? ''}</td>
                  {isTable && (
                    <td className="dbtable__actions">
                      <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<ChevronDown />}>{m.db.table.actions}</Button>}>
                        <MenuItem icon={<Pencil />} onSelect={() => setRenaming(column.name)}>
                          {m.db.structure.renameColumn}
                        </MenuItem>
                        <MenuItem
                          icon={<Copy />}
                          onSelect={() => void navigator.clipboard.writeText(column.name)}
                        >
                          {m.db.structure.copyName}
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          icon={<Trash2 />}
                          danger
                          onSelect={() => execute({ title: m.db.structure.dropColumn, sql: sqlScripts.dropColumn(dialect, table.schema, table.name, column.name), danger: true, description: m.db.structure.dropColumnText, confirmLabel: m.common.delete })}
                        >
                          {m.db.structure.dropColumn}
                        </MenuItem>
                      </Menu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {(table.indexes.length > 0 || isTable) && (
        <section className="tstruct__section">
          <header>
            <h3>
              {m.db.structure.indexes} <span className="tstruct__count">{table.indexes.length}</span>
            </h3>
            {isTable && (
              <Button size="sm" icon={<ListPlus />} onClick={() => onDialog('index')}>
                {m.db.dialogs.createIndex}
              </Button>
            )}
          </header>
          {table.indexes.length === 0 ? (
            <p className="muted tstruct__empty">{m.db.structure.noIndexes}</p>
          ) : (
            <div className="dbtable">
              <table>
                <thead>
                  <tr>
                    <th>{m.db.structure.name}</th>
                    <th>{m.db.structure.columns}</th>
                    <th>{m.db.structure.method}</th>
                    <th>{m.db.structure.size}</th>
                    <th aria-label={m.db.table.actions} />
                  </tr>
                </thead>
                <tbody>
                  {table.indexes.map((index) => (
                    <tr key={index.name}>
                      <td>
                        <span className="dbtable__name">
                          <code>{index.name}</code>
                          {index.primary ? <Badge tone="ok">PRIMARY</Badge> : index.unique ? <Badge tone="info">UNIQUE</Badge> : null}
                        </span>
                        {index.definition !== null && <div className="dbtable__def">{index.definition}</div>}
                      </td>
                      <td>
                        <code>{index.columns.join(', ') || '—'}</code>
                      </td>
                      <td>{index.method ?? '—'}</td>
                      <td>{index.sizeBytes === null ? '—' : formatBytes(index.sizeBytes)}</td>
                      <td className="dbtable__actions">
                        {!index.primary && isTable && (
                          <Button
                            size="sm"
                            variant="ghost"
                            iconOnly
                            icon={<Trash2 />}
                            onClick={() => execute({ title: m.db.structure.dropIndex, sql: sqlScripts.dropIndex(dialect, table.schema, table.name, index.name), danger: true, confirmLabel: m.common.delete })}
                          >
                            {m.db.structure.dropIndex}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {table.constraints.length > 0 && (
        <section className="tstruct__section">
          <header>
            <h3>
              {m.db.structure.constraints} <span className="tstruct__count">{table.constraints.length}</span>
            </h3>
          </header>
          <ul className="tstruct__list">
            {table.constraints.map((constraint) => (
              <li key={constraint.name}>
                <Badge tone={constraint.kind === 'primary_key' ? 'ok' : constraint.kind === 'foreign_key' ? 'info' : undefined}>{constraint.kind === 'other' ? m.db.structure.constraintOther : m.db.structure.constraintKinds[constraint.kind]}</Badge>
                <code className="tstruct__cname">{constraint.name}</code>
                <code className="tstruct__def">{constraint.definition}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Trash2 />}
                  onClick={async () => {
                    const result = await confirm({ title: m.db.structure.dropConstraint, text: constraint.name, confirmLabel: m.db.dialogs.review });
                    if (result.confirmed) execute({ title: m.db.structure.dropConstraint, sql: sqlScripts.dropConstraint(dialect, table.schema, table.name, constraint.name, constraint.kind), danger: true });
                  }}
                >
                  {m.db.structure.dropConstraint}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {table.referencedBy.length > 0 && (
        <section className="tstruct__section">
          <header>
            <h3>
              {m.db.structure.referencedBy} <span className="tstruct__count">{table.referencedBy.length}</span>
            </h3>
          </header>
          <ul className="tstruct__list">
            {table.referencedBy.map((reference) => (
              <li key={`${reference.table}.${reference.constraint}`}>
                <button type="button" className="dbtable__ref" onClick={() => openTable({ schema: reference.schema, name: reference.table })}>
                  <ArrowUpRight aria-hidden="true" />
                  {reference.schema !== null && dialect === 'postgres' ? `${reference.schema}.` : ''}
                  {reference.table}
                </button>
                <code className="tstruct__def">({reference.columns.join(', ')})</code>
                <span className="muted">{reference.constraint}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {table.triggers.length > 0 && (
        <section className="tstruct__section">
          <header>
            <h3>
              {m.db.structure.triggers} <span className="tstruct__count">{table.triggers.length}</span>
            </h3>
          </header>
          <ul className="tstruct__list">
            {table.triggers.map((trigger) => (
              <li key={trigger.name}>
                <Badge tone={trigger.enabled ? 'ok' : 'idle'}>{trigger.timing || 'TRIGGER'}</Badge>
                <code className="tstruct__cname">{trigger.name}</code>
                <code className="tstruct__def">{trigger.definition}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {renaming !== null && (
        <NameDialog
          title={m.db.structure.renameColumn}
          label={m.db.dialogs.newName}
          initial={renaming}
          build={(name) => sqlScripts.renameColumn(dialect, table.schema, table.name, renaming, name)}
          onClose={() => setRenaming(null)}
        />
      )}
    </div>
  );
}

export function DdlView({ ddl, title }: { ddl: string; title: string }) {
  const { m } = useI18n();
  const toast = useToast();
  const { dialect, openQuery } = useConsole();
  return (
    <div className="ddlview">
      <SqlEditor
        value={ddl}
        onChange={() => undefined}
        dialect={dialect}
        label={`${title} DDL`}
        readOnly
        fill
        bar={
          <>
            <span className="code__file">{title}.sql</span>
            <span className="code__spacer" />
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy />}
              onClick={async () => {
                await navigator.clipboard.writeText(ddl);
                toast.success(m.common.copied);
              }}
            >
              {m.common.copy}
            </Button>
            <Button size="sm" variant="ghost" icon={<ArrowUpRight />} onClick={() => openQuery(ddl, `${title} · DDL`)}>
              {m.db.table.openInEditor}
            </Button>
          </>
        }
      />
    </div>
  );
}

export function ObjectTab({ tab, visible }: { tab: ObjectState; visible: boolean }) {
  const { m } = useI18n();
  const { service, dialect, execute, closeTab } = useConsole();
  const source = useDbSource(service.id, tab.database, tab.schema, tab.name, tab.objectKind, tab.detail);
  const droppable: DbObjectKind[] = ['function', 'procedure', 'sequence', 'trigger', 'event', 'view', 'materialized_view'];
  return (
    <div className="ttab" hidden={!visible}>
      <header className="ttab__head">
        <span className="ttab__icon" data-kind={tab.objectKind}>
          <Database aria-hidden="true" />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ttab__title truncate">
            {tab.schema !== null && dialect === 'postgres' && <span className="ttab__schema">{tab.schema}.</span>}
            {tab.name}
            {tab.detail !== null && (tab.objectKind === 'function' || tab.objectKind === 'procedure') && <span className="ttab__args">({tab.detail})</span>}
          </h2>
          <div className="ttab__meta">
            <Badge>{m.db.kinds[tab.objectKind]}</Badge>
            {tab.detail !== null && tab.objectKind !== 'function' && tab.objectKind !== 'procedure' && <span>{tab.detail}</span>}
          </div>
        </div>
        {droppable.includes(tab.objectKind) ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 />}
            onClick={() =>
              execute({
                title: m.db.table.drop,
                sql: sqlScripts.dropObject(dialect, tab.objectKind, tab.schema, tab.name, tab.detail ?? ''),
                danger: true,
                description: m.db.table.dropText,
                confirmLabel: m.db.table.drop,
                onDone: () => closeTab(tab.id),
              })
            }
          >
            {m.db.table.drop}
          </Button>
        ) : null}
      </header>
      {source.isLoading && (
        <div className="ttab__body">
          <SkeletonRows rows={6} />
        </div>
      )}
      {source.error !== null && source.error !== undefined && (
        <div className="ttab__body">
          <Callout tone="bad" title={m.db.table.loadFailed}>
            {errorText(m, source.error)}
          </Callout>
        </div>
      )}
      {source.data !== undefined && <DdlView ddl={source.data.ddl} title={tab.name} />}
    </div>
  );
}
