'use client';

import { Alert, Button, TextField } from '@tm/ui';
import { useState, type FormEvent } from 'react';
import { authClient } from '@/lib/auth-client';

/** Change the password, for instance after the operator gave a temporary one (ADR 0036). */
export function ChangePassword() {
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get('newPassword'));
    if (newPassword !== String(form.get('confirmPassword'))) {
      setError('The new passwords do not match.');
      return;
    }
    setPending(true);
    setError(undefined);
    setDone(false);
    const { error } = await authClient.changePassword({
      currentPassword: String(form.get('currentPassword')),
      newPassword,
      revokeOtherSessions: true,
    });
    setPending(false);
    if (error) {
      setError(error.message ?? 'The password could not be changed. Try again.');
      return;
    }
    formElement.reset();
    setDone(true);
  }

  return (
    <form className="max-w-md space-y-4" onSubmit={onSubmit} aria-label="Change password">
      <TextField
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
      />
      <TextField
        label="New password (at least 12 characters)"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
      />
      <TextField
        label="New password again"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
      />
      {error && <Alert>{error}</Alert>}
      {done && (
        <p role="status" className="text-sm">
          Password changed. Your other sessions were signed out.
        </p>
      )}
      <Button variant="primary" type="submit" disabled={pending}>
        {pending ? 'Changing…' : 'Change password'}
      </Button>
    </form>
  );
}
