'use client';

import { ApiError } from '@tm/contracts';
import type { StrategyStatus } from '@tm/domain';
import { Alert, Button, Dialog, TextField } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ShareButton } from '@/components/sharing/share-button';
import { apiClient } from '@/lib/api-client';

interface RowStrategy {
  id: string;
  name: string;
  status: StrategyStatus;
  archived: boolean;
  rowVersion: number;
  /** Its Library number; only numbered strategies can be shared (ADR 0056). */
  libraryNumber: string | null;
}

type Mode = 'rename' | 'delete' | null;

const message = (e: unknown) =>
  e instanceof ApiError
    ? (e.body.issues?.[0]?.message ?? e.message)
    : 'Something went wrong. Try again.';

/** Library row actions (§6.1): rename, duplicate, archive or restore, delete. */
export function RowActions({
  strategy,
  isAdmin = false,
}: {
  strategy: RowStrategy;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const running = strategy.status === 'actively_executing';

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await action();
      setMode(null);
      router.refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setPending(false);
    }
  }

  const label = (verb: string) => `${verb} ${strategy.name}`;

  return (
    <div className="flex justify-end gap-1">
      <Button
        size="sm"
        variant="ghost"
        aria-label={label('Rename')}
        onClick={() => setMode('rename')}
      >
        Rename
      </Button>
      {strategy.libraryNumber && (
        <ShareButton
          source={{ kind: 'lab', strategyId: strategy.id }}
          label={`${strategy.libraryNumber} ${strategy.name}`}
          isAdmin={isAdmin}
          variant="ghost"
          size="sm"
        />
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label={label('Duplicate')}
        disabled={pending}
        onClick={() => run(() => apiClient.strategies.duplicate(strategy.id))}
      >
        Duplicate
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={label(strategy.archived ? 'Restore' : 'Archive')}
        disabled={pending || (running && !strategy.archived)}
        title={running ? 'Stop the strategy before archiving it' : undefined}
        onClick={() =>
          run(() =>
            apiClient.strategies.update(strategy.id, {
              rowVersion: strategy.rowVersion,
              archived: !strategy.archived,
            }),
          )
        }
      >
        {strategy.archived ? 'Restore' : 'Archive'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="text-danger"
        aria-label={label('Delete')}
        disabled={running}
        title={running ? 'Stop the strategy before deleting it' : undefined}
        onClick={() => setMode('delete')}
      >
        Delete
      </Button>
      {error && mode === null && (
        <p role="alert" className="self-center text-xs text-danger">
          {error}
        </p>
      )}

      <Dialog open={mode === 'rename'} onClose={() => setMode(null)} title="Rename strategy">
        <form
          className="space-y-4 text-left"
          action={(form) =>
            run(() =>
              apiClient.strategies.update(strategy.id, {
                rowVersion: strategy.rowVersion,
                name: String(form.get(`rename-${strategy.id}`) ?? ''),
              }),
            )
          }
        >
          {error && <Alert>{error}</Alert>}
          <TextField
            label="Name"
            name={`rename-${strategy.id}`}
            defaultValue={strategy.name}
            required
            maxLength={120}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              Save name
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={mode === 'delete'}
        onClose={() => setMode(null)}
        title={`Delete “${strategy.name}”?`}
        description="It disappears from your library. Its saved versions stay in the audit history."
      >
        <div className="space-y-4 text-left">
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                run(() => apiClient.strategies.remove(strategy.id, strategy.rowVersion))
              }
            >
              Delete strategy
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
