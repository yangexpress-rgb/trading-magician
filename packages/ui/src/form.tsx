import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cx } from './cx';

const box =
  'mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm placeholder:text-ink-muted aria-[invalid=true]:border-danger';
/** A text field shows what is typed as content (brief v2.2 D4, N129). */
const control = `${box} text-content`;
/** A select shows the app's own choices: interface ink. */
const selectControl = `${box} text-ink`;

interface FieldShell {
  label: ReactNode;
  name: string;
  error?: string | undefined;
  hint?: ReactNode;
}

function Shell({ label, name, error, hint, children }: FieldShell & { children: ReactNode }) {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-semibold text-ink-muted">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (name: string, error?: string, hint?: ReactNode) =>
  error ? `${name}-error` : hint ? `${name}-hint` : undefined;

export function TextField({
  label,
  name,
  error,
  hint,
  className,
  ...input
}: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Shell label={label} name={name} error={error} hint={hint}>
      <input
        id={name}
        name={name}
        aria-invalid={!!error}
        aria-describedby={describedBy(name, error, hint)}
        className={cx(control, className)}
        {...input}
      />
    </Shell>
  );
}

export function SelectField({
  label,
  name,
  error,
  hint,
  className,
  children,
  ...select
}: FieldShell & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Shell label={label} name={name} error={error} hint={hint}>
      <select
        id={name}
        name={name}
        aria-invalid={!!error}
        aria-describedby={describedBy(name, error, hint)}
        className={cx(selectControl, className)}
        {...select}
      >
        {children}
      </select>
    </Shell>
  );
}

export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'ok' | 'info' | 'warn';
  children: ReactNode;
}) {
  const styles = {
    danger: 'border-danger/40 bg-danger-soft text-danger',
    ok: 'border-ok/40 bg-ok-soft text-ok',
    info: 'border-info/40 bg-info-soft text-info',
    warn: 'border-warn/40 bg-warn-soft text-warn',
  }[tone];
  return (
    <p
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('rounded-md border px-3 py-2 text-sm font-medium', styles)}
    >
      {children}
    </p>
  );
}
