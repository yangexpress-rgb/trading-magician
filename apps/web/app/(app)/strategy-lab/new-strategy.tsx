'use client';

import { ApiError } from '@tm/contracts';
import { Alert, Button, Dialog, TextField } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';

export function NewStrategyButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function create(form: FormData) {
    setPending(true);
    setError(undefined);
    try {
      const strategy = await apiClient.strategies.create({
        name: String(form.get('new-strategy-name') ?? ''),
        description: String(form.get('new-strategy-description') ?? ''),
      });
      router.push(`/strategy-lab/${strategy.id}`);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.body.issues?.[0]?.message ?? e.message)
          : 'Could not create the strategy. Try again.',
      );
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New strategy
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New strategy"
        description="It starts as a draft with the default paper risk limits. You can change everything later."
      >
        <form action={create} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <TextField label="Name" name="new-strategy-name" required maxLength={120} autoFocus />
          <TextField
            label="Description (optional)"
            name="new-strategy-description"
            maxLength={2000}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Creating…' : 'Create strategy'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
