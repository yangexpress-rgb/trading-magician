'use client';

import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MIN_SUPPORT,
  FACTOR_CATEGORIES,
  FACTOR_CATEGORY_LABELS,
} from '@tm/domain';
import { Alert, Button, SelectField, TextField } from '@tm/ui';
import { useActionState } from 'react';
import type { PatternActionState } from '@/app/(app)/research/patterns/actions';

type Action = (prev: PatternActionState, form: FormData) => Promise<PatternActionState>;

/** The New scan form (pattern brief §6), with the brief's defaults set. */
export function NewScanForm({
  action,
  groups,
  shortCategories,
}: {
  action: Action;
  groups: { id: string; label: string }[];
  /** Categories whose coverage is short (options, session): unticked by default. */
  shortCategories: string[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });
  return (
    <form action={formAction} className="space-y-4" aria-label="New scan">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SelectField label="Universe" name="universe" defaultValue="group:sp500">
          {groups.map((g) => (
            <option key={g.id} value={`group:${g.id}`}>
              {g.label}
            </option>
          ))}
          <option value="options">Options universe</option>
        </SelectField>
        <SelectField label="Outcome" name="direction" defaultValue="spike">
          <option value="spike">Spike (run-up of at least X%)</option>
          <option value="plunge">Plunge (drop of at least X%)</option>
        </SelectField>
        <TextField
          label="X (%)"
          name="pct"
          type="number"
          min={0.5}
          max={100}
          step={0.5}
          defaultValue={8}
          required
        />
        <TextField
          label="Within H trading days"
          name="horizon"
          type="number"
          min={1}
          max={126}
          defaultValue={15}
          required
        />
        <SelectField
          label="Most conditions per rule"
          name="maxDepth"
          defaultValue={String(DEFAULT_MAX_DEPTH)}
        >
          {[2, 3, 4].map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Fewest discovery occurrences"
          name="minSupport"
          type="number"
          min={5}
          max={10000}
          defaultValue={DEFAULT_MIN_SUPPORT}
          required
        />
        <TextField
          label="From (optional)"
          name="from"
          type="date"
          hint="Default: start of the factors' coverage"
        />
        <TextField
          label="To (optional)"
          name="to"
          type="date"
          hint="Default: the latest snapshot"
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-ink-muted">Factor categories</legend>
        <div className="flex flex-wrap gap-4">
          {FACTOR_CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="categories"
                value={c}
                defaultChecked={!shortCategories.includes(c)}
              />
              {FACTOR_CATEGORY_LABELS[c]}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-ink-muted">
        The first 70% of the range is searched; the last 30% is held out and tested once. Scans run
        in the batch service, so a new scan starts at its next run.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? 'Queuing…' : 'Start scan'}
      </Button>
      {state.status === 'error' && <Alert>{state.message}</Alert>}
    </form>
  );
}
