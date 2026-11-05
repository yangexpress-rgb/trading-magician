'use client';

import { Alert, Button, TextField } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
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
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete account…
      </Button>
    );
  }

  return (
    <form className="max-w-md space-y-4" onSubmit={onSubmit} aria-label="Delete account">
      <p className="text-sm">
        This permanently deletes your strategies, settings and connections. It cannot be undone.
      </p>
      <TextField
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <TextField label="Type DELETE to confirm" name="confirm" autoComplete="off" required />
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          Permanently delete my account
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
