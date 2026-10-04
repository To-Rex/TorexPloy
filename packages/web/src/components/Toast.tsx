/** Transient notifications, announced politely to screen readers. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import { errorText } from '../lib/errors.ts';

type ToastTone = 'ok' | 'bad' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastApi {
  success: (title: string, description?: string) => void;
  error: (error: unknown) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const ICONS: Record<ToastTone, ReactNode> = { ok: <CircleCheck />, bad: <CircleAlert />, info: <Info /> };

export function ToastProvider({ children }: { children: ReactNode }) {
  const { m } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const push = useCallback((tone: ToastTone, title: string, description?: string) => {
    const id = next.current++;
    setItems((current) => [...current.slice(-3), { id, tone, title, ...(description === undefined ? {} : { description }) }]);
    window.setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), tone === 'bad' ? 8_000 : 4_500);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, description) => push('ok', title, description),
      info: (title, description) => push('info', title, description),
      error: (error) => push('bad', errorText(m, error)),
    }),
    [push, m],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className="toast" data-tone={item.tone === 'info' ? 'info' : item.tone}>
            {ICONS[item.tone]}
            <div>
              <p style={{ fontWeight: 560 }}>{item.title}</p>
              {item.description !== undefined && <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{item.description}</p>}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (value === null) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
