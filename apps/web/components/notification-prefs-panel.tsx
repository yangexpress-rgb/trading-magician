'use client';

import {
  ALWAYS_SHOWN_NOTIFICATION_KINDS,
  ApiError,
  NOTIFICATION_KINDS,
  type NotificationKindDto,
} from '@tm/contracts';
import { Alert, Button } from '@tm/ui';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/** What each kind is about, in the person's words (§16.3). */
const KIND_TEXT: Record<NotificationKindDto, string> = {
  strategy_started: 'A strategy starts',
  strategy_stopped: 'A strategy stops',
  triggered: 'Entry or Exit rules trigger',
  order_rejected: 'An order is rejected',
  partial_fill: 'An order is partly filled',
  filled: 'An order is filled',
  stale_data: 'Prices go stale',
  disconnect: 'A data feed or trading platform stops responding',
  risk_pause: 'A strategy is paused for safety',
  reconciliation_mismatch: 'Orders or positions disagree with the broker',
  billing: 'Your plan or payment changes',
  share_received: 'Someone shares a theory or strategy with you',
  share_accepted: 'Someone accepts a theory or strategy you shared',
  share_declined: 'Someone declines a theory or strategy you shared',
};

const isLocked = (kind: NotificationKindDto) =>
  (ALWAYS_SHOWN_NOTIFICATION_KINDS as readonly string[]).includes(kind);

/**
 * Settings › Notifications and security: which in-app notifications to show
 * (Phase 4 decision 4). Kinds that stop trading always show.
 */
export function NotificationPrefsPanel() {
  const [muted, setMuted] = useState<Set<NotificationKindDto> | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient.notifications.prefs().then(
      (p) => setMuted(new Set(p.muted)),
      () => setError('Could not load notification preferences.'),
    );
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!muted) return;
    setStatus('saving');
    try {
      const saved = await apiClient.notifications.updatePrefs({ muted: [...muted] });
      setMuted(new Set(saved.muted));
      setError(null);
      setStatus('saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save notification preferences.');
      setStatus('idle');
    }
  }

  if (!muted) {
    return error ? <Alert>{error}</Alert> : <p className="text-sm">Loading preferences…</p>;
  }
  return (
    <form onSubmit={(e) => void save(e)} className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <fieldset>
        <legend className="text-sm font-medium">Show an in-app notification when</legend>
        <ul className="mt-2 space-y-2">
          {NOTIFICATION_KINDS.map((kind) => {
            const locked = isLocked(kind);
            const id = `notify-${kind}`;
            return (
              <li key={kind} className="flex items-start gap-2 text-sm">
                <input
                  id={id}
                  type="checkbox"
                  className="mt-1"
                  checked={locked || !muted.has(kind)}
                  disabled={locked}
                  aria-describedby={locked ? 'notify-locked' : undefined}
                  onChange={(e) => {
                    const next = new Set(muted);
                    if (e.target.checked) next.delete(kind);
                    else next.add(kind);
                    setMuted(next);
                    setStatus('idle');
                  }}
                />
                <label htmlFor={id}>
                  {KIND_TEXT[kind]}
                  {locked && <span className="text-ink-muted"> (always shown)</span>}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p id="notify-locked" className="text-xs text-ink-muted">
        Safety pauses, broker mismatches, disconnects and billing changes always show because they
        can stop trading. Notifications are in-app only for now.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save notification preferences'}
        </Button>
        {status === 'saved' && (
          <span role="status" className="text-sm text-ok">
            Saved.
          </span>
        )}
      </div>
    </form>
  );
}
