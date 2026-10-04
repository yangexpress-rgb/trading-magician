import type { InputHTMLAttributes } from 'react';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
  error?: string | undefined;
}

export function Field({ label, name, error, ...input }: FieldProps) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} aria-invalid={!!error} aria-describedby={errorId} {...input} />
      {error && (
        <p id={errorId} className="error">
          {error}
        </p>
      )}
    </div>
  );
}
