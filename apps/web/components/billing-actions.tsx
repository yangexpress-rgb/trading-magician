'use client';

import { ApiError } from '@tm/contracts';
import { Alert, Button } from '@tm/ui';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * Settings › Subscription and billing buttons (ADR 0023): buying a plan goes
 * to the provider's hosted checkout, and changing or cancelling one to its
 * portal. Card details never pass through the app.
 */
export function BillingActions({
  upgrades,
  canManage,
}: {
  upgrades: { code: string; name: string }[];
  canManage: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go(key: string, open: () => Promise<{ url: string }>) {
    setBusy(key);
    setError(null);
    try {
      const { url } = await open();
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Billing could not be opened. Try again.');
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        {upgrades.map((p) => (
          <Button
            key={p.code}
            variant="primary"
            disabled={busy !== null}
            onClick={() => void go(p.code, () => apiClient.billing.checkout({ planCode: p.code }))}
          >
            {busy === p.code ? 'Opening checkout…' : `Upgrade to ${p.name}`}
          </Button>
        ))}
        {canManage && (
          <Button
            disabled={busy !== null}
            onClick={() => void go('portal', () => apiClient.billing.portal())}
          >
            {busy === 'portal' ? 'Opening…' : 'Manage billing'}
          </Button>
        )}
      </div>
    </div>
  );
}
