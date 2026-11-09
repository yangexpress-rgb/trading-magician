'use client';

import { ApiError } from '@tm/contracts';
import { Alert, Button, Dialog, TextField } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';

/** Retire with a reason. The entry stays listed, badged Retired, and keeps its number. */
export function RetireButton({
  registrationNumber,
  rowVersion,
}: {
  registrationNumber: string;
  rowVersion: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function retire() {
    setPending(true);
    setError(undefined);
    try {
      await apiClient.library.retire(registrationNumber, { reason, rowVersion });
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.body.issues?.[0]?.message ?? e.message)
          : 'Could not retire it. Try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Retire
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Retire ${registrationNumber}`}
        description="The entry stays visible with a Retired badge and keeps its number for good. A theory that comes back is registered again under a new number."
      >
        <form action={retire} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <TextField
            label="Reason"
            name="retire-reason"
            required
            maxLength={500}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={pending || !reason.trim()}>
              {pending ? 'Retiring…' : 'Retire entry'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
