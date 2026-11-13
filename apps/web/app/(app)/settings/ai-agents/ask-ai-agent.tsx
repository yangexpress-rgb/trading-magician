'use client';

import type { AiAssistantSummary } from '@tm/db';
import { Alert, Button, TextField } from '@tm/ui';
import { useActionState, useState, useTransition } from 'react';
import { ASK_AI_PROVIDERS, type AskAiProviderId } from '@/lib/ask-ai';
import { clearAskAiAgent, saveAskAiAgent, type AskAiAgentState } from './actions';

/**
 * Settings › AI agents › Your agent for Ask AI (N274, ADR 0094): the one
 * agent the Ask AI panel talks to. Its key is stored sealed and never shown
 * again; leaving the key empty keeps the stored one.
 */
export function AskAiAgentForm({ current }: { current: AiAssistantSummary | null }) {
  const [provider, setProvider] = useState<AskAiProviderId>(current?.provider ?? 'claude_ai');
  const [state, action, pending] = useActionState<AskAiAgentState, FormData>(saveAskAiAgent, {
    status: 'idle',
  });
  const [clearing, startClear] = useTransition();
  const chosen = ASK_AI_PROVIDERS.find((p) => p.id === provider) ?? ASK_AI_PROVIDERS[0];
  const sameProvider = current?.provider === provider;
  const keyKept = sameProvider && current?.keyHint;

  return (
    <form action={action} className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Agent</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {ASK_AI_PROVIDERS.map((p) => (
            <label
              key={p.id}
              className={`flex cursor-pointer gap-2 rounded-md border p-3 text-sm ${
                p.id === provider ? 'border-accent bg-surface-2' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name="provider"
                value={p.id}
                checked={p.id === provider}
                onChange={() => setProvider(p.id)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{p.label}</span>
                <span className="mt-0.5 block text-xs text-ink-muted">{p.line}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {chosen.keyLabel && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            key={`key-${provider}`}
            label={chosen.keyLabel}
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={keyKept ? `Saved key ending ${current?.keyHint}` : ''}
            hint={
              keyKept
                ? 'Leave empty to keep the saved key.'
                : 'Stored locked; only the app can use it, and it is never shown again.'
            }
          />
          {provider === 'openai_compatible' && (
            <TextField
              key="base-url"
              label="API address"
              name="baseUrl"
              type="url"
              placeholder="https://…/v1"
              defaultValue={sameProvider ? (current?.baseUrl ?? '') : ''}
            />
          )}
          <TextField
            key={`model-${provider}`}
            label={chosen.needsModel ? 'Model' : 'Model (optional)'}
            name="model"
            placeholder={chosen.modelHint ?? ''}
            defaultValue={sameProvider ? (current?.model ?? '') : ''}
          />
        </div>
      )}
      {chosen.keyUrl && (
        <p className="text-xs text-ink-muted">
          Get a key at{' '}
          <a href={chosen.keyUrl} target="_blank" rel="noopener noreferrer" className="underline">
            {new URL(chosen.keyUrl).host}
          </a>
          . What the agent does is billed to that key.
        </p>
      )}

      {state.status === 'error' && <Alert>{state.message}</Alert>}
      {state.status === 'saved' && <Alert tone="ok">{state.message}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {current && (
          <Button
            type="button"
            disabled={clearing}
            onClick={() => startClear(() => clearAskAiAgent())}
          >
            Remove{' '}
            {current.provider === 'muse'
              ? 'Muse'
              : current.provider === 'claude_ai'
                ? 'Claude'
                : 'agent and key'}
          </Button>
        )}
      </div>
    </form>
  );
}
