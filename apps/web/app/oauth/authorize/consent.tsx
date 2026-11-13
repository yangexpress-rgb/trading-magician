'use client';

import { Alert, Button } from '@tm/ui';
import { useState, useTransition } from 'react';
import { answerConsent } from './actions';

type Scope = 'read' | 'operate';

/**
 * Approve or Deny (N263). The answer comes back as a URL and the browser goes
 * there itself, so the agent's redirect is a navigation, not a form post.
 */
export function Consent({
  params,
  agent,
  clientName,
  email,
  operateRequested,
  scopes,
}: {
  params: Record<string, string | undefined>;
  agent: string;
  clientName: string;
  email: string;
  operateRequested: boolean;
  scopes: Record<Scope, { label: string; detail: string }>;
}) {
  const [scope, setScope] = useState<Scope>('read');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const answer = (approve: boolean) =>
    start(async () => {
      const r = await answerConsent(params, { approve, scope });
      if ('redirect' in r) window.location.assign(r.redirect);
      else setError(r.error);
    });
  const offered: Scope[] = operateRequested ? ['read', 'operate'] : ['read'];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Connect {agent} to Trading Magician?</h1>
      <p className="text-sm">
        <span className="font-semibold">{clientName}</span> asks to work in your account (
        <span className="text-content">{email}</span>) as you, through Trading Magician’s MCP
        connection.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-ink-muted">What it may do</legend>
        {offered.map((s) => (
          <label key={s} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              value={s}
              checked={scope === s}
              onChange={() => setScope(s)}
              className="mt-1"
            />
            <span>
              <span className="font-semibold">{scopes[s].label}</span>
              <span className="block text-ink-muted">{scopes[s].detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-ink-muted">
        It can never start strategies, place or cancel orders, share, delete, or change billing,
        keys or data feeds. You can revoke it any time in Settings › AI agents, where everything it
        does is listed.
      </p>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={pending} onClick={() => answer(true)}>
          Approve
        </Button>
        <Button disabled={pending} onClick={() => answer(false)}>
          Deny
        </Button>
      </div>
    </div>
  );
}

export function ConsentFailed({ message, redirect }: { message: string; redirect: string }) {
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">This sign-in can’t continue</h1>
      <p className="text-sm">{message}</p>
      <Button onClick={() => window.location.assign(redirect)}>Back to the agent</Button>
    </div>
  );
}
