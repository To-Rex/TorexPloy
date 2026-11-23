/** How far a token reaches (read, write, full), as three choices a person can tell apart. */
import { TOKEN_ACCESS, type TokenAccess } from '@ploy/shared';
import { useI18n } from '../i18n/index.tsx';
import './connect.css';

export function AccessChoice({ value, onChange }: { value: TokenAccess; onChange: (value: TokenAccess) => void }) {
  const { m } = useI18n();
  return (
    <div className="mcp-access" role="radiogroup" aria-label={m.mcp.accessLabel}>
      {TOKEN_ACCESS.map((access) => (
        <label key={access} className="mcp-access__option" data-checked={value === access || undefined}>
          <input type="radio" name="access" value={access} checked={value === access} onChange={() => onChange(access)} />
          <span>
            <strong>{m.mcp.access[access]}</strong>
            <small>{m.mcp.accessHint[access]}</small>
          </span>
        </label>
      ))}
    </div>
  );
}
