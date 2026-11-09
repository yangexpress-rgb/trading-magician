'use client';

import { ApiError } from '@tm/contracts';
import { Alert, Button } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/** A pending share the recipient can answer, with its label ("S00012-SD Golden cross"). */
export interface PendingShare {
  id: string;
  label: string;
}

interface Picked {
  selected: Set<string>;
  set: (ids: string[], on: boolean) => void;
}

const PickedContext = createContext<Picked | null>(null);

function usePicked(): Picked {
  const ctx = useContext(PickedContext);
  if (!ctx) throw new Error('Answer controls must sit inside <BulkAnswer>');
  return ctx;
}

/**
 * Accept or decline several shares at once (ADR 0056, N155): tick boxes on
 * the pending rows of "Shared with me", a header box, and the buttons above
 * the table. Each share is answered on its own, so one that fails (withdrawn
 * meanwhile, say) leaves the others done.
 */
export function BulkAnswer({
  pending,
  children,
}: {
  pending: PendingShare[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const value = useMemo<Picked>(
    () => ({
      selected,
      set: (ids, on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            if (on) next.add(id);
            else next.delete(id);
          }
          return next;
        }),
    }),
    [selected],
  );
  return (
    <PickedContext.Provider value={value}>
      <AnswerBar pending={pending} />
      {children}
    </PickedContext.Provider>
  );
}

type Verb = 'accept' | 'decline';

function AnswerBar({ pending }: { pending: PendingShare[] }) {
  const router = useRouter();
  const { selected, set } = usePicked();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'ok' | 'danger'; lines: string[] } | null>(null);
  // Only shares still pending on this page count (a refresh may have closed some).
  const picked = pending.filter((p) => selected.has(p.id));

  async function answer(verb: Verb, shares: PendingShare[]) {
    if (shares.length === 0) return;
    if (
      verb === 'decline' &&
      !window.confirm(`Decline ${shares.length} ${shares.length === 1 ? 'share' : 'shares'}?`)
    ) {
      return;
    }
    setResult(null);
    const failed: string[] = [];
    let done = 0;
    for (const s of shares) {
      setBusy(`${verb === 'accept' ? 'Accepting' : 'Declining'} ${done + 1} of ${shares.length}…`);
      try {
        if (verb === 'accept') await apiClient.shares.accept(s.id);
        else await apiClient.shares.decline(s.id);
        done += 1;
      } catch (e) {
        failed.push(`${s.label}: ${e instanceof ApiError ? e.message : 'something went wrong'}`);
      }
    }
    set(
      shares.map((s) => s.id),
      false,
    );
    setBusy(null);
    const past = verb === 'accept' ? 'Accepted' : 'Declined';
    const head =
      verb === 'accept'
        ? `${past} ${done} ${done === 1 ? 'share' : 'shares'}; your copies have new numbers in your Library or Strategy Lab.`
        : `${past} ${done} ${done === 1 ? 'share' : 'shares'}.`;
    setResult({
      tone: failed.length ? 'danger' : 'ok',
      lines: failed.length ? [head, `${failed.length} could not be answered:`, ...failed] : [head],
    });
    router.refresh();
  }

  if (pending.length === 0 && !result) return null;
  return (
    <div className="mb-3 space-y-2">
      {result && (
        <Alert tone={result.tone}>
          {result.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </Alert>
      )}
      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null || picked.length === 0}
            onClick={() => void answer('accept', picked)}
          >
            {picked.length > 0 ? `Accept selected (${picked.length})` : 'Accept selected'}
          </Button>
          <Button
            size="sm"
            disabled={busy !== null || picked.length === 0}
            onClick={() => void answer('decline', picked)}
          >
            {picked.length > 0 ? `Decline selected (${picked.length})` : 'Decline selected'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void answer('accept', pending)}
          >
            Accept all ({pending.length})
          </Button>
          <span className="text-xs text-ink-muted" aria-live="polite">
            {busy ?? 'Tick shares to accept or decline several at once.'}
          </span>
        </div>
      )}
    </div>
  );
}

/** A pending row's tick box. */
export function AnswerCheckbox({ share }: { share: PendingShare }) {
  const { selected, set } = usePicked();
  return (
    <input
      type="checkbox"
      aria-label={`Select ${share.label}`}
      checked={selected.has(share.id)}
      onChange={(e) => set([share.id], e.target.checked)}
      className="h-4 w-4"
    />
  );
}

/** The header tick box: every pending share on the page. */
export function AnswerCheckAll({ pending }: { pending: PendingShare[] }) {
  const { selected, set } = usePicked();
  if (pending.length === 0) return null;
  const all = pending.every((p) => selected.has(p.id));
  return (
    <input
      type="checkbox"
      aria-label={all ? 'Clear the selection' : 'Select every share waiting for an answer'}
      checked={all}
      onChange={(e) =>
        set(
          pending.map((p) => p.id),
          e.target.checked,
        )
      }
      className="h-4 w-4"
    />
  );
}
