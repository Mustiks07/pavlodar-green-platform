import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './Icon';
import { tUi } from '../i18n';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  /** Busy keeps the label visible and blocks double submit; it is not a success state. */
  busy?: boolean;
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, busy = false, iconOnly = false, className, children, disabled, type, ...rest },
  ref,
) {
  const cls = ['pg-btn', `pg-btn--${variant}`, `pg-btn--${size}`, iconOnly && 'pg-btn--icon', busy && 'is-busy', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cls}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="pg-spinner" aria-hidden /> : icon ? <Icon name={icon} /> : null}
      {iconOnly ? null : <span className="pg-btn__label">{children}</span>}
    </button>
  );
});

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, hint and validation message wired by id; errors are announced, not color-only. */
export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={error ? 'pg-field is-invalid' : 'pg-field'}>
      <label className="pg-field__label" htmlFor={id}>
        {label}
        {required ? <span className="pg-field__req" aria-hidden> *</span> : null}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p className="pg-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="pg-field__error" id={errId} role="alert">
          <Icon name="error" /> {error}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={className ? `pg-input ${className}` : 'pg-input'} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <span className="pg-select">
      <select ref={ref} className={className ? `pg-input ${className}` : 'pg-input'} {...rest}>
        {children}
      </select>
      <Icon name="chevronDown" className="pg-select__chevron" />
    </span>
  );
});

export type Tone = 'neutral' | 'positive' | 'negative' | 'warning' | 'info' | 'accent';

export function Badge({ tone = 'neutral', icon, children, title }: { tone?: Tone; icon?: IconName; children: ReactNode; title?: string }) {
  return (
    <span className={`pg-badge pg-badge--${tone}`} title={title}>
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  );
}

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Native modal dialog: focus containment and Escape come from the platform. */
export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="pg-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="pg-dialog__head">
        <h2 id={titleId}>{title}</h2>
        <Button variant="ghost" icon="x" iconOnly aria-label={tUi('dialog.close')} onClick={onClose} />
      </header>
      <div className="pg-dialog__body">{children}</div>
      {footer ? <footer className="pg-dialog__foot">{footer}</footer> : null}
    </dialog>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="pg-sr-only">{children}</span>;
}
