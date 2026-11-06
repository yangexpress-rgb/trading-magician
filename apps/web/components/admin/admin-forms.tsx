'use client';

import { Alert, Button, TextField } from '@tm/ui';
import { useActionState, useState, type ReactNode } from 'react';
import type { AdminActionState } from '@/app/(app)/admin/actions';

type Action = (prev: AdminActionState, form: FormData) => Promise<AdminActionState>;
const idle: AdminActionState = { status: 'idle' };

/** Codes or a password shown once, with a copy button. */
function Secrets({ values, label }: { values: string[]; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-2 p-3">
      <ul aria-label={label} className="space-y-1 font-mono text-sm select-all">
        {values.map((v) => (
          <li key={v}>{v}</li>
        ))}
      </ul>
      <Button
        size="sm"
        className="mt-2"
        onClick={async () => {
          await navigator.clipboard?.writeText(values.join('\n'));
          setCopied(true);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function Result({ state, secretsLabel }: { state: AdminActionState; secretsLabel: string }) {
  if (state.status === 'idle') return null;
  return (
    <div role="status" className="mt-2 text-sm">
      {state.status === 'error' ? <Alert>{state.message}</Alert> : <p>{state.message}</p>}
      {state.secrets && state.secrets.length > 0 && (
        <Secrets values={state.secrets} label={secretsLabel} />
      )}
    </div>
  );
}

/**
 * One button that runs an admin action with hidden fields, after a
 * confirmation when `confirm` is given.
 */
export function AdminButton({
  action,
  fields,
  confirm,
  variant,
  children,
  secretsLabel = 'Shown once',
}: {
  action: Action;
  fields: Record<string, string>;
  confirm?: string;
  variant?: 'primary' | 'danger';
  children: ReactNode;
  secretsLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button size="sm" type="submit" disabled={pending} {...(variant ? { variant } : {})}>
        {children}
      </Button>
      <Result state={state} secretsLabel={secretsLabel} />
    </form>
  );
}

export function MintInvitesForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, idle);
  return (
    <form action={formAction} className="space-y-4" aria-label="Create invite codes">
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr_10rem]">
        <TextField
          label="How many"
          name="count"
          type="number"
          min={1}
          max={50}
          defaultValue={1}
          required
        />
        <TextField
          label="Note (who it is for)"
          name="note"
          maxLength={200}
          placeholder="e.g. Sam from the trading club"
        />
        <TextField
          label="Expires in days"
          name="expiresInDays"
          type="number"
          min={0}
          max={365}
          hint="Leave empty for no expiry"
        />
      </div>
      <Button variant="primary" type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create invite codes'}
      </Button>
      <Result state={state} secretsLabel="New invite codes" />
    </form>
  );
}
