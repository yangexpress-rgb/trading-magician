'use client';

import type { AgentCallSummary, AgentConnectionSummary } from '@tm/db';
import { formatDateTime, type DisplayPreferences } from '@tm/domain';
import { Alert, Badge, Button, cx, SelectField, Table, Td, TextField, Th } from '@tm/ui';
import { useActionState, useState, useTransition } from 'react';
import { fillTemplate, profileName, SCOPE_TEXT, type AgentProfile } from '@/lib/agents/profiles';
import { mintAgentToken, revokeAgent, type MintTokenState } from './actions';

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

/** Part a: the agent list, and the chosen agent's connect panel. */
export function ChooseAgent({
  profiles,
  endpoint,
  enabled,
}: {
  profiles: readonly AgentProfile[];
  endpoint: string;
  enabled: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const profile = profiles.find((p) => p.id === chosen);
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="sr-only">Which AI agent do you use?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {profiles.map((p) => (
            <label
              key={p.id}
              className={cx(
                'flex cursor-pointer items-start gap-3 rounded-md border p-3',
                chosen === p.id ? 'border-accent bg-surface-2' : 'border-line',
              )}
            >
              <input
                type="radio"
                name="agent-profile"
                value={p.id}
                checked={chosen === p.id}
                onChange={() => setChosen(p.id)}
                className="mt-1"
              />
              <span>
                <span className="block font-semibold">{p.displayName}</span>
                <span className="block text-sm text-ink-muted">{p.tagline}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {profile && (
        <ConnectPanel key={profile.id} profile={profile} endpoint={endpoint} enabled={enabled} />
      )}
    </div>
  );
}

function ConnectPanel({
  profile,
  endpoint,
  enabled,
}: {
  profile: AgentProfile;
  endpoint: string;
  enabled: boolean;
}) {
  return (
    <div
      className="space-y-4 rounded-md border border-line p-4"
      aria-label={`Connect ${profile.displayName}`}
    >
      <h3 className="font-semibold">Connect {profile.displayName}</h3>
      <ol className="ml-5 list-decimal space-y-1 text-sm">
        {profile.helpSteps.map((step) => (
          <li key={step}>{fillTemplate(step, { endpoint })}</li>
        ))}
      </ol>
      {profile.authMethod === 'oauth' ? (
        <>
          <CopyBlock label="MCP endpoint URL" text={endpoint} />
          <p className="text-sm text-ink-muted">
            When {profile.displayName} asks to connect, you choose what it may do: Read only (the
            default), or Read and operate. The connection then shows under Your connections, where
            you can revoke it at any time.
          </p>
        </>
      ) : (
        <MintToken profile={profile} endpoint={endpoint} enabled={enabled} />
      )}
    </div>
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
        {profile.id === 'other-mcp' && <CopyBlock label="MCP endpoint URL" text={endpoint} />}
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

const STATUS_TONE = { active: 'ok', revoked: 'neutral', expired: 'warn' } as const;
const STATUS_LABEL = { active: 'Active', revoked: 'Revoked', expired: 'Expired' } as const;

/** Part b: every connection, with Revoke. */
export function AgentConnections({
  connections,
  prefs,
}: {
  connections: AgentConnectionSummary[];
  prefs: DisplayPreferences;
}) {
  const [busy, start] = useTransition();
  if (connections.length === 0) {
    return <p className="text-sm text-ink-muted">No agent is connected yet.</p>;
  }
  return (
    <Table label="Agent connections">
      <thead>
        <tr>
          <Th>Agent</Th>
          <Th>Connected with</Th>
          <Th>Scope</Th>
          <Th>Created ({prefs.timeZone})</Th>
          <Th>Last used</Th>
          <Th>Status</Th>
          <Th>
            <span className="sr-only">Action</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {connections.map((c) => (
          <tr key={c.id}>
            <Td>
              <span className="block font-semibold">{profileName(c.profileId)}</span>
              <span className="block text-ink-muted">{c.name}</span>
            </Td>
            <Td className="text-content">
              {c.authMethod === 'oauth' ? 'Sign-in (OAuth)' : `Token ${c.tokenHint ?? ''}`}
              {c.expiresAt && c.status === 'active' && (
                <span className="block text-ink-muted">
                  Expires {formatDateTime(c.expiresAt, prefs, { dateStyle: 'medium' })}
                </span>
              )}
            </Td>
            <Td>{SCOPE_TEXT[c.scope].label}</Td>
            <Td className="text-content">{formatDateTime(c.createdAt, prefs)}</Td>
            <Td className="text-content">
              {c.lastUsedAt ? formatDateTime(c.lastUsedAt, prefs) : 'Never'}
            </Td>
            <Td>
              <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
            </Td>
            <Td className="text-right">
              {c.status === 'active' && (
                <Button size="sm" disabled={busy} onClick={() => start(() => revokeAgent(c.id))}>
                  Revoke
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

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
