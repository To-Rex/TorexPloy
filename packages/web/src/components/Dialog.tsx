/**
 * Modal dialog on the native <dialog> element: the browser provides the
 * focus trap, Esc to close, inertness of the page and the backdrop.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import { Button, Checkbox, Field, Input } from './ui.tsx';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Nearly full width: terminals, editors. */
  xl?: boolean;
  /** Render the body inside a form so Enter submits. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}

export function Dialog({ open, onClose, title, description, children, footer, wide = false, xl = false, onSubmit }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const { m } = useI18n();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal focuses the first control (the close button); React's autoFocus does not set the attribute, so honour data-autofocus.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const content = (
    <>
      <div className="dialog__head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{title}</h2>
          {description !== undefined && <p>{description}</p>}
        </div>
        <Button variant="ghost" size="sm" iconOnly icon={<X />} onClick={onClose}>
          {m.common.close}
        </Button>
      </div>
      {children !== undefined && <div className="dialog__body">{children}</div>}
      {footer !== undefined && <div className="dialog__foot">{footer}</div>}
    </>
  );

  return (
    <dialog
      ref={ref}
      className={xl ? 'dialog dialog--xl' : wide ? 'dialog dialog--wide' : 'dialog'}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) onClose();
      }}
    >
      {open &&
        (onSubmit === undefined ? (
          content
        ) : (
          <form
            style={{ display: 'contents' }}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit(event);
            }}
          >
            {content}
          </form>
        ))}
    </dialog>
  );
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: ReactNode;
  text?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Require typing this exact value (e.g. the resource name) before confirming. */
  typeToConfirm?: string;
  /** Optional extra checkbox (e.g. "also delete data"). */
  checkbox?: { label: ReactNode; hint?: ReactNode };
}

type ConfirmResult = { confirmed: boolean; checked: boolean };

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<ConfirmResult>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { m, t } = useI18n();
  const [state, setState] = useState<{ options: ConfirmOptions; resolve: (result: ConfirmResult) => void } | null>(null);
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);

  const confirm = useCallback((options: ConfirmOptions) => {
    setTyped('');
    setChecked(false);
    return new Promise<ConfirmResult>((resolve) => setState({ options, resolve }));
  }, []);

  const finish = (confirmed: boolean): void => {
    state?.resolve({ confirmed, checked });
    setState(null);
  };

  const options = state?.options;
  const blocked = options?.typeToConfirm !== undefined && typed.trim() !== options.typeToConfirm;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={state !== null}
        onClose={() => finish(false)}
        title={options?.title}
        description={options?.text}
        onSubmit={() => {
          if (!blocked) finish(true);
        }}
        footer={
          <>
            <Button onClick={() => finish(false)}>{m.common.cancel}</Button>
            <Button type="submit" variant={options?.danger ? 'danger' : 'primary'} disabled={blocked}>
              {options?.confirmLabel}
            </Button>
          </>
        }
      >
        {(options?.typeToConfirm !== undefined || options?.checkbox !== undefined) && (
          <div className="stack" style={{ gap: 14 }}>
            {options.checkbox !== undefined && (
              <div>
                <Checkbox checked={checked} onChange={setChecked} label={options.checkbox.label} />
                {options.checkbox.hint !== undefined && <p className="field__hint" style={{ marginLeft: 22, marginTop: 2 }}>{options.checkbox.hint}</p>}
              </div>
            )}
            {options.typeToConfirm !== undefined && (
              <Field label={t(m.common.typeToConfirm, { value: options.typeToConfirm })}>
                <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus autoComplete="off" spellCheck={false} />
              </Field>
            )}
          </div>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (options: ConfirmOptions) => Promise<ConfirmResult> {
  const value = useContext(ConfirmContext);
  if (value === null) throw new Error('useConfirm must be used inside ConfirmProvider');
  return value;
}
