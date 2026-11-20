/**
 * Environment variable editor with two equivalent views: a table and the
 * `.env` text in a code editor. Pasting `.env` content into a key cell
 * expands into rows. Validation uses the API's own schema, so the UI never
 * accepts what the server will reject.
 *
 * The text is kept as it was written: comments, blank lines and variables
 * switched off with a `#` are saved with the variables and come back, and
 * an edit made in the table is worked into the text rather than replacing
 * it.
 */
import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Eye, EyeOff, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { analyzeDotenv, LIMITS, mergeDotenv, parseDotenv, putVariablesSchema, sameVariables, toDotenv, type EnvVarDto } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import { validate } from '../lib/validate.ts';
import { CodeEditor, dotenvMarks, renderDotenvLine, type Caret } from './CodeEditor.tsx';
import { Button, Kbd, Segmented } from './ui.tsx';

export { parseDotenv, toDotenv };

interface Row {
  id: number;
  key: string;
  value: string;
}

let nextId = 1;
const toRows = (variables: EnvVarDto[]): Row[] => variables.map((variable) => ({ id: nextId++, ...variable }));
const filled = (rows: Row[]): EnvVarDto[] => rows.filter((row) => row.key.trim().length > 0 || row.value.length > 0).map((row) => ({ key: row.key.trim(), value: row.value }));
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export interface EnvEditorProps {
  variables: EnvVarDto[];
  /** The variables as the `.env` text they were last saved as; null when they never were. */
  text?: string | null;
  inherited?: { key: string; source: string }[];
  /** `text` is what to keep as the written form, or null when there is nothing worth keeping. */
  onSave: (variables: EnvVarDto[], text: string | null) => Promise<unknown>;
  saving?: boolean;
  readOnly?: boolean;
}

export function EnvEditor({ variables, text = null, inherited = [], onSave, saving = false, readOnly = false }: EnvEditorProps) {
  const { m, t, plural } = useI18n();
  const v = m.variables;
  const baseText = useMemo(() => text ?? toDotenv(variables), [text, variables]);
  const [mode, setMode] = useState<'table' | 'raw'>('table');
  const [rows, setRows] = useState<Row[]>(() => toRows(variables));
  // The text is the fuller record: it holds the comments too, so the table's edits are merged into it.
  const [raw, setRaw] = useState(baseText);
  const [revealed, setRevealed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rawError, setRawError] = useState<string | null>(null);
  const [caret, setCaret] = useState<Caret | null>(null);

  const baseline = useMemo(() => JSON.stringify([variables, text]), [variables, text]);
  useEffect(() => {
    setRows(toRows(variables));
    setRaw(baseText);
    setErrors({});
    setRawError(null);
  }, [baseline]); // eslint-disable-line react-hooks/exhaustive-deps

  const analysis = useMemo(() => analyzeDotenv(raw), [raw]);
  const marks = useMemo(() => dotenvMarks(analysis.lines), [analysis]);
  const shadowed = analysis.lines.find((line) => line.shadowed)?.key ?? null;

  const dirty = mode === 'raw' ? raw !== baseText : !sameVariables(filled(rows), variables);

  const switchMode = (next: 'table' | 'raw') => {
    if (next === mode) return;
    if (next === 'raw') {
      setRaw(mergeDotenv(raw, filled(rows)));
    } else {
      const parsed = parseDotenv(raw);
      if (parsed.badLine !== null) {
        setRawError(t(v.invalidLine, { line: parsed.badLine }));
        return;
      }
      setRows(toRows(parsed.variables));
    }
    setRawError(null);
    setMode(next);
  };

  const update = (id: number, patch: Partial<Row>) => setRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const save = async () => {
    const keep = (value: string): string | null => (value.length <= LIMITS.envTextMax ? value : null);
    if (mode === 'raw') {
      const parsed = parseDotenv(raw);
      if (parsed.badLine !== null) {
        setRawError(t(v.invalidLine, { line: parsed.badLine }));
        return;
      }
      const result = validate(m, putVariablesSchema, { variables: parsed.variables });
      if (result.errors !== null) {
        // The text has no cells to point at: name the variable the first problem is about.
        const [path, message] = Object.entries(result.errors)[0] ?? ['', ''];
        const index = Number(/^variables\.(\d+)\./.exec(path)?.[1] ?? Number.NaN);
        const key = parsed.variables[index]?.key;
        setRawError(key === undefined ? message : `${key}: ${message}`);
        return;
      }
      setRawError(null);
      await onSave(result.data.variables, keep(raw));
      return;
    }
    const list = filled(rows);
    const result = validate(m, putVariablesSchema, { variables: list });
    if (result.errors !== null) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    // Work the table's edits into the text, so its comments outlive them. The text's order of lines is the order saved.
    const merged = mergeDotenv(raw, result.data.variables);
    const parsed = parseDotenv(merged);
    const faithful = parsed.badLine === null && parsed.variables.length === result.data.variables.length && result.data.variables.every((item) => parsed.variables.some((other) => other.key === item.key && other.value === item.value));
    if (faithful) await onSave(parsed.variables, keep(merged));
    else await onSave(result.data.variables, null);
  };

  const reset = () => {
    setRows(toRows(variables));
    setRaw(baseText);
    setErrors({});
    setRawError(null);
  };

  const liveError = rawError ?? (analysis.badLine === null ? null : t(v.invalidLine, { line: analysis.badLine }));

  return (
    <div className="env">
      <div className="env__bar">
        <Segmented
          label={v.title}
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'table', label: v.table },
            { value: 'raw', label: v.raw },
          ]}
        />
        <Button variant="ghost" size="sm" icon={revealed ? <EyeOff /> : <Eye />} aria-pressed={revealed} onClick={() => setRevealed((value) => !value)}>
          {revealed ? v.conceal : v.reveal}
        </Button>
      </div>

      {mode === 'table' ? (
        <>
          <div className="env__table" role="table" aria-label={v.title}>
            <div className="env__head" role="row">
              <span role="columnheader">{v.key}</span>
              <span role="columnheader">{v.value}</span>
              <span />
            </div>
            {rows.length === 0 && <p className="env__empty">{v.empty}</p>}
            {rows.map((row, index) => {
              const keyError = errors[`variables.${index}.key`];
              const valueError = errors[`variables.${index}.value`];
              return (
                <div className="env__row" role="row" key={row.id}>
                  <div role="cell">
                    <input
                      className="input input--mono"
                      value={row.key}
                      placeholder="DATABASE_URL"
                      aria-label={v.key}
                      aria-invalid={keyError !== undefined || undefined}
                      readOnly={readOnly}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => update(row.id, { key: event.target.value })}
                      onPaste={(event) => {
                        const pasted = event.clipboardData.getData('text');
                        if (!pasted.includes('=')) return;
                        const parsed = parseDotenv(pasted);
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
                      aria-label={v.value}
                      aria-invalid={valueError !== undefined || undefined}
                      readOnly={readOnly}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => update(row.id, { value: event.target.value })}
                    />
                    {valueError !== undefined && <span className="field__error">{valueError}</span>}
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
                  {v.add}
                </Button>
              </div>
            )}
          </div>
          {/* What the table cannot show is still there, one switch away. */}
          {analysis.disabled > 0 && (
            <p className="env__note">
              {plural(v.disabledNote, analysis.disabled)}{' '}
              <button type="button" className="link-btn" onClick={() => switchMode('raw')}>
                {v.openRaw}
              </button>
            </p>
          )}
        </>
      ) : (
        <div className="field">
          <CodeEditor
            label={v.raw}
            value={raw}
            onChange={(next) => {
              setRaw(next);
              setRawError(null);
            }}
            readOnly={readOnly}
            comment="#"
            marks={marks}
            placeholder={v.rawPlaceholder}
            onCaret={setCaret}
            renderLine={(line, index, active) => renderDotenvLine(line, analysis.lines[index], !revealed && !active)}
            bar={
              <>
                <span className="code__file">.env</span>
                <span className="code__stat">{plural(v.count, analysis.variables)}</span>
                {analysis.comments > 0 && <span className="code__stat">{plural(v.comments, analysis.comments)}</span>}
                {analysis.disabled > 0 && <span className="code__stat code__stat--off">{plural(v.disabled, analysis.disabled)}</span>}
              </>
            }
            foot={
              <>
                {liveError !== null ? (
                  <span className="code__problem" data-tone="bad" role="alert">
                    <CircleAlert aria-hidden="true" />
                    {liveError}
                  </span>
                ) : shadowed !== null ? (
                  <span className="code__problem" data-tone="warn">
                    <TriangleAlert aria-hidden="true" />
                    {t(v.shadowed, { key: shadowed })}
                  </span>
                ) : (
                  <span className="code__hint">{revealed ? v.rawHint : v.maskedHint}</span>
                )}
                <span className="code__spacer" />
                {!readOnly && (
                  <span className="code__hint code__keys">
                    <Kbd>{IS_MAC ? '⌘' : 'Ctrl'}</Kbd>
                    <Kbd>/</Kbd>
                    {v.toggleComment}
                  </span>
                )}
                {caret !== null && <span className="code__pos tabular">{t(v.position, { line: caret.line + 1, column: caret.column + 1 })}</span>}
              </>
            }
          />
        </div>
      )}

      {inherited.length > 0 && (
        <div className="env__inherited">
          <p className="field__label">{v.inherited}</p>
          <p className="field__hint">{v.inheritedHint}</p>
          <ul>
            {inherited.map((item) => (
              <li key={item.key}>
                <code>{item.key}</code>
                <span className="faint">{t(v.from, { source: item.source })}</span>
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
