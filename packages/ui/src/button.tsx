import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink border-accent hover:opacity-90',
  secondary: 'bg-surface text-ink border-line hover:bg-surface-2',
  danger: 'bg-surface text-danger border-danger hover:bg-danger-soft',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-surface-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}

export function buttonClasses(variant: ButtonVariant = 'secondary', size: 'sm' | 'md' = 'md') {
  return cx(
    'inline-flex items-center justify-center gap-2 rounded-md border font-medium transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-60',
    size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
    variants[variant],
  );
}

export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cx(buttonClasses(variant, size), className)} {...props} />;
}
