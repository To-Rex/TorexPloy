/**
 * Environment variable editor with two equivalent views: a table and raw
 * `.env` text. Pasting `.env` content into a key cell expands into rows.
 * Validation uses the API's own schema, so the UI never accepts what the
 * server will reject.
 */
import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { putVariablesSchema, type EnvVarDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { validate } from '../lib/validate.ts';
import { Button, Segmented, Textarea } from './ui.tsx';

interface Row {
  id: number;
  key: string;
  value: string;
}

let nextId = 1;
const toRows = (variables: EnvVarDto[]): Row[] => variables.map((variable) => ({ id: nextId++, ...variable }));

/** Parse `.env` text. Supports `export`, quotes and comments; reports the first bad line. */
export function parseDotenv(text: string): { variables: EnvVarDto[]; badLine: number | null } {
  const variables: EnvVarDto[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim();
    if (raw.length === 0 || raw.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (match === null) return { variables, badLine: index + 1 };
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    const existing = variables.findIndex((variable) => variable.key === match[1]);
    if (existing !== -1) variables.splice(existing, 1);
    variables.push({ key: match[1]!, value });
  }
  return { variables, badLine: null };
}

export function toDotenv(variables: EnvVarDto[]): string {
  return variables.map(({ key, value }) => `${key}=${/[\s#"'\\]|^$/.test(value) || value.includes('\n') ? JSON.stringify(value) : value}`).join('\n');
}

export interface EnvEditorProps {
  variables: EnvVarDto[];
  inherited?: { key: string; source: string }[];
  onSave: (variables: EnvVarDto[]) => Promise<unknown>;
  saving?: boolean;
  readOnly?: boolean;
}

export function EnvEditor({ variables, inherited = [], onSave, saving = false, readOnly = false }: EnvEditorProps) {
  const { m, t } = useI18n();
  const [mode, setMode] = useState<'table' | 'raw'>('table');
  const [rows, setRows] = useState<Row[]>(() => toRows(variables));
  const [raw, setRaw] = useState(() => toDotenv(variables));
  const [revealed, setRevealed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rawError, setRawError] = useState<string | null>(null);

  const baseline = useMemo(() => JSON.stringify(variables), [variables]);
  useEffect(() => {
    setRows(toRows(variables));
    setRaw(toDotenv(variables));
    setErrors({});
  }, [baseline]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = (): EnvVarDto[] | null => {
    if (mode === 'raw') {
      const parsed = parseDotenv(raw);
      if (parsed.badLine !== null) {
        setRawError(t(m.variables.invalidLine, { line: parsed.badLine }));
        return null;
      }
      setRawError(null);
      return parsed.variables;
    }
    return rows.filter((row) => row.key.trim().length > 0 || row.value.length > 0).map((row) => ({ key: row.key.trim(), value: row.value }));
  };

  const dirty = (() => {
    if (mode === 'raw') {
      const parsed = parseDotenv(raw);
      return parsed.badLine !== null || JSON.stringify(parsed.variables) !== baseline;
    }
    return JSON.stringify(rows.filter((row) => row.key.trim().length > 0 || row.value.length > 0).map((row) => ({ key: row.key.trim(), value: row.value }))) !== baseline;
  })();

  const switchMode = (next: 'table' | 'raw') => {
    if (next === mode) return;
    if (next === 'raw') {
      setRaw(toDotenv(current() ?? []));
    } else {
      const parsed = parseDotenv(raw);
      if (parsed.badLine !== null) {
        setRawError(t(m.variables.invalidLine, { line: parsed.badLine }));
        return;
      }
      setRows(toRows(parsed.variables));
    }
    setMode(next);
  };

  const update = (id: number, patch: Partial<Row>) => setRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const save = async () => {
    const list = current();
    if (list === null) return;
    const result = validate(m, putVariablesSchema, { variables: list });
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    await onSave(result.data.variables);
  };

  const reset = () => {
    setRows(toRows(variables));
    setRaw(toDotenv(variables));
    setErrors({});
    setRawError(null);
  };

  return (
    <div className="env">
      <div className="env__bar">
        <Segmented
          label={m.variables.title}
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'table', label: m.variables.table },
            { value: 'raw', label: m.variables.raw },
          ]}
        />
        {mode === 'table' && (
          <Button variant="ghost" size="sm" icon={revealed ? <EyeOff /> : <Eye />} onClick={() => setRevealed((value) => !value)}>
            {revealed ? m.variables.conceal : m.variables.reveal}
          </Button>
        )}
      </div>

      {mode === 'table' ? (
        <div className="env__table" role="table" aria-label={m.variables.title}>
          <div className="env__head" role="row">
            <span role="columnheader">{m.variables.key}</span>
            <span role="columnheader">{m.variables.value}</span>
            <span />
          </div>
          {rows.length === 0 && <p className="env__empty">{m.variables.empty}</p>}
          {rows.map((row, index) => {
            const keyError = errors[`variables.${index}.key`];
            return (
              <div className="env__row" role="row" key={row.id}>
                <div role="cell">
                  <input
                    className="input input--mono"
                    value={row.key}
                    placeholder="DATABASE_URL"
                    aria-label={m.variables.key}
                    aria-invalid={keyError !== undefined || undefined}
                    readOnly={readOnly}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => update(row.id, { key: event.target.value })}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData('text');
                      if (!text.includes('=')) return;
                      const parsed = parseDotenv(text);
                      if (parsed.variables.length === 0) return;
                      event.preventDefault();
                      setRows((list) => {
                        const merged = list.filter((candidate) => candidate.id !== row.id || candidate.key.length > 0 || candidate.value.length > 0);
                        for (const variable of parsed.variables) {
                          const existing = merged.find((candidate) => candidate.key === variable.key);
                          if (existing !== undefined) existing.value = variable.value;
                          else merged.push({ id: nextId++, ...variable });
                        }
                        return [...merged];
                      });
                    }}
                  />
                  {keyError !== undefined && <span className="field__error">{keyError}</span>}
                </div>
                <div role="cell">
                  <input
                    className="input input--mono"
                    value={row.value}
                    type={revealed ? 'text' : 'password'}
                    aria-label={m.variables.value}
                    readOnly={readOnly}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => update(row.id, { value: event.target.value })}
                  />
                </div>
                <div role="cell">
                  {!readOnly && (
                    <Button variant="ghost" size="sm" iconOnly icon={<Trash2 />} onClick={() => setRows((list) => list.filter((candidate) => candidate.id !== row.id))}>
                      {m.common.remove}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {!readOnly && (
            <div className="env__add">
              <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setRows((list) => [...list, { id: nextId++, key: '', value: '' }])}>
                {m.variables.add}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="field">
          <Textarea mono value={raw} onChange={(event) => setRaw(event.target.value)} rows={Math.min(24, Math.max(8, raw.split('\n').length + 2))} spellCheck={false} aria-label={m.variables.raw} readOnly={readOnly} />
          {rawError !== null ? <p className="field__error">{rawError}</p> : <p className="field__hint">{m.variables.rawHint}</p>}
        </div>
      )}

      {inherited.length > 0 && (
        <div className="env__inherited">
          <p className="field__label">{m.variables.inherited}</p>
          <p className="field__hint">{m.variables.inheritedHint}</p>
          <ul>
            {inherited.map((item) => (
              <li key={item.key}>
                <code>{item.key}</code>
                <span className="faint">{t(m.variables.from, { source: item.source })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!readOnly && dirty && (
        <div className="savebar" role="region" aria-label={m.common.unsavedChanges}>
          <span>{m.common.unsavedChanges}</span>
          <div className="row">
            <Button variant="ghost" onClick={reset}>
              {m.common.discard}
            </Button>
            <Button variant="primary" busy={saving} onClick={() => void save()}>
              {m.common.saveChanges}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
