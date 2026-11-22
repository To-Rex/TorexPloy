/**
 * The object browser: pick a database, then its schemas (PostgreSQL) and
 * their tables, views, sequences and routines, each table opening to its
 * columns. A search narrows everything at once; each object has its actions
 * a click away.
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Columns3,
  Eye,
  FileCode2,
  FolderTree,
  Globe,
  KeyRound,
  Layers,
  Link2,
  ListOrdered,
  MoreHorizontal,
  Plus,
  Puzzle,
  RefreshCw,
  Rows3,
  Search,
  Sigma,
  Table2,
  Trash2,
  Workflow,
  Zap,
} from 'lucide-react';
import { sqlScripts, type DbObjectDto, type DbObjectKind, type DbTreeDto } from '@ploy/shared';
import { Menu, MenuItem, MenuSeparator } from '../../components/Menu.tsx';
import { Button, Callout, Input, Select, SkeletonRows } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { errorText } from '../../lib/errors.ts';
import { useConsole } from './ConsoleContext.tsx';
import { exportUrl, useDbTable } from './dbApi.ts';
import { KIND_GLYPH } from './format.ts';
import { CreateDatabaseDialog, CreateTableDialog, NameDialog } from './SqlDialogs.tsx';

const GROUPS: { kind: DbObjectKind; icon: ReactNode }[] = [
  { kind: 'table', icon: <Table2 aria-hidden="true" /> },
  { kind: 'partitioned_table', icon: <Layers aria-hidden="true" /> },
  { kind: 'view', icon: <Eye aria-hidden="true" /> },
  { kind: 'materialized_view', icon: <Layers aria-hidden="true" /> },
  { kind: 'foreign_table', icon: <Globe aria-hidden="true" /> },
  { kind: 'sequence', icon: <ListOrdered aria-hidden="true" /> },
  { kind: 'function', icon: <Sigma aria-hidden="true" /> },
  { kind: 'procedure', icon: <Workflow aria-hidden="true" /> },
  { kind: 'trigger', icon: <Zap aria-hidden="true" /> },
  { kind: 'event', icon: <CalendarClock aria-hidden="true" /> },
];

export const OBJECT_ICON: Record<DbObjectKind, ReactNode> = Object.fromEntries(GROUPS.map((group) => [group.kind, group.icon])) as Record<DbObjectKind, ReactNode>;

const TABULAR = new Set<DbObjectKind>(['table', 'partitioned_table', 'view', 'materialized_view', 'foreign_table']);

function Columns({ schema, name }: { schema: string | null; name: string }) {
  const { m } = useI18n();
  const { service, database } = useConsole();
  const table = useDbTable(service.id, database, schema, name);
  if (table.isLoading) return <div className="tree__loading">{m.common.loading}</div>;
  if (table.data === undefined) return null;
  return (
    <ul className="tree__columns">
      {table.data.columns.map((column) => (
        <li key={column.name} title={`${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}${column.defaultValue === null ? '' : ` DEFAULT ${column.defaultValue}`}`}>
          {column.primaryKey ? <KeyRound className="tree__pk" aria-hidden="true" /> : column.references !== null ? <Link2 className="tree__fk" aria-hidden="true" /> : <span className="grid__glyph" data-kind={column.kind}>{KIND_GLYPH[column.kind]}</span>}
          <span className="tree__label">{column.name}</span>
          <span className="tree__type">{column.type}</span>
        </li>
      ))}
    </ul>
  );
}

function ObjectRow({ schema, object }: { schema: string | null; object: DbObjectDto }) {
  const { m, formatNumber } = useI18n();
  const { openTable, openObject, openQuery, execute, dialect, service, database } = useConsole();
  const [open, setOpen] = useState(false);
  const tabular = TABULAR.has(object.kind);
  const target = dialect === 'postgres' ? schema : null;
  const activate = () => (tabular ? openTable({ schema: target, name: object.name, kind: object.kind }) : openObject({ schema: target, name: object.name, kind: object.kind, detail: object.detail }));
  return (
    <li className="tree__item">
      <div className="tree__row" data-kind={object.kind}>
        {tabular ? (
          <button type="button" className="tree__twist" aria-expanded={open} aria-label={m.db.tree.columns} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
        ) : (
          <span className="tree__twist" />
        )}
        <button type="button" className="tree__main" onClick={activate} title={object.comment ?? object.name}>
          <span className="tree__icon">{OBJECT_ICON[object.kind]}</span>
          <span className="tree__label">{object.name}</span>
          {object.kind === 'function' || object.kind === 'procedure' ? (
            <span className="tree__type">({object.detail})</span>
          ) : object.kind === 'trigger' ? (
            <span className="tree__type">{object.detail}</span>
          ) : object.rows !== null && object.rows >= 0 ? (
            <span className="tree__count">{formatNumber(object.rows, { notation: 'compact' })}</span>
          ) : null}
        </button>
        <Menu trigger={(props) => <button {...props} type="button" className="tree__more" aria-label={m.db.table.actions}><MoreHorizontal aria-hidden="true" /></button>}>
          {tabular ? (
            <>
              <MenuItem icon={<Rows3 />} onSelect={() => openTable({ schema: target, name: object.name, kind: object.kind, view: 'data' })}>
                {m.db.table.data}
              </MenuItem>
              <MenuItem icon={<Columns3 />} onSelect={() => openTable({ schema: target, name: object.name, kind: object.kind, view: 'structure' })}>
                {m.db.table.structure}
              </MenuItem>
              <MenuItem icon={<FileCode2 />} onSelect={() => openTable({ schema: target, name: object.name, kind: object.kind, view: 'ddl' })}>
                DDL
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<FileCode2 />} onSelect={() => openQuery(sqlScripts.select(dialect, target, object.name, []), `${object.name} · SELECT`)}>
                SELECT *
              </MenuItem>
              <MenuItem href={exportUrl(service.id, { database, schema: target, table: object.name, format: 'csv' })}>{m.db.table.exportCsv}</MenuItem>
            </>
          ) : (
            <MenuItem icon={<FileCode2 />} onSelect={activate}>
              {m.db.tree.source}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 />}
            danger
            onSelect={() =>
              execute({
                title: m.db.table.drop,
                sql: sqlScripts.dropObject(dialect, object.kind, target, object.name, object.detail ?? ''),
                description: m.db.table.dropText,
                danger: true,
                confirmLabel: m.db.table.drop,
              })
            }
          >
            {m.db.table.drop}
          </MenuItem>
        </Menu>
      </div>
      {open && tabular && <Columns schema={target} name={object.name} />}
    </li>
  );
}

function Group({ schema, kind, objects, forceOpen, defaultOpen }: { schema: string | null; kind: DbObjectKind; objects: DbObjectDto[]; forceOpen: boolean; defaultOpen: boolean }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const shown = forceOpen || open;
  return (
    <li className="tree__group">
      <button type="button" className="tree__head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        {shown ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        <span className="tree__icon">{OBJECT_ICON[kind]}</span>
        <span className="tree__label">{m.db.groups[kind]}</span>
        <span className="tree__count">{objects.length}</span>
      </button>
      {shown && (
        <ul className="tree__list">
          {objects.map((object) => (
            <ObjectRow key={`${object.kind}:${object.name}:${object.detail ?? ''}`} schema={schema} object={object} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SchemaNode({ schema, filter, defaultOpen }: { schema: DbTreeDto['schemas'][number]; filter: string; defaultOpen: boolean }) {
  const { m } = useI18n();
  const { dialect, execute } = useConsole();
  const [open, setOpen] = useState(defaultOpen);
  const [creating, setCreating] = useState(false);
  const objects = filter.length === 0 ? schema.objects : schema.objects.filter((object) => object.name.toLowerCase().includes(filter));
  const groups = GROUPS.map((group) => ({ ...group, objects: objects.filter((object) => object.kind === group.kind) })).filter((group) => group.objects.length > 0 || (group.kind === 'table' && filter.length === 0));
  const shown = open || filter.length > 0;
  const body = (
    <ul className="tree__list">
      {groups.map((group) => (
        <Group key={group.kind} schema={schema.name} kind={group.kind} objects={group.objects} forceOpen={filter.length > 0} defaultOpen={group.kind === 'table'} />
      ))}
    </ul>
  );
  if (dialect === 'mysql') return body;
  if (filter.length > 0 && objects.length === 0) return null;
  return (
    <li className="tree__schema">
      <div className="tree__row">
        <button type="button" className="tree__head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
          {shown ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          <span className="tree__icon">
            <FolderTree aria-hidden="true" />
          </span>
          <span className="tree__label">{schema.name}</span>
          <span className="tree__count">{schema.objects.length}</span>
        </button>
        <Menu trigger={(props) => <button {...props} type="button" className="tree__more" aria-label={m.db.table.actions}><MoreHorizontal aria-hidden="true" /></button>}>
          <MenuItem icon={<Table2 />} onSelect={() => setCreating(true)}>
            {m.db.dialogs.createTable}
          </MenuItem>
          {schema.name !== 'public' && (
            <MenuItem
              icon={<Trash2 />}
              danger
              onSelect={() => execute({ title: m.db.tree.dropSchema, sql: sqlScripts.dropSchema(dialect, schema.name, true), danger: true, description: m.db.tree.dropSchemaText, confirmLabel: m.common.delete })}
            >
              {m.db.tree.dropSchema}
            </MenuItem>
          )}
        </Menu>
      </div>
      {shown && body}
      {creating && <CreateTableDialog schema={schema.name} onClose={() => setCreating(false)} />}
    </li>
  );
}

export function Tree({ tree, loading, error, onRefresh, refreshing }: { tree: DbTreeDto | undefined; loading: boolean; error: unknown; onRefresh: () => void; refreshing: boolean }) {
  const { m } = useI18n();
  const { overview, database, setDatabase, openQuery, dialect } = useConsole();
  const [filter, setFilter] = useState('');
  const [dialog, setDialog] = useState<'table' | 'schema' | 'database' | null>(null);
  const needle = filter.trim().toLowerCase();
  const total = useMemo(() => (tree?.schemas ?? []).reduce((sum, schema) => sum + schema.objects.length, 0), [tree]);
  const userDatabases = overview.databases.filter((db) => !db.system);
  const systemDatabases = overview.databases.filter((db) => db.system);
  return (
    <div className="tree">
      <div className="tree__top">
        <label className="tree__db">
          <span className="sr-only">{m.db.tree.database}</span>
          <Select value={database} onChange={(event) => setDatabase(event.target.value)} aria-label={m.db.tree.database}>
            {userDatabases.map((db) => (
              <option key={db.name} value={db.name}>
                {db.name}
              </option>
            ))}
            {systemDatabases.length > 0 && (
              <optgroup label={m.db.dashboard.system}>
                {systemDatabases.map((db) => (
                  <option key={db.name} value={db.name}>
                    {db.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </label>
        <Button size="sm" variant="ghost" iconOnly icon={<RefreshCw />} onClick={onRefresh} busy={refreshing}>
          {m.common.refresh}
        </Button>
        <Menu trigger={(props) => <Button {...props} size="sm" variant="ghost" iconOnly icon={<Plus />}>{m.common.create}</Button>}>
          <MenuItem icon={<FileCode2 />} onSelect={() => openQuery()}>
            {m.db.tabs.newQuery}
          </MenuItem>
          <MenuItem icon={<Table2 />} onSelect={() => setDialog('table')}>
            {m.db.dialogs.createTable}
          </MenuItem>
          {dialect === 'postgres' && (
            <MenuItem icon={<FolderTree />} onSelect={() => setDialog('schema')}>
              {m.db.tree.createSchema}
            </MenuItem>
          )}
          <MenuItem icon={<Plus />} onSelect={() => setDialog('database')}>
            {m.db.dialogs.createDatabase}
          </MenuItem>
        </Menu>
      </div>
      <div className="tree__search">
        <Search aria-hidden="true" />
        <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={m.db.tree.search} aria-label={m.db.tree.search} />
      </div>
      <div className="tree__body">
        {loading && <SkeletonRows rows={8} />}
        {error !== null && error !== undefined && (
          <Callout tone="bad" title={m.db.tree.loadFailed}>
            {errorText(m, error)}
          </Callout>
        )}
        {tree !== undefined && (
          <ul className="tree__list tree__list--root">
            {tree.schemas.map((schema) => (
              <SchemaNode key={schema.name} schema={schema} filter={needle} defaultOpen={schema.name === 'public' || tree.schemas.length === 1} />
            ))}
          </ul>
        )}
        {tree !== undefined && total === 0 && needle.length === 0 && <p className="tree__empty">{m.db.tree.empty}</p>}
        {tree !== undefined && tree.extensions.length > 0 && (
          <details className="tree__ext">
            <summary>
              <Puzzle aria-hidden="true" />
              {m.db.tree.extensions} <span className="tree__count">{tree.extensions.length}</span>
            </summary>
            <ul>
              {tree.extensions.map((extension) => (
                <li key={extension.name}>
                  <code>{extension.name}</code> <span className="tree__type">{extension.version}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {dialog === 'table' && <CreateTableDialog schema={dialect === 'postgres' ? 'public' : null} onClose={() => setDialog(null)} />}
      {dialog === 'database' && <CreateDatabaseDialog onClose={() => setDialog(null)} />}
      {dialog === 'schema' && <NameDialog title={m.db.tree.createSchema} label={m.db.tree.schema} build={(name) => sqlScripts.createSchema(dialect, name)} onClose={() => setDialog(null)} />}
    </div>
  );
}
