'use client';

import type { CompanionSummary } from '@tm/db';
import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import { Alert, Badge, Button } from '@tm/ui';
import { useState, useTransition } from 'react';
import { pairResearchCompanion, unpairResearchCompanion } from './actions';

/**
 * Settings › Local research storage (ADR 0116): one clear action and a plain
 * status; the token and the API address sit in a collapsed Advanced layer.
 */
export function CompanionPanel({
  companions,
  apiBase,
  prefs,
}: {
  companions: CompanionSummary[];
  apiBase: string;
  prefs: DisplayPreferences;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const active = companions.filter((c) => c.connection.status === 'active');
  const when = (iso: string) =>
    formatDateTime(iso, prefs, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="space-y-4">
      {active.length === 0 ? (
        <p className="text-sm">No companion is paired with your account.</p>
      ) : (
        <ul className="space-y-3">
          {active.map((c) => (
            <li key={c.connection.id} className="flex flex-wrap items-center gap-3">
              <Badge tone={c.seenAt ? 'ok' : 'neutral'}>
                {c.seenAt ? 'Paired' : 'Waiting for the companion'}
              </Badge>
              <span className="text-sm">
                {c.seenAt
                  ? `Last seen ${when(c.seenAt)}`
                  : `Paired ${when(c.connection.createdAt)}`}
                {c.lastPushAt ? ` · last delivered ${when(c.lastPushAt)}` : ''}
              </span>
              <Button
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => start(() => unpairResearchCompanion(c.connection.id))}
              >
                Unpair
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await pairResearchCompanion();
              if (r.ok) setToken(r.token);
              else setError(r.message);
            })
          }
        >
          Pair a companion
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {token && (
        <Alert tone="info">
          <p>
            Pairing code made. Give it to the companion when it asks; it is shown only this once.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-surface-sunken px-2 py-1 text-xs break-all">{token}</code>
            <Button
              size="sm"
              type="button"
              onClick={async () => {
                await navigator.clipboard?.writeText(token);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Alert>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted">Advanced</summary>
        <dl className="mt-2 space-y-1">
          <div>
            <dt className="inline text-ink-muted">Companion API: </dt>
            <dd className="inline">
              <code>{apiBase}</code>
            </dd>
          </div>
          {active.map((c) => (
            <div key={c.connection.id}>
              <dt className="inline text-ink-muted">{c.connection.tokenHint ?? 'Token'}: </dt>
              <dd className="inline">
                {c.version ? `version ${c.version}, ${c.platform}` : 'not seen yet'}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
