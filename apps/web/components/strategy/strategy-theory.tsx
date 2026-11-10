'use client';

import { ApiError, type StrategyLibraryDto } from '@tm/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { EntrySearch, toChoiceRequest, type LibraryPick } from './library-entry-field';
import { useRowVersion } from './row-version';
import { useClickOrDoubleClick } from './strategy-name';

const HINT = 'Double-click to change the theory';

/**
 * The theory a strategy refers to, under its name on the strategy page (N191).
 * Double-click (or F2) opens the Library search; a pick is saved at once. A
 * strategy whose record was auto-created from it refers to no theory (N187).
 * A running strategy keeps its theory, as in the builder's picker.
 */
export function StrategyTheoryLine({
  strategyId,
  library,
  initialRowVersion,
  editable,
}: {
  strategyId: string;
  library: StrategyLibraryDto | null;
  initialRowVersion: number;
  editable: boolean;
}) {
  const router = useRouter();
  const [rowVersion, setRowVersion] = useRowVersion(initialRowVersion);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const lineRef = useRef<HTMLSpanElement>(null);
  const referred = library && !library.autoCreated ? library : null;
  const start = () => {
    if (!editable) return;
    setError(undefined);
    setOpen(true);
  };
  const href = referred ? `/library/${referred.registrationNumber}` : '#';
  const linkHandlers = useClickOrDoubleClick(href, start);
  const hint = editable ? HINT : 'Stop the strategy to change its theory';

  async function pick(choice: LibraryPick) {
    setPending(true);
    setError(undefined);
    try {
      const saved = await apiClient.strategies.update(strategyId, {
        rowVersion,
        library: toChoiceRequest(choice),
      });
      setRowVersion(saved.rowVersion);
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change the theory. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-1 text-sm" aria-busy={pending || undefined}>
      <span
        ref={lineRef}
        tabIndex={referred ? undefined : 0}
        title={hint}
        className="cursor-default rounded"
        onDoubleClick={referred ? undefined : start}
        onKeyDown={(e) => {
          if (!referred && e.key === 'F2') {
            e.preventDefault();
            start();
          }
        }}
      >
        <span className="text-ink-muted">Theory </span>
        {referred ? (
          <>
            <Link
              href={href}
              title={hint}
              className="font-mono font-semibold"
              aria-label={`Theory Library entry ${referred.registrationNumber}`}
              {...linkHandlers}
            >
              {referred.registrationNumber}
            </Link>{' '}
            <span className="text-content" onDoubleClick={start}>
              {referred.name}
            </span>
          </>
        ) : (
          <span className="text-ink-muted">none referred</span>
        )}
      </span>
      {error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
      {open && (
        <div className="max-w-xl">
          <EntrySearch
            currentId={library?.entryId}
            // Referring to none already means its own record; "new" is how to stop referring.
            offerNew={referred !== null}
            onPick={(choice) => void pick(choice)}
            onClose={() => {
              setOpen(false);
              // Back to the line as it was, with the keyboard where it started.
              const line = lineRef.current;
              (line?.querySelector<HTMLElement>('a') ?? line)?.focus();
            }}
          />
        </div>
      )}
    </div>
  );
}
