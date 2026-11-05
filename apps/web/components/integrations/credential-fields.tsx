'use client';

import { isProviderId, PROVIDERS } from '@tm/domain';
import { TextField } from '@tm/ui';

/**
 * Write-only inputs for a provider's credential (§15.4). Values live in
 * component state only until they are sent, then the caller clears them; they
 * are never put in the address, local storage or logs, and the browser is
 * asked not to remember them.
 */
export function CredentialFields({
  provider,
  idPrefix,
  values,
  onChange,
  hint,
  errors = {},
}: {
  provider: string;
  idPrefix: string;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  /** Masked tails of the stored value, when replacing one. */
  hint?: Record<string, string> | undefined;
  errors?: Record<string, string>;
}) {
  if (!isProviderId(provider)) return null;
  return (
    <>
      {PROVIDERS[provider].credentialFields.map((field) => (
        <TextField
          key={field.name}
          name={`${idPrefix}-${field.name}`}
          label={field.label}
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          value={values[field.name] ?? ''}
          onChange={(e) => onChange({ ...values, [field.name]: e.target.value })}
          error={errors[field.name]}
          hint={
            hint?.[field.name]
              ? `Saved value ends ${hint[field.name]?.replace(/^•+/, '') || 'with hidden characters'}. Enter the new value.`
              : field.help
          }
        />
      ))}
    </>
  );
}
