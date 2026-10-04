'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Field } from '@/components/form-field';
import { authClient } from '@/lib/auth-client';

export function DeleteAccount() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get('confirm') !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }
    setPending(true);
    const { error } = await authClient.deleteUser({ password: String(form.get('password')) });
    setPending(false);
    if (error) {
      setError(error.message ?? 'Could not delete the account.');
      return;
    }
    router.push('/sign-in?deleted=1');
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" className="danger" onClick={() => setOpen(true)}>
        Delete account…
      </button>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit} aria-label="Delete account">
      <p>
        This permanently deletes your strategies, settings and connections. It cannot be undone.
      </p>
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <Field label="Type DELETE to confirm" name="confirm" autoComplete="off" required />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" className="danger" disabled={pending}>
        Permanently delete my account
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
