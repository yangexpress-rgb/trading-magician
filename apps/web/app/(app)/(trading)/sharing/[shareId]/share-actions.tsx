'use client';

import { ApiError } from '@tm/contracts';
import { Alert, Button } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';

/** Accept or decline (the recipient), or withdraw (the sender), a pending share. */
export function ShareActions({ id, role }: { id: string; role: 'sender' | 'recipient' }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await action();
      if (next) router.push(next);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        {role === 'recipient' ? (
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await apiClient.shares.accept(id);
                  return r.strategyId ? `/strategy-lab/${r.strategyId}` : `/library/${r.number}`;
                })
              }
            >
              {busy ? 'Working…' : 'Accept and make my copy'}
            </Button>
            <Button
              disabled={busy}
              onClick={() => run(async () => (await apiClient.shares.decline(id), null))}
            >
              Decline
            </Button>
          </>
        ) : (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => run(async () => (await apiClient.shares.withdraw(id), null))}
          >
            Withdraw
          </Button>
        )}
      </div>
    </div>
  );
}
