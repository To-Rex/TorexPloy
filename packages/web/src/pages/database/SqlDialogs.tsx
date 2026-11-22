/**
 * Dialogs that build a statement: create a table, a column, an index, a
 * database or a role, rename something, set a password. Each one hands the
 * statement to the console's confirmation, where it can be read and edited
 * before it runs.
 */
import { useState } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { sqlScripts, type DbTableDto, type SqlColumnSpec, type SqlDialect } from '@ploy/shared';
import { Dialog } from '../../components/Dialog.tsx';
import { Button, Checkbox, Field, Input, Select } from '../../components/ui.tsx';
import { useI18n } from '../../i18n/index.tsx';
import { useConsole } from './ConsoleContext.tsx';

export const TYPE_SUGGESTIONS: Record<SqlDialect, string[]> = {
  postgres: [
    'bigint', 'integer', 'smallint', 'bigserial', 'serial', 'numeric(12,2)', 'real', 'double precision', 'boolean', 'text', 'varchar(255)', 'char(10)', 'uuid',
    'date', 'time', 'timestamp', 'timestamptz', 'interval', 'jsonb', 'json', 'bytea', 'inet', 'text[]', 'integer[]', 'bigint GENERATED ALWAYS AS IDENTITY',
  ],
  mysql: [
    'BIGINT', 'INT', 'BIGINT UNSIGNED', 'INT UNSIGNED', 'SMALLINT', 'TINYINT(1)', 'DECIMAL(12,2)', 'FLOAT', 'DOUBLE', 'VARCHAR(255)', 'CHAR(36)', 'TEXT',
    'MEDIUMTEXT', 'LONGTEXT', 'JSON', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'BLOB', 'VARBINARY(255)', "ENUM('a','b')", 'BIGINT UNSIGNED AUTO_INCREMENT',
  ],
};

function TypeInput({ value, onChange, id }: { value: string; onChange: (value: string) => void; id: string }) {
  const { dialect } = useConsole();
  return (
    <>
      <Input mono value={value} onChange={(event) => onChange(event.target.value)} list={`${id}-types`} spellCheck={false} />
      <datalist id={`${id}-types`}>
        {TYPE_SUGGESTIONS[dialect].map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
    </>
  );
}

const valid = (name: string) => name.trim().length > 0 && name.length <= 63;

export function CreateTableDialog({ schema: initialSchema, onClose }: { schema: string | null; onClose: () => void }) {
  const { m } = useI18n();
  const { dialect, execute, schemas, openTable } = useConsole();
  const [schema, setSchema] = useState(initialSchema ?? 'public');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [columns, setColumns] = useState<SqlColumnSpec[]>(() =>
    dialect === 'postgres'
      ? [
          { name: 'id', type: 'bigint GENERATED ALWAYS AS IDENTITY', nullable: false, defaultValue: '', primaryKey: true },
          { name: 'created_at', type: 'timestamptz', nullable: false, defaultValue: 'now()', primaryKey: false },
        ]
      : [
          { name: 'id', type: 'BIGINT UNSIGNED AUTO_INCREMENT', nullable: false, defaultValue: '', primaryKey: true },
          { name: 'created_at', type: 'DATETIME', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', primaryKey: false },
        ],
  );
  const update = (index: number, patch: Partial<SqlColumnSpec>) => setColumns(columns.map((column, at) => (at === index ? { ...column, ...patch } : column)));
  const ready = valid(name) && columns.length > 0 && columns.every((column) => valid(column.name) && column.type.trim().length > 0);
  return (
    <Dialog
      open
      xl
      onClose={onClose}
      title={m.db.dialogs.createTable}
      onSubmit={() => {
        if (!ready) return;
        execute({
          title: m.db.dialogs.createTable,
          sql: sqlScripts.createTable(dialect, schemas ? schema : null, name.trim(), columns.map((column) => ({ ...column, name: column.name.trim() })), comment),
          onDone: () => openTable({ schema: schemas ? schema : null, name: name.trim(), view: 'structure' }),
        });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {m.db.dialogs.review}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="dbform__row">
          {schemas && (
            <Field label={m.db.tree.schema}>
              <Input mono value={schema} onChange={(event) => setSchema(event.target.value)} />
            </Field>
          )}
          <Field label={m.db.dialogs.tableName}>
            <Input mono value={name} onChange={(event) => setName(event.target.value)} data-autofocus placeholder="orders" />
          </Field>
          <Field label={m.db.structure.comment} optional={m.common.optional}>
            <Input value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
        </div>
        <div className="colbuilder" role="table" aria-label={m.db.structure.columns}>
          <div className="colbuilder__head" role="row">
            <span>{m.db.structure.name}</span>
            <span>{m.db.structure.type}</span>
            <span>{m.db.structure.default}</span>
            <span title={m.db.structure.nullable}>NULL</span>
            <span title={m.db.structure.primaryKey}>
              <KeyRound aria-hidden="true" />
            </span>
            <span />
          </div>
          {columns.map((column, index) => (
            <div key={index} className="colbuilder__row" role="row">
              <Input mono value={column.name} onChange={(event) => update(index, { name: event.target.value })} aria-label={m.db.structure.name} />
              <TypeInput value={column.type} onChange={(type) => update(index, { type })} id={`col-${index}`} />
              <Input mono value={column.defaultValue} onChange={(event) => update(index, { defaultValue: event.target.value })} aria-label={m.db.structure.default} placeholder="—" />
              <input type="checkbox" checked={column.nullable && !column.primaryKey} disabled={column.primaryKey} onChange={(event) => update(index, { nullable: event.target.checked })} aria-label={m.db.structure.nullable} />
              <input type="checkbox" checked={column.primaryKey} onChange={(event) => update(index, { primaryKey: event.target.checked })} aria-label={m.db.structure.primaryKey} />
              <Button size="sm" variant="ghost" iconOnly icon={<Trash2 />} onClick={() => setColumns(columns.filter((_, at) => at !== index))} disabled={columns.length === 1}>
                {m.common.remove}
              </Button>
            </div>
          ))}
          <Button size="sm" icon={<Plus />} onClick={() => setColumns([...columns, { name: '', type: dialect === 'postgres' ? 'text' : 'VARCHAR(255)', nullable: true, defaultValue: '', primaryKey: false }])}>
            {m.db.dialogs.addColumn}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function AddColumnDialog({ table, onClose }: { table: DbTableDto; onClose: () => void }) {
  const { m } = useI18n();
  const { dialect, execute } = useConsole();
  const [column, setColumn] = useState<SqlColumnSpec>({ name: '', type: dialect === 'postgres' ? 'text' : 'VARCHAR(255)', nullable: true, defaultValue: '', primaryKey: false });
  const ready = valid(column.name) && column.type.trim().length > 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={m.db.dialogs.addColumn}
      onSubmit={() => {
        if (!ready) return;
        execute({ title: m.db.dialogs.addColumn, sql: sqlScripts.addColumn(dialect, table.schema, table.name, { ...column, name: column.name.trim() }) });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {m.db.dialogs.review}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label={m.db.structure.name}>
          <Input mono value={column.name} onChange={(event) => setColumn({ ...column, name: event.target.value })} data-autofocus />
        </Field>
        <Field label={m.db.structure.type}>
          <TypeInput value={column.type} onChange={(type) => setColumn({ ...column, type })} id="add-column" />
        </Field>
        <Field label={m.db.structure.default} optional={m.common.optional} hint={m.db.dialogs.defaultHint}>
          <Input mono value={column.defaultValue} onChange={(event) => setColumn({ ...column, defaultValue: event.target.value })} />
        </Field>
        <Checkbox checked={column.nullable} onChange={(nullable) => setColumn({ ...column, nullable })} label={m.db.dialogs.allowNull} />
      </div>
    </Dialog>
  );
}

export function IndexDialog({ table, onClose }: { table: DbTableDto; onClose: () => void }) {
  const { m } = useI18n();
  const { dialect, execute } = useConsole();
  const [chosen, setChosen] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [method, setMethod] = useState('btree');
  const [name, setName] = useState('');
  const auto = `${table.name}_${chosen.join('_') || 'col'}_${unique ? 'key' : 'idx'}`.slice(0, 63);
  return (
    <Dialog
      open
      onClose={onClose}
      title={m.db.dialogs.createIndex}
      onSubmit={() => {
        if (chosen.length === 0) return;
        execute({ title: m.db.dialogs.createIndex, sql: sqlScripts.createIndex(dialect, table.schema, table.name, name.trim() || auto, chosen, unique, dialect === 'postgres' ? method : '') });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={chosen.length === 0}>
            {m.db.dialogs.review}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label={m.db.dialogs.indexColumns} hint={m.db.dialogs.indexOrder}>
          <div className="pickcols">
            {table.columns.map((column) => {
              const at = chosen.indexOf(column.name);
              return (
                <button
                  key={column.name}
                  type="button"
                  aria-pressed={at !== -1}
                  onClick={() => setChosen(at === -1 ? [...chosen, column.name] : chosen.filter((entry) => entry !== column.name))}
                >
                  {at !== -1 && <span className="pickcols__order">{at + 1}</span>}
                  {column.name}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label={m.db.dialogs.indexName} optional={m.common.optional}>
          <Input mono value={name} onChange={(event) => setName(event.target.value)} placeholder={auto} />
        </Field>
        {dialect === 'postgres' && (
          <Field label={m.db.structure.method}>
            <Select value={method} onChange={(event) => setMethod(event.target.value)}>
              {['btree', 'hash', 'gin', 'gist', 'brin'].map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Checkbox checked={unique} onChange={setUnique} label={m.db.dialogs.unique} hint={m.db.dialogs.uniqueHint} />
      </div>
    </Dialog>
  );
}

/** One name in, a statement out (rename a table or column, create a schema). */
export function NameDialog({ title, label, initial = '', build, onClose, confirmLabel }: { title: string; label: string; initial?: string; build: (name: string) => string; onClose: () => void; confirmLabel?: string }) {
  const { m } = useI18n();
  const { execute } = useConsole();
  const [name, setName] = useState(initial);
  const ready = valid(name) && name !== initial;
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      onSubmit={() => {
        if (!ready) return;
        execute({ title, sql: build(name.trim()), ...(confirmLabel === undefined ? {} : { confirmLabel }) });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {m.db.dialogs.review}
          </Button>
        </>
      }
    >
      <Field label={label}>
        <Input mono value={name} onChange={(event) => setName(event.target.value)} data-autofocus />
      </Field>
    </Dialog>
  );
}

export function CreateDatabaseDialog({ onClose }: { onClose: () => void }) {
  const { m } = useI18n();
  const { dialect, execute, overview, setDatabase } = useConsole();
  const [name, setName] = useState('');
  const [encoding, setEncoding] = useState(dialect === 'postgres' ? 'UTF8' : 'utf8mb4');
  const [collation, setCollation] = useState(dialect === 'postgres' ? '' : 'utf8mb4_unicode_ci');
  const [owner, setOwner] = useState('');
  const ready = valid(name) && !overview.databases.some((db) => db.name === name.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={m.db.dialogs.createDatabase}
      onSubmit={() => {
        if (!ready) return;
        execute({
          title: m.db.dialogs.createDatabase,
          sql: sqlScripts.createDatabase(dialect, name.trim(), { owner: owner.trim(), encoding: encoding.trim(), collation: collation.trim() }),
          onDone: () => setDatabase(name.trim()),
        });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {m.db.dialogs.review}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label={m.db.dialogs.databaseName}>
          <Input mono value={name} onChange={(event) => setName(event.target.value)} data-autofocus placeholder="analytics" />
        </Field>
        <Field label={dialect === 'postgres' ? m.db.dashboard.encoding : m.db.dialogs.charset}>
          <Input mono value={encoding} onChange={(event) => setEncoding(event.target.value)} />
        </Field>
        {dialect === 'postgres' ? (
          <Field label={m.db.dashboard.owner} optional={m.common.optional}>
            <Input mono value={owner} onChange={(event) => setOwner(event.target.value)} placeholder={overview.user} />
          </Field>
        ) : (
          <Field label={m.db.dashboard.collation} optional={m.common.optional}>
            <Input mono value={collation} onChange={(event) => setCollation(event.target.value)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

export function RoleDialog({ onClose }: { onClose: () => void }) {
  const { m } = useI18n();
  const { dialect, execute, overview, database } = useConsole();
  const [name, setName] = useState('');
  const [password, setPassword] = useState(generatePassword);
  const [host, setHost] = useState('%');
  const [superuser, setSuperuser] = useState(false);
  const [createDb, setCreateDb] = useState(false);
  const [login, setLogin] = useState(true);
  const [grant, setGrant] = useState(database);
  const ready = valid(name) && (dialect === 'postgres' || password.length > 0);
  return (
    <Dialog
      open
      onClose={onClose}
      title={dialect === 'postgres' ? m.db.dialogs.createRole : m.db.dialogs.createUser}
      onSubmit={() => {
        if (!ready) return;
        execute({
          title: dialect === 'postgres' ? m.db.dialogs.createRole : m.db.dialogs.createUser,
          sql: sqlScripts.createRole(dialect, name.trim(), password, { host, superuser, createDb, login, database: grant === '' ? null : grant }),
          description: m.db.dialogs.passwordNote,
        });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={!ready}>
            {m.db.dialogs.review}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <Field label={m.db.roles.name}>
          <Input mono value={name} onChange={(event) => setName(event.target.value)} data-autofocus autoComplete="off" />
        </Field>
        <Field label={m.db.roles.password}>
          <div className="row" style={{ gap: 8 }}>
            <Input mono value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
            <Button iconOnly icon={<RefreshCw />} onClick={() => setPassword(generatePassword())}>
              {m.db.dialogs.generate}
            </Button>
          </div>
        </Field>
        {dialect === 'mysql' && (
          <Field label={m.db.roles.host} hint={m.db.dialogs.hostHint}>
            <Input mono value={host} onChange={(event) => setHost(event.target.value)} />
          </Field>
        )}
        <Field label={m.db.dialogs.grantOn} optional={m.common.optional}>
          <Select value={grant} onChange={(event) => setGrant(event.target.value)}>
            <option value="">—</option>
            {overview.databases
              .filter((db) => !db.system)
              .map((db) => (
                <option key={db.name} value={db.name}>
                  {db.name}
                </option>
              ))}
          </Select>
        </Field>
        <Checkbox checked={superuser} onChange={setSuperuser} label={m.db.roles.superuser} hint={m.db.dialogs.superuserHint} />
        {dialect === 'postgres' && (
          <>
            <Checkbox checked={createDb} onChange={setCreateDb} label={m.db.roles.createDb} />
            <Checkbox checked={login} onChange={setLogin} label={m.db.roles.canLogin} />
          </>
        )}
      </div>
    </Dialog>
  );
}

export function PasswordDialog({ name, host, onClose }: { name: string; host: string | null; onClose: () => void }) {
  const { m, t } = useI18n();
  const { dialect, execute } = useConsole();
  const [password, setPassword] = useState(generatePassword);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t(m.db.roles.passwordTitle, { name })}
      onSubmit={() => {
        if (password.length === 0) return;
        execute({ title: t(m.db.roles.passwordTitle, { name }), sql: sqlScripts.setPassword(dialect, name, password, host ?? '%'), description: m.db.dialogs.passwordNote });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>{m.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={password.length === 0}>
            {m.db.dialogs.review}
          </Button>
        </>
      }
    >
      <Field label={m.db.roles.password}>
        <div className="row" style={{ gap: 8 }}>
          <Input mono value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" data-autofocus />
          <Button iconOnly icon={<RefreshCw />} onClick={() => setPassword(generatePassword())}>
            {m.db.dialogs.generate}
          </Button>
        </div>
      </Field>
    </Dialog>
  );
}
