/**
 * Primitive controls. Thin wrappers over native elements: they add the
 * design-system classes and accessibility wiring, never behaviour the
 * browser already provides.
 */
import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  iconOnly?: boolean;
  busy?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconOnly = false, busy = false, block = false, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const classes = [
    'btn',
    variant !== 'secondary' && `btn--${variant}`,
    size === 'sm' && 'btn--sm',
    iconOnly && 'btn--icon',
    block && 'btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {icon}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
    </button>
  );
});

/** A link styled as a button (navigation, not action). */
export function ButtonLink({ href, variant = 'secondary', size = 'md', icon, children, external = false }: { href: string; variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode; children: ReactNode; external?: boolean }) {
  return (
    <a
      href={href}
      className={['btn', variant !== 'secondary' && `btn--${variant}`, size === 'sm' && 'btn--sm'].filter(Boolean).join(' ')}
      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      style={{ textDecoration: 'none' }}
    >
      {icon}
      {children}
    </a>
  );
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  optional?: string;
  children: ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
  className?: string;
}

/** Label + control + hint/error, with ids wired for assistive technology. */
export function Field({ label, hint, error, optional, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const describedBy = error !== undefined || hint !== undefined ? hintId : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id, 'aria-invalid': error !== undefined ? true : undefined, ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }) })
    : children;
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label className="field__label" htmlFor={id}>
        {label}
        {optional !== undefined && <span className="faint" style={{ fontWeight: 400 }}> ({optional})</span>}
      </label>
      {control}
      {error !== undefined ? (
        <p className="field__error" id={hintId} role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} className={['input', mono && 'input--mono', className].filter(Boolean).join(' ')} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea({ className, mono, ...rest }, ref) {
  return <textarea ref={ref} className={['textarea', mono && 'input--mono', className].filter(Boolean).join(' ')} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={['select', className].filter(Boolean).join(' ')} {...rest} />;
});

export function Switch({ checked, onChange, label, hint, disabled, hideLabel = false }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; hideLabel?: boolean }) {
  return (
    <label className="switch" style={{ alignItems: hint === undefined ? 'center' : 'flex-start' }}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} style={hint === undefined ? undefined : { marginTop: 2 }} />
      <span className={hideLabel ? 'sr-only' : undefined}>
        <span style={{ display: 'block', fontWeight: 540 }}>{label}</span>
        {hint !== undefined && <span className="field__hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="row" style={{ gap: 9, cursor: 'pointer', alignItems: 'flex-start' }}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} style={{ marginTop: 3, accentColor: 'var(--lapis)' }} />
      <span>
        <span style={{ display: 'block' }}>{label}</span>
        {hint !== undefined && <span className="field__hint">{hint}</span>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode; icon?: ReactNode }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type Tone = 'ok' | 'work' | 'bad' | 'idle' | 'info';

export function Badge({ tone, children, icon }: { tone?: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}

const CALLOUT_ICONS: Record<Tone, ReactNode> = {
  ok: <CircleCheck />,
  work: <TriangleAlert />,
  bad: <CircleAlert />,
  idle: <Info />,
  info: <Info />,
};

export function Callout({ tone = 'info', title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="callout" data-tone={tone} role={tone === 'bad' ? 'alert' : undefined}>
      {CALLOUT_ICONS[tone]}
      <div className="callout__body">
        {title !== undefined && <p style={{ fontWeight: 600 }}>{title}</p>}
        {children !== undefined && <div className={title === undefined ? undefined : 'muted'}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      {title !== undefined && <h2>{title}</h2>}
      {children !== undefined && <p>{children}</p>}
      {action !== undefined && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14, style }: { width?: number | string; height?: number | string; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width, height, ...style }} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="list" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="list__row" key={index}>
          <Skeleton width={28} height={28} style={{ borderRadius: 8 }} />
          <div className="grow" style={{ display: 'grid', gap: 6 }}>
            <Skeleton width={`${30 + ((index * 17) % 30)}%`} />
            <Skeleton width={`${18 + ((index * 11) % 20)}%`} height={11} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Avatar({ name, src, size = 28 }: { name: string; src?: string | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.max(10, size * 0.42) }} aria-hidden="true">
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" /> : initials}
    </span>
  );
}

/** GitHub's mark, for the integration (Lucide no longer ships brand icons). */
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** The TorexPloy mark: two rising chevrons over a launch bar. */
/**
 * The TorexPloy mark. It is `public/favicon.svg`, the same file the browser
 * tab shows, so replacing that one file changes the logo everywhere: tab,
 * sidebar, sign-in pages, loading screen.
 */
export function BrandMark({ size = 28, tile = false }: { size?: number; tile?: boolean }) {
  return <img className={tile ? 'brand-mark brand-mark--tile' : 'brand-mark'} src="/favicon.svg" width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
