'use client';

import { Alert, Button, TextField } from '@tm/ui';
import { useActionState, useState } from 'react';
import { deleteAccount, type DeleteAccountState } from './actions';

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<DeleteAccountState, FormData>(deleteAccount, {
    status: 'idle',
  });

  if (!open) {
    return (
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete account…
      </Button>
    );
  }

  return (
    <form className="max-w-md space-y-4" action={action} aria-label="Delete account">
      <p className="text-sm">
        Deleting your account stops your running strategies and cancels their working orders, and
        signs you out everywhere. You can't sign in again. After 30 days your strategies, settings,
        keys and back tests are erased; order and audit records are kept without your personal
        details. It cannot be undone.
      </p>
      <TextField
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <TextField label="Type DELETE to confirm" name="confirm" autoComplete="off" required />
      {state.status === 'error' && <Alert>{state.message}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          Permanently delete my account
        </Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
