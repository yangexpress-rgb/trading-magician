'use client';

import { useId } from 'react';
import { accountText } from './account-label';

interface Account {
  id: string;
  nickname: string;
  mode: 'paper' | 'live';
}

/**
 * "All accounts" or one account (N309), on Orders and Performance. Each entry says
 * PAPER or LIVE in words; live accounts get their own group.
 */
export function AccountSwitcher({
  accounts,
  value,
  onChange,
  label = 'Account',
}: {
  accounts: { paper: readonly Account[]; live: readonly Account[] };
  value: string | undefined;
  onChange: (accountId: string | undefined) => void;
  label?: string;
}) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <label htmlFor={id} className="font-medium text-ink-muted">
        {label}
      </label>
      <select
        id={id}
        name="account"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
      >
        <option value="">All accounts</option>
        {accounts.paper.length > 0 && (
          <optgroup label="Paper">
            {accounts.paper.map((a) => (
              <option key={a.id} value={a.id}>
                {accountText(a.nickname, a.mode)}
              </option>
            ))}
          </optgroup>
        )}
        {accounts.live.length > 0 && (
          <optgroup label="Live">
            {accounts.live.map((a) => (
              <option key={a.id} value={a.id}>
                {accountText(a.nickname, a.mode)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </span>
  );
}
