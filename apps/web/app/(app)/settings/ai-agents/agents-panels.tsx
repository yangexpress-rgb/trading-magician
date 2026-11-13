'use client';

import type { AgentCallSummary, AgentConnectionSummary } from '@tm/db';
import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import { Alert, Badge, Button, cx, SelectField, Table, Td, TextField, Th } from '@tm/ui';
import { useActionState, useState, useTransition } from 'react';
import { fillTemplate, profileName, SCOPE_TEXT, type AgentProfile } from '@/lib/agents/profiles';
import {
  connectWithKey,
  disconnectAgent,
  mintAgentToken,
  revokeAgent,
  type MintTokenState,
} from './actions';

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      type="button"
      onClick={async () => {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink-muted">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto rounded-md border border-line bg-surface-2 p-3 text-xs whitespace-pre-wrap break-all text-content">
        {text}
      </pre>
    </div>
  );
}

const CAPABILITY = {
  read: 'Can view',
  operate: 'Can view and make changes',
} as const;

/**
 * Settings › AI agents in three layers (N271): each agent shows its name, one
 * plain line, one Connect or Disconnect button and its status; Connection
 * details and Advanced are collapsed. Only Advanced uses technical words.
 */
export function AgentList({
  profiles,
  connections,
  endpoint,
  museUrl,
  enabled,
  prefs,
}: {
  profiles: readonly AgentProfile[];
  connections: AgentConnectionSummary[];
  endpoint: string;
  museUrl: string;
  enabled: boolean;
  prefs: DisplayPreferences;
}) {
  return (
    <ul className="space-y-3">
      {profiles.map((p) => (
        <li key={p.id}>
          <AgentRow
            profile={p}
            connections={connections.filter((c) => c.profileId === p.id)}
            endpoint={endpoint}
            museUrl={museUrl}
            enabled={enabled}
            prefs={prefs}
          />
        </li>
      ))}
    </ul>
  );
}

function statusText(active: AgentConnectionSummary[]): string {
  if (active.length === 0) return 'Not connected';
  const canChange = active.some((c) => c.scope === 'operate');
  return `Connected · ${canChange ? CAPABILITY.operate : CAPABILITY.read}`;
}

function AgentRow({
  profile,
  connections,
  endpoint,
  museUrl,
  enabled,
  prefs,
}: {
  profile: AgentProfile;
  connections: AgentConnectionSummary[];
  endpoint: string;
  museUrl: string;
  enabled: boolean;
  prefs: DisplayPreferences;
}) {
  const active = connections.filter((c) => c.status === 'active');
  const connected = active.length > 0;
  const [busy, start] = useTransition();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'read' | 'operate'>('read');
  const [key, setKey] = useState<string | null>(null);
  const headingId = `agent-${profile.id}`;
  const notReady = 'Connecting agents is switched off on this server for now. Try again later.';

  const connect = () => {
    setError(null);
    if (!enabled) return setError(notReady);
    const c = profile.connect;
    if (c.kind === 'deeplink') {
      // Without 'noopener' so a blocked pop-up can be told apart; the opener is cut by hand.
      const tab = window.open(museUrl, '_blank');
      if (tab) tab.opener = null;
      if (!tab)
        setError(
          `Your browser blocked the ${profile.displayName} page. Allow pop-ups for this site and choose Connect again.`,
        );
      setStarted(true);
    } else if (c.kind === 'paste') {
      void navigator.clipboard?.writeText(endpoint).catch(() => undefined);
      window.open(c.openUrl, '_blank', 'noopener');
      setStarted(true);
    } else {
      setStarted(true);
    }
  };

  const makeKey = () =>
    start(async () => {
      setError(null);
      const r = await connectWithKey(profile.id, scope);
      if (r.ok) setKey(r.token);
      else setError(r.message);
    });

  return (
    <section
      aria-labelledby={headingId}
      className={cx('rounded-md border p-4', connected ? 'border-accent' : 'border-line')}
    >
      {/* Layer 1 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={headingId} className="font-semibold">
            {profile.displayName}
          </h3>
          <p className="text-sm text-ink-muted">{profile.plainLine}</p>
          <p className="mt-1 text-sm" data-testid="agent-status">
            {statusText(active)}
          </p>
        </div>
        {connected ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => start(() => disconnectAgent(profile.id))}
          >
            Disconnect {profile.displayName}
          </Button>
        ) : (
          <Button variant="primary" type="button" disabled={busy} onClick={connect}>
            Connect {profile.displayName}
          </Button>
        )}
      </div>
      {!connected && profile.connectNote && (
        <p className="mt-2 text-sm text-ink-muted">{profile.connectNote}</p>
      )}
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {started && !connected && profile.connect.kind === 'paste' && (
        <ol className="mt-3 ml-5 list-decimal space-y-1 text-sm">
          {profile.connect.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {started && profile.connect.kind === 'key' && !key && (
        <div className="mt-3 space-y-3">
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold">What may {profile.displayName} do?</legend>
            {(['read', 'operate'] as const).map((s) => (
              <label key={s} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`${profile.id}-capability`}
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="mt-1"
                />
                <span>
                  <span className="font-semibold">{SCOPE_TEXT[s].label}</span>
                  <span className="block text-ink-muted">{SCOPE_TEXT[s].detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Button variant="primary" type="button" disabled={busy} onClick={makeKey}>
            {busy ? 'Connecting…' : `Finish connecting ${profile.displayName}`}
          </Button>
        </div>
      )}
      {key && profile.connect.kind === 'key' && (
        <div className="mt-3 space-y-3">
          <Alert tone="warn">
            Copy this now: it is shown only once. Anyone who has it can act in your account as{' '}
            {profile.displayName} until you disconnect it.
          </Alert>
          <CopyBlock
            label={profile.connect.pasteLabel}
            text={fillTemplate(profile.snippetTemplate ?? '{token}', { endpoint, token: key })}
          />
        </div>
      )}

      {/* Layer 2 */}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold">Connection details</summary>
        <ConnectionDetails connections={connections} prefs={prefs} busy={busy} start={start} />
      </details>

      {/* Layer 3 */}
      <details className="mt-2">
        <summary className="cursor-pointer text-sm font-semibold">Advanced</summary>
        <div className="mt-3 space-y-4">
          <ol className="ml-5 list-decimal space-y-1 text-sm">
            {profile.helpSteps.map((step) => (
              <li key={step}>{fillTemplate(step, { endpoint })}</li>
            ))}
          </ol>
          <CopyBlock label="MCP endpoint URL" text={endpoint} />
          {profile.connect.kind === 'deeplink' && (
            <CopyBlock label={`${profile.displayName} connect link`} text={museUrl} />
          )}
          {(profile.authMethod === 'token' || profile.tokenFallback) && (
            <MintToken profile={profile} endpoint={endpoint} enabled={enabled} />
          )}
        </div>
      </details>
    </section>
  );
}

function ConnectionDetails({
  connections,
  prefs,
  busy,
  start,
}: {
  connections: AgentConnectionSummary[];
  prefs: DisplayPreferences;
  busy: boolean;
  start: (fn: () => Promise<void>) => void;
}) {
  if (connections.length === 0) {
    return <p className="mt-2 text-sm text-ink-muted">Not connected yet.</p>;
  }
  const date = (iso: string) => formatDateTime(iso, prefs, { dateStyle: 'medium' });
  return (
    <ul className="mt-2 space-y-2">
      {connections.map((c) => (
        <li key={c.id} className="rounded-md border border-line p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <span className="block font-semibold">{c.name}</span>
              <span className="block">{CAPABILITY[c.scope]}</span>
              <span className="block text-ink-muted">
                Connected {date(c.createdAt)} · Last used{' '}
                {c.lastUsedAt ? date(c.lastUsedAt) : 'never'}
                {c.expiresAt && c.status === 'active' && ` · Ends ${date(c.expiresAt)}`}
              </span>
              <span className="block text-ink-muted">{STATUS_LABEL[c.status]}</span>
            </div>
            {c.status === 'active' && (
              <Button
                size="sm"
                type="button"
                disabled={busy}
                onClick={() => start(() => revokeAgent(c.id))}
              >
                Disconnect
              </Button>
            )}
          </div>
        </li>
      ))}
      <li>
        <a href="#activity" className="text-sm underline">
          See activity
        </a>
      </li>
    </ul>
  );
}

function MintToken({
  profile,
  endpoint,
  enabled,
}: {
  profile: AgentProfile;
  endpoint: string;
  enabled: boolean;
}) {
  const [state, action, pending] = useActionState<MintTokenState, FormData>(mintAgentToken, {
    status: 'idle',
  });
  if (state.status === 'created' && state.token) {
    const snippet = fillTemplate(profile.snippetTemplate ?? '{token}', {
      endpoint,
      token: state.token,
    });
    return (
      <div className="space-y-3">
        <Alert tone="warn">
          Copy this now: the token is shown only once. Anyone with it can act in your account at its
          scope until you revoke it.
        </Alert>
        <CopyBlock label="Agent token" text={state.token} />
        <CopyBlock label={profile.snippetLabel ?? 'Configuration'} text={snippet} />
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="profileId" value={profile.id} />
      <TextField
        label="Name"
        name="name"
        defaultValue={profile.displayName}
        maxLength={80}
        hint="To tell your tokens apart, e.g. Laptop"
        required
      />
      <fieldset className="space-y-1">
        <legend className="text-sm font-semibold text-ink-muted">Scope</legend>
        {(['read', 'operate'] as const).map((scope) => (
          <label key={scope} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              value={scope}
              defaultChecked={scope === 'read'}
              className="mt-1"
            />
            <span>
              <span className="font-semibold">{SCOPE_TEXT[scope].label}</span>
              <span className="block text-ink-muted">{SCOPE_TEXT[scope].detail}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <SelectField label="Expires" name="expiry" defaultValue="90d">
        <option value="90d">In 90 days</option>
        <option value="1y">In 1 year</option>
        <option value="none">Never</option>
      </SelectField>
      {state.status === 'error' && <Alert>{state.message}</Alert>}
      <Button variant="primary" type="submit" disabled={pending || !enabled}>
        {pending ? 'Making…' : 'Make token'}
      </Button>
    </form>
  );
}

const STATUS_LABEL = {
  active: 'Connected',
  revoked: 'Disconnected',
  expired: 'Ended',
} as const;

const OUTCOME = {
  ok: { label: 'Done', tone: 'ok' },
  error: { label: 'Failed', tone: 'warn' },
  refused: { label: 'Refused', tone: 'danger' },
} as const;

function argsText(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(
    ([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`,
  );
  return parts.length > 0 ? parts.join(', ') : '—';
}

/** Part c: the person's agent activity. */
export function AgentActivity({
  calls,
  prefs,
}: {
  calls: AgentCallSummary[];
  prefs: DisplayPreferences;
}) {
  if (calls.length === 0) {
    return <p className="text-sm text-ink-muted">No agent has called Trading Magician yet.</p>;
  }
  return (
    <Table label="Agent activity">
      <thead>
        <tr>
          <Th>Time ({prefs.timeZone})</Th>
          <Th>Connection</Th>
          <Th>Tool</Th>
          <Th>Arguments</Th>
          <Th>Outcome</Th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => (
          <tr key={c.id}>
            <Td className="whitespace-nowrap text-content">
              {formatDateTime(c.at, prefs, { dateStyle: 'medium', timeStyle: 'medium' })}
            </Td>
            <Td>
              {c.profileId ? profileName(c.profileId) : '—'}
              {c.connectionName && <span className="block text-ink-muted">{c.connectionName}</span>}
            </Td>
            <Td className="font-mono text-xs text-content">{c.tool}</Td>
            <Td className="max-w-xs text-xs break-words text-content">{argsText(c.args)}</Td>
            <Td>
              <Badge tone={OUTCOME[c.outcome].tone}>{OUTCOME[c.outcome].label}</Badge>
              {c.errorClass && <span className="block text-xs text-ink-muted">{c.errorClass}</span>}
              <span className="block text-xs text-ink-muted">{c.durationMs} ms</span>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
