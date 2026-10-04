/**
 * Page chrome in Dokploy's shape. A page sits in a muted frame holding one
 * raised sheet (title, description, actions, then content); inside the
 * sheet, content is grouped into cards with their own title, description
 * and footer. Every page is built from these two, so every page reads the
 * same way: what this is, what you can do here, then the details.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  title,
  description,
  actions,
  head,
  slot = false,
  children,
}: {
  icon?: ReactNode;
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
            <div className="frame__title">
              <h1>
                {icon}
                {title}
              </h1>
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
  title,
  description,
  icon,
  actions,
  footer,
  tone,
  flush = false,
  children,
}: {
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
    <section className="card" data-tone={tone}>
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

/** A card footer for a form: discard while there are changes, save when there are. */
export function SaveFooter({ dirty, saving, onSave, onReset, note, label }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void; note?: ReactNode; label?: string }) {
  const { m } = useI18n();
  return (
    <>
      {note !== undefined && <span className="card__foot-note">{note}</span>}
      {dirty && (
        <Button variant="ghost" onClick={onReset}>
          {m.common.discard}
        </Button>
      )}
      <Button variant="primary" disabled={!dirty} busy={saving} onClick={onSave}>
        {label ?? m.common.save}
      </Button>
    </>
  );
}
