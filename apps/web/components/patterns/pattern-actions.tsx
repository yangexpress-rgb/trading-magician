'use client';

import { Alert, Button } from '@tm/ui';
import { useActionState } from 'react';
import type { PatternActionState } from '@/app/(app)/research/patterns/actions';

type Action = (prev: PatternActionState, form: FormData) => Promise<PatternActionState>;

/** One button that runs a pattern action and shows its result. */
export function PatternActionButton({
  action,
  patternId,
  label,
  confirm,
  variant,
}: {
  action: Action;
  patternId: string;
  label: string;
  confirm?: string;
  variant?: 'primary' | 'secondary';
}) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });
  return (
    <form
      action={formAction}
      className="space-y-2"
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <input type="hidden" name="patternId" value={patternId} />
      <Button type="submit" size="sm" disabled={pending} {...(variant ? { variant } : {})}>
        {label}
      </Button>
      {state.status === 'error' && <Alert>{state.message}</Alert>}
      {state.status === 'done' && <p className="text-sm text-ink-muted">{state.message}</p>}
    </form>
  );
}
