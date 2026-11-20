/**
 * Page chrome. A page is a header on the canvas (its mark, title,
 * description and actions) followed by cards, each with its own title,
 * description and footer. Every page is built from these two, so every
 * page reads the same way: what this is, what you can do here, then the
 * details.
 */
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '../i18n/index.tsx';
import { Button } from './ui.tsx';

/** Where a page nested in a layout's frame (settings) puts its header buttons. */
const ActionsSlot = createContext<HTMLElement | null>(null);

export function FrameActions({ children }: { children: ReactNode }) {
  const node = useContext(ActionsSlot);
  return node === null ? null : createPortal(children, node);
}

export function Frame({
  icon,
  mark,
  title,
  description,
  actions,
  head,
  slot = false,
  children,
}: {
  icon?: ReactNode;
  /** A ready-made mark (a project's initial, a brand tile) shown in place of the icon tile. */
  mark?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Replaces the standard title row (resource pages draw their own). */
  head?: ReactNode;
  /** Let pages rendered inside place buttons in the header with <FrameActions>. */
  slot?: boolean;
  children: ReactNode;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <ActionsSlot.Provider value={node}>
    <section className="frame">
      <div className="frame__sheet">
        {head ?? (
          <header className="frame__head">
            {mark ??
              (icon !== undefined && (
                <span className="frame__icon" aria-hidden="true">
                  {icon}
                </span>
              ))}
            <div className="frame__title">
              <h1>{title}</h1>
              {description !== undefined && description !== null && <p>{description}</p>}
            </div>
            {actions !== undefined && <div className="frame__actions">{actions}</div>}
            {slot && <div className="frame__actions" ref={setNode} />}
          </header>
        )}
        <div className="frame__body">{children}</div>
      </div>
    </section>
    </ActionsSlot.Provider>
  );
}

export function Card({
  id,
  title,
  description,
  icon,
  actions,
  footer,
  tone,
  flush = false,
  children,
}: {
  /** An anchor, for pages that list their sections. */
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  tone?: 'bad';
  /** Content runs edge to edge (lists, tables). */
  flush?: boolean;
  children?: ReactNode;
}) {
  const hasHead = title !== undefined || actions !== undefined;
  return (
    <section className="card" data-tone={tone} id={id}>
      {hasHead && (
        <header className="card__head">
          {icon !== undefined && <span className="card__icon">{icon}</span>}
          <div className="card__heading">
            {title !== undefined && <h2 className="card__title">{title}</h2>}
            {description !== undefined && description !== null && <p className="card__desc">{description}</p>}
          </div>
          {actions !== undefined && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>}
      {footer !== undefined && <footer className="card__foot">{footer}</footer>}
    </section>
  );
}

/**
 * A card footer for a form. It is not there until something changes: then
 * the card grows a bar with what saving means, "discard" and "save". A page
 * of untouched settings stays a page of settings, not a column of buttons.
 */
export function SaveFooter({ dirty, saving, onSave, onReset, note, label }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; note?: ReactNode; label?: string }) {
  const { m } = useI18n();
  if (!dirty && !saving) return null;
  return (
    <>
      <span className="card__foot-note">{note ?? m.common.unsavedChanges}</span>
      <Button variant="ghost" onClick={onReset} disabled={saving}>
        {m.common.discard}
      </Button>
      <Button variant="primary" busy={saving} onClick={onSave}>
        {label ?? m.common.save}
      </Button>
    </>
  );
}

/**
 * A part of a card that folds away: settings most people never touch, kept
 * out of the way but plainly there. The closed row says what is inside and
 * whether any of it has been changed, so nobody has to open it to find out.
 */
export function Fold({
  icon,
  title,
  hint,
  badge,
  open,
  onToggle,
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  /** Shown at the right of the row, open or closed (a count of what is set inside). */
  badge?: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="fold" data-open={open || undefined}>
      <button type="button" className="fold__head" aria-expanded={open} aria-controls={id} onClick={() => onToggle(!open)}>
        {icon !== undefined && (
          <span className="fold__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="fold__text">
          <span className="fold__title">{title}</span>
          {hint !== undefined && <span className="fold__hint">{hint}</span>}
        </span>
        {badge}
        <span className="fold__chevron" aria-hidden="true">
          <ChevronDown />
        </span>
      </button>
      {/* Kept mounted so what was typed survives a close; inert so the keyboard does not wander into what is hidden. */}
      <div className="fold__wrap" id={id} inert={!open}>
        <div className="fold__clip">
          <div className="fold__body">{children}</div>
        </div>
      </div>
    </section>
  );
}
