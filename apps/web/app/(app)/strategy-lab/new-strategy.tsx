'use client';

import { ApiError } from '@tm/contracts';
import { Alert, Button, Dialog, SelectField, TextField } from '@tm/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';

/** A strategy the new one can be copied from. */
export interface CopySource {
  id: string;
  name: string;
  description: string;
  archived: boolean;
}

type StartFrom = 'blank' | 'copy';

const copyName = (source: CopySource) => `Copy of ${source.name}`.slice(0, 120);

/**
 * "New strategy" dialog. It starts either a blank draft or a draft copied
 * from an existing strategy's conditions, orders, timing and risk settings.
 * `initialCopyFrom` opens the dialog straight away with that source picked,
 * which is how "Make a copy" on a strategy's page lands here.
 */
export function NewStrategyButton({
  sources = [],
  initialCopyFrom,
}: {
  sources?: readonly CopySource[];
  initialCopyFrom?: string | undefined;
}) {
  const router = useRouter();
  const preset = sources.find((s) => s.id === initialCopyFrom);
  const [open, setOpen] = useState(Boolean(preset));
  const [startFrom, setStartFrom] = useState<StartFrom>(preset ? 'copy' : 'blank');
  const [sourceId, setSourceId] = useState(preset?.id ?? sources[0]?.id ?? '');
  const [name, setName] = useState(preset ? copyName(preset) : '');
  const [description, setDescription] = useState(preset?.description ?? '');
  // Once the person types a name or description, picking another source keeps it.
  const [touched, setTouched] = useState({ name: false, description: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const source = sources.find((s) => s.id === sourceId);
  const copying = startFrom === 'copy' && source !== undefined;

  function fillFrom(next: CopySource | undefined, mode: StartFrom) {
    const from = mode === 'copy' ? next : undefined;
    if (!touched.name) setName(from ? copyName(from) : '');
    if (!touched.description) setDescription(from?.description ?? '');
  }

  function close() {
    setOpen(false);
    setError(undefined);
    // Drop ?copy= so a refresh does not reopen the dialog.
    if (initialCopyFrom) router.replace('/strategy-lab');
  }

  async function create() {
    setPending(true);
    setError(undefined);
    try {
      const strategy =
        startFrom === 'copy' && source
          ? await apiClient.strategies.duplicate(source.id, { name, description })
          : await apiClient.strategies.create({ name, description });
      router.push(`/strategy-lab/${strategy.id}`);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.body.issues?.[0]?.message ?? e.message)
          : 'Could not create the strategy. Try again.',
      );
      setPending(false);
    }
  }

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New strategy
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="New strategy"
        description={
          copying
            ? 'The copy starts as a new draft. You can change everything before you test or run it.'
            : 'It starts as a draft with the default paper risk limits. You can change everything later.'
        }
      >
        <form action={create} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {sources.length > 0 && (
            <fieldset>
              <legend className="text-sm font-medium">Start from</legend>
              <div className="mt-1 grid-fields gap-2">
                {(
                  [
                    ['blank', 'A blank strategy'],
                    ['copy', 'A copy of an existing strategy'],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent/5"
                  >
                    <input
                      type="radio"
                      name="new-strategy-start-from"
                      value={value}
                      checked={startFrom === value}
                      onChange={() => {
                        setStartFrom(value);
                        fillFrom(source, value);
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {startFrom === 'copy' && sources.length > 0 && (
            <SelectField
              label="Strategy to copy"
              name="new-strategy-source"
              value={sourceId}
              onChange={(e) => {
                const next = sources.find((s) => s.id === e.target.value);
                setSourceId(e.target.value);
                fillFrom(next, 'copy');
              }}
              hint="Its conditions, orders, timing and risk settings are copied. Back test results, versions, orders and run history are not."
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.archived ? `${s.name} (archived)` : s.name}
                </option>
              ))}
            </SelectField>
          )}
          <TextField
            label="Name"
            name="new-strategy-name"
            required
            maxLength={120}
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setTouched((t) => ({ ...t, name: true }));
            }}
          />
          <TextField
            label="Description (optional)"
            name="new-strategy-description"
            maxLength={2000}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setTouched((t) => ({ ...t, description: true }));
            }}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Creating…' : copying ? 'Create copy' : 'Create strategy'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
