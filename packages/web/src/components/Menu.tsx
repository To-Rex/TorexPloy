/**
 * Dropdown menu: positioned against its trigger, keyboard navigable
 * (arrows, Home/End, Esc), closes on outside click and returns focus.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';

interface TriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
}

const CloseContext = createContext<() => void>(() => undefined);

export function Menu({ trigger, children, align = 'end', label }: { trigger: (props: TriggerProps) => ReactNode; children: ReactNode; align?: 'start' | 'end'; label?: string }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || triggerRef.current === null || menuRef.current === null) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    let left = align === 'end' ? anchor.right - menu.width : anchor.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menu.width - 8));
    let top = anchor.bottom + 6;
    if (top + menu.height > window.innerHeight - 8) top = Math.max(8, anchor.top - menu.height - 6);
    setPosition({ top, left });
    menuRef.current.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, close]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      {trigger({ ref: triggerRef, onClick: () => setOpen((value) => !value), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="menu"
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            style={position === null ? { visibility: 'hidden', top: 0, left: 0 } : { top: position.top, left: position.left }}
          >
            <CloseContext.Provider value={() => close()}>{children}</CloseContext.Provider>
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({ icon, children, onSelect, danger = false, disabled = false, href }: { icon?: ReactNode; children: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean; href?: string }) {
  const close = useContext(CloseContext);
  if (href !== undefined) {
    return (
      <a className="menu__item" role="menuitem" href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer noopener" onClick={close} tabIndex={-1}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      className="menu__item"
      role="menuitem"
      tabIndex={-1}
      data-danger={danger || undefined}
      disabled={disabled}
      onClick={() => {
        close();
        onSelect?.();
      }}
    >
      {icon}
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu__sep" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="menu__label">{children}</div>;
}
