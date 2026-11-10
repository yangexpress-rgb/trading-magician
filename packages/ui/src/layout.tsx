import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export function PageHeader({
  title,
  subtitle,
  description,
  actions,
}: {
  title: ReactNode;
  /** A line under the title, such as the theory a strategy refers to. */
  subtitle?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle}
        {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface p-5', className)} {...rest}>
      {children}
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line bg-surface px-6 py-12 text-center">
      {icon && <div className="mb-3 text-3xl text-ink-muted">{icon}</div>}
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-2 max-w-md text-sm text-ink-muted">{children}</div>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
