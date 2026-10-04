/** Copy-to-clipboard and masked secret values. */
import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import { Button } from './ui.tsx';

export async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea on plain-HTTP installs.
    // While a modal <dialog> is open the rest of the page is inert, so the textarea must live inside it.
    const host = document.querySelector<HTMLDialogElement>('dialog[open]') ?? document.body;
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    host.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, value.length);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export function CopyButton({ value, label, size = 'sm' }: { value: string; label?: string; size?: 'sm' | 'md' }) {
  const { m } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size={size}
      iconOnly={label === undefined}
      icon={done ? <Check /> : <Copy />}
      onClick={async () => {
        if (await writeClipboard(value)) {
          setDone(true);
          window.setTimeout(() => setDone(false), 1_500);
        }
      }}
      aria-live="polite"
    >
      {label ?? (done ? m.common.copied : m.common.copy)}
    </Button>
  );
}

/** A read-only value in a box with copy (and optional reveal for secrets). */
export function ValueField({ value, secret = false, onReveal, children }: { value: string; secret?: boolean; onReveal?: () => Promise<string> | void; children?: ReactNode }) {
  const { m } = useI18n();
  const [revealed, setRevealed] = useState(!secret);
  return (
    <div className="secret-field">
      <span title={revealed ? value : undefined}>{children ?? (revealed ? value : '•'.repeat(Math.min(24, Math.max(8, value.length))))}</span>
      {secret && (
        <Button variant="ghost" size="sm" iconOnly icon={revealed ? <EyeOff /> : <Eye />} onClick={() => {
          if (!revealed) void onReveal?.();
          setRevealed((current) => !current);
        }}>
          {revealed ? m.common.hide : m.common.show}
        </Button>
      )}
      <CopyButton value={value} />
    </div>
  );
}
