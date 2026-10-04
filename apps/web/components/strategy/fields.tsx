'use client';

import { cx } from '@tm/ui';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

/**
 * Compact labelled controls for dense editor rows. Each has a visible label,
 * and an error is linked to the control with aria-describedby.
 */

const control =
  'mt-0.5 block w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink aria-[invalid=true]:border-danger disabled:opacity-70';

function Wrap({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  error?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-ink-muted">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-0.5 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function MiniSelect({
  id,
  label,
  error,
  className,
  children,
  ...select
}: {
  id: string;
  label: ReactNode;
  error?: string | undefined;
  className?: string;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <Wrap id={id} label={label} error={error} className={className}>
      <select
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={control}
        {...select}
      >
        {children}
      </select>
    </Wrap>
  );
}

export function MiniInput({
  id,
  label,
  error,
  className,
  ...input
}: {
  id: string;
  label: ReactNode;
  error?: string | undefined;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Wrap id={id} label={label} error={error} className={className}>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={control}
        {...input}
      />
    </Wrap>
  );
}

/** Small icon-free text button for row actions; always has an accessible name. */
export function RowButton({
  label,
  children,
  className,
  ...button
}: { label: string; children: ReactNode; className?: string } & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'rounded border border-transparent px-1.5 py-0.5 text-xs font-medium text-ink-muted hover:border-line hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
      {...button}
    >
      {children}
    </button>
  );
}
