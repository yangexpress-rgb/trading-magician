'use client';

import { ApiError, type StrategyDetailDto } from '@tm/contracts';
import {
  machineDefinitionSchema,
  randomId,
  type ConditionGroup,
  type MachineDefinition,
  type MachineGroup,
  type MachineRow,
  type MachineState,
} from '@tm/domain';
import { Alert, Button, Card, cx } from '@tm/ui';
import { useMemo, useState } from 'react';
import { ConditionTreeEditor, type MachineRuleScope } from './condition-editor';
import { EditorContext, useEditor } from './editor-context';
import { MiniInput, MiniSelect, RowButton } from './fields';
import { InstrumentSelect } from './instrument-select';
import { apiClient } from '@/lib/api-client';
import { describeMachineCondition } from '@/lib/strategy-text';

/**
 * The state-machine builder (state-machine brief v1.4 §5, ADR 0124 P3b):
 * state cards with their targets in words, the rows in priority order with
 * up and down buttons, each row reading "when ⟨rule⟩ → go to ⟨state⟩ / stay",
 * and the plumbing (risk, execution) collapsed below. It edits a draft of the
 * whole document and saves it as one update; the server validates it.
 */

type Issues = ReadonlyMap<string, string>;

const key = (path: readonly (string | number)[]) => path.join('.');

/** Problems the schema finds in the draft before it is saved, by path. */
function structural(draft: MachineDefinition): Map<string, string> {
  const out = new Map<string, string>();
  const r = machineDefinitionSchema.safeParse(draft);
  if (!r.success)
    for (const i of r.error.issues) {
      const k = key(i.path as (string | number)[]);
      if (!out.has(k)) out.set(k, i.message);
    }
  return out;
}

/** A state of the draft by index; the callers index states they just rendered. */
const stateAt = (d: MachineDefinition, si: number) => d.machine.states[si] as MachineState;

const emptyGroup = (): MachineGroup => ({
  kind: 'group',
  id: randomId(),
  op: 'and',
  negate: false,
  children: [],
});

function nextStateId(states: readonly MachineState[]): string {
  for (let n = states.length + 1; ; n++) {
    const id = `STATE_${n}`;
    if (!states.some((s) => s.id === id)) return id;
  }
}

/** Where each state is named: rows that go there, and rows whose rules read it. */
function stateReferences(def: MachineDefinition) {
  const goes = new Map<string, number[]>();
  const reads = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, id: string, n: number) => {
    const list = m.get(id) ?? [];
    if (!list.includes(n)) list.push(n);
    m.set(id, list);
  };
  def.machine.rows.forEach((row, i) => {
    if (row.outcome.kind === 'go') push(goes, row.outcome.stateId, i + 1);
    const walk = (n: unknown) => {
      const node = n as {
        kind: string;
        stateIds?: string[];
        children?: unknown[];
        left?: unknown;
        right?: unknown;
      };
      if (node.kind === 'state_is') node.stateIds?.forEach((s) => push(reads, s, i + 1));
      if (node.kind === 'comparison')
        for (const side of [node.left, node.right]) {
          const e = side as { kind?: string; stateIds?: string[] } | undefined;
          if (e?.kind === 'days_in_states') e.stateIds?.forEach((s) => push(reads, s, i + 1));
        }
      node.children?.forEach(walk);
    };
    if (row.condition) walk(row.condition);
  });
  return { goes, reads };
}

export function MachineBuilder({
  strategyId,
  machine,
  rowVersion,
  editable,
  serverIssues,
  onSaved,
}: {
  strategyId: string;
  machine: MachineDefinition;
  rowVersion: number;
  editable: boolean;
  /** The saved draft's validation problems and warnings, by path. */
  serverIssues: Issues;
  onSaved: (detail: StrategyDetailDto) => void;
}) {
  const outer = useEditor();
  const { instruments } = outer;
  // The document as last saved: the page's copy until a save replaces it.
  const [base, setBase] = useState<MachineDefinition>(machine);
  const [draft, setDraft] = useState<MachineDefinition>(machine);
  const savedText = JSON.stringify(machine);
  const [seen, setSeen] = useState(savedText);
  if (seen !== savedText) {
    // The saved document changed under the page (a refresh after a save).
    setSeen(savedText);
    setBase(machine);
    if (JSON.stringify(draft) === JSON.stringify(base)) setDraft(machine);
  }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(base), [draft, base]);
  const issues = useMemo(() => {
    const local = structural(draft);
    const merged = new Map(dirty ? [] : serverIssues);
    for (const [k, v] of local) merged.set(k, v);
    return merged;
  }, [draft, dirty, serverIssues]);
  const issueKeys = useMemo(() => [...issues.keys()], [issues]);
  const issueAt = (path: readonly (string | number)[]) => issues.get(key(path));
  const symbol = (id: string) => instruments.find((i) => i.id === id)?.symbol;
  const refs = stateReferences(draft);
  const set = (fn: (d: MachineDefinition) => MachineDefinition) =>
    setDraft((d) => fn(structuredClone(d)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const detail = await apiClient.strategies.update(strategyId, {
        rowVersion,
        definition: draft,
      });
      setBase(draft);
      onSaved(detail);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const states = draft.machine.states;
  const rows = draft.machine.rows;
  const stateName = (id: string) => states.find((s) => s.id === id)?.name;

  return (
    <EditorContext.Provider value={{ ...outer, editable, issueAt }}>
      <div className="space-y-6">
        <Card aria-labelledby="machine-signals-heading">
          <h2 id="machine-signals-heading" className="text-lg font-semibold">
            Signals
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            The instruments the rows read, on daily bars. The states' holdings are added to the data
            the strategy loads.
          </p>
          <ul className="mt-2 space-y-2">
            {draft.trade.instrumentIds.map((id, i) => (
              <li key={`${id}-${i}`} className="flex flex-wrap items-end gap-2">
                <div className="w-72">
                  <InstrumentSelect
                    id={`signal-${i}`}
                    label={`Signal ${i + 1}`}
                    value={id}
                    allowContext={false}
                    error={issueAt(['trade', 'instrumentIds', i])}
                    onChange={(v) =>
                      set((d) => {
                        d.trade.instrumentIds[i] = v;
                        return d;
                      })
                    }
                  />
                </div>
                {editable && draft.trade.instrumentIds.length > 1 && (
                  <RowButton
                    label={`Remove signal ${i + 1}`}
                    className="text-danger"
                    onClick={() =>
                      set((d) => {
                        d.trade.instrumentIds.splice(i, 1);
                        return d;
                      })
                    }
                  >
                    Remove
                  </RowButton>
                )}
              </li>
            ))}
          </ul>
          {editable && draft.trade.instrumentIds.length < 10 && (
            <button
              type="button"
              className="mt-2 rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
              onClick={() =>
                set((d) => {
                  d.trade.instrumentIds.push(instruments[0]?.id ?? '');
                  return d;
                })
              }
            >
              + Add signal
            </button>
          )}
        </Card>

        <Card aria-labelledby="machine-states-heading">
          <h2 id="machine-states-heading" className="text-lg font-semibold">
            States
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Each state is a target portfolio: long weights as % of equity, the rest in cash. The run
            rebalances only when its state changes.
          </p>
          {issueAt(['machine', 'states']) && (
            <p className="mt-1 text-xs font-medium text-danger">{issueAt(['machine', 'states'])}</p>
          )}
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {states.map((s, si) => {
              const held = s.targets.reduce((n, t) => n + Number(t.weightPct || 0), 0);
              const goes = refs.goes.get(s.id) ?? [];
              const reads = refs.reads.get(s.id) ?? [];
              const used = goes.length > 0 || reads.length > 0;
              return (
                <li key={s.id} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <MiniInput
                        id={`state-${s.id}-name`}
                        label="State name"
                        value={s.name}
                        disabled={!editable}
                        error={issueAt(['machine', 'states', si, 'name'])}
                        onChange={(e) =>
                          set((d) => {
                            stateAt(d, si).name = e.target.value;
                            return d;
                          })
                        }
                      />
                    </div>
                    {editable && (
                      <RowButton
                        label={`Remove state ${s.name}`}
                        className="text-danger"
                        disabled={used || states.length <= 2}
                        title={used ? 'Rows still name this state' : undefined}
                        onClick={() =>
                          set((d) => {
                            d.machine.states.splice(si, 1);
                            return d;
                          })
                        }
                      >
                        Remove
                      </RowButton>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-content">
                    {s.targets.length === 0
                      ? '100% cash'
                      : [
                          ...s.targets.map(
                            (t) => `${symbol(t.instrumentId) ?? '?'} ${t.weightPct || 0}%`,
                          ),
                          ...(held < 100 ? [`cash ${+(100 - held).toFixed(4)}%`] : []),
                        ].join(' + ')}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {s.targets.map((t, ti) => (
                      <li
                        key={`${t.instrumentId}-${ti}`}
                        className="flex flex-wrap items-end gap-2"
                      >
                        <div className="w-56">
                          <InstrumentSelect
                            id={`state-${s.id}-target-${ti}`}
                            label="Hold"
                            value={t.instrumentId}
                            allowContext={false}
                            tradableOnly
                            error={issueAt([
                              'machine',
                              'states',
                              si,
                              'targets',
                              ti,
                              'instrumentId',
                            ])}
                            onChange={(v) =>
                              set((d) => {
                                (
                                  stateAt(d, si).targets[ti] as MachineState['targets'][number]
                                ).instrumentId = v;
                                return d;
                              })
                            }
                          />
                        </div>
                        <div className="w-28">
                          <MiniInput
                            id={`state-${s.id}-weight-${ti}`}
                            label="% of equity"
                            inputMode="decimal"
                            value={t.weightPct}
                            disabled={!editable}
                            error={issueAt(['machine', 'states', si, 'targets', ti, 'weightPct'])}
                            onChange={(e) =>
                              set((d) => {
                                (
                                  stateAt(d, si).targets[ti] as MachineState['targets'][number]
                                ).weightPct = e.target.value.trim();
                                return d;
                              })
                            }
                          />
                        </div>
                        {editable && (
                          <RowButton
                            label={`Remove holding ${ti + 1} of ${s.name}`}
                            className="text-danger"
                            onClick={() =>
                              set((d) => {
                                stateAt(d, si).targets.splice(ti, 1);
                                return d;
                              })
                            }
                          >
                            Remove
                          </RowButton>
                        )}
                      </li>
                    ))}
                  </ul>
                  {issueAt(['machine', 'states', si, 'targets']) && (
                    <p className="mt-1 text-xs font-medium text-danger">
                      {issueAt(['machine', 'states', si, 'targets'])}
                    </p>
                  )}
                  {editable && s.targets.length < 10 && (
                    <button
                      type="button"
                      className="mt-2 rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
                      onClick={() =>
                        set((d) => {
                          stateAt(d, si).targets.push({
                            instrumentId: instruments[0]?.id ?? '',
                            weightPct: '0',
                          });
                          return d;
                        })
                      }
                    >
                      + Add holding
                    </button>
                  )}
                  <p className="mt-2 text-xs text-ink-muted">
                    {goes.length > 0
                      ? `Entered by row${goes.length > 1 ? 's' : ''} ${goes.join(', ')}`
                      : 'No row goes here yet'}
                    {reads.length > 0 &&
                      ` · read by row${reads.length > 1 ? 's' : ''} ${reads.join(', ')}`}
                  </p>
                </li>
              );
            })}
          </ul>
          {editable && states.length < 20 && (
            <button
              type="button"
              className="mt-3 rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
              onClick={() =>
                set((d) => {
                  d.machine.states.push({
                    id: nextStateId(d.machine.states),
                    name: `State ${d.machine.states.length + 1}`,
                    targets: [],
                  });
                  return d;
                })
              }
            >
              + Add state
            </button>
          )}
        </Card>

        <Card aria-labelledby="machine-rows-heading">
          <h2 id="machine-rows-heading" className="text-lg font-semibold">
            Rows
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            At each daily close the rows are tested from the top, and the first true one decides the
            day. Order is meaning: move rows with the up and down buttons. The last row has no rule:
            the run starts in its state and lands there when nothing above is true.
          </p>
          {issueAt(['machine', 'rows']) && (
            <p className="mt-1 text-xs font-medium text-danger">{issueAt(['machine', 'rows'])}</p>
          )}
          <ol className="mt-3 space-y-3">
            {rows.map((row, ri) => (
              <RowEditor
                key={row.id}
                row={row}
                index={ri}
                count={rows.length}
                draft={draft}
                editable={editable}
                issueAt={issueAt}
                issueKeys={issueKeys}
                symbol={symbol}
                stateName={stateName}
                onChange={(next) =>
                  set((d) => {
                    d.machine.rows[ri] = next;
                    return d;
                  })
                }
                onMove={(delta) =>
                  set((d) => {
                    const [r] = d.machine.rows.splice(ri, 1);
                    if (r) d.machine.rows.splice(ri + delta, 0, r);
                    return d;
                  })
                }
                onRemove={() =>
                  set((d) => {
                    d.machine.rows.splice(ri, 1);
                    return d;
                  })
                }
              />
            ))}
          </ol>
          {editable && rows.length < 50 && (
            <button
              type="button"
              className="mt-3 rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
              onClick={() =>
                set((d) => {
                  // New rows go above the fallback, which stays last.
                  const at = Math.max(0, d.machine.rows.length - 1);
                  d.machine.rows.splice(at, 0, {
                    id: randomId(),
                    outcome: { kind: 'stay' },
                    condition: emptyGroup(),
                  });
                  return d;
                })
              }
            >
              + Add row above the last
            </button>
          )}
        </Card>

        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-base font-semibold">Risk and execution</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {(
              [
                ['maxOrderPctEquity', 'Largest order, % of equity'],
                ['maxStrategyPctEquity', 'Largest holding, % of equity'],
                ['priceCollarPct', 'Price collar, %'],
                ['maxDrawdownPct', 'Pause at drawdown, %'],
                ['dailyLossLimit', 'Daily loss limit, $'],
              ] as const
            ).map(([field, label]) => (
              <MiniInput
                key={field}
                id={`risk-${field}`}
                label={label}
                inputMode="decimal"
                value={draft.risk[field] ?? ''}
                placeholder="Not set"
                disabled={!editable}
                error={issueAt(['risk', field])}
                onChange={(e) =>
                  set((d) => {
                    const v = e.target.value.trim();
                    d.risk = Object.fromEntries(
                      Object.entries({ ...d.risk, [field]: v }).filter(([, x]) => x !== ''),
                    ) as MachineDefinition['risk'];
                    return d;
                  })
                }
              />
            ))}
            <MiniInput
              id="risk-maxActiveOrders"
              label="Working orders at most"
              inputMode="numeric"
              value={draft.risk.maxActiveOrders ?? ''}
              placeholder="Not set"
              disabled={!editable}
              error={issueAt(['risk', 'maxActiveOrders'])}
              onChange={(e) =>
                set((d) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) d.risk.maxActiveOrders = n;
                  else delete d.risk.maxActiveOrders;
                  return d;
                })
              }
            />
            <MiniInput
              id="exec-legTimeoutSec"
              label="Order timeout, seconds"
              inputMode="numeric"
              value={draft.execution.legTimeoutSec}
              disabled={!editable}
              error={issueAt(['execution', 'legTimeoutSec'])}
              onChange={(e) =>
                set((d) => {
                  d.execution.legTimeoutSec = Number.parseInt(e.target.value, 10) || 0;
                  return d;
                })
              }
            />
            <MiniSelect
              id="exec-marketHoursPolicy"
              label="Market closed"
              value={draft.execution.marketHoursPolicy}
              disabled={!editable}
              onChange={(e) =>
                set((d) => {
                  d.execution.marketHoursPolicy = e.target
                    .value as typeof d.execution.marketHoursPolicy;
                  return d;
                })
              }
            >
              <option value="queue">Queue for the next session</option>
              <option value="cancel">Cancel</option>
              <option value="extended_if_supported">Extended hours where possible</option>
            </MiniSelect>
          </div>
          <p className="mt-3 text-sm text-ink-muted">
            No strategy trailing stop on this form: the rows decide every exit. Fixed in v1: legs
            under 0.5% of equity are not traded, a switch with every leg under 5% places no orders,
            and an unfinished rebalance is retried for 5 trading days.
          </p>
        </details>

        {editable && (
          <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-line bg-surface py-3">
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? 'Saving…' : dirty ? 'Save state machine' : 'Saved'}
            </Button>
            {dirty && (
              <Button variant="secondary" onClick={() => setDraft(base)} disabled={saving}>
                Discard changes
              </Button>
            )}
            {issues.size > 0 && (
              <details className="text-sm text-danger">
                <summary className="cursor-pointer">
                  {issues.size} {issues.size === 1 ? 'problem' : 'problems'} to fix
                </summary>
                <ul className="mt-1 list-disc pl-5">
                  {[...new Set(issues.values())].map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </details>
            )}
            {error && <Alert>{error}</Alert>}
          </div>
        )}
      </div>
    </EditorContext.Provider>
  );
}

function RowEditor({
  row,
  index,
  count,
  draft,
  editable,
  issueAt,
  issueKeys,
  symbol,
  stateName,
  onChange,
  onMove,
  onRemove,
}: {
  row: MachineRow;
  index: number;
  count: number;
  draft: MachineDefinition;
  editable: boolean;
  issueAt: (path: readonly (string | number)[]) => string | undefined;
  /** Every path with a problem, so a row with one opens its rule. */
  issueKeys: readonly string[];
  symbol: (id: string) => string | undefined;
  stateName: (id: string) => string | undefined;
  onChange: (row: MachineRow) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const last = index === count - 1;
  const always = !row.condition || row.condition.children.length === 0;
  const scope: MachineRuleScope = {
    states: draft.machine.states.map((s) => ({ id: s.id, name: s.name })),
    rows: draft.machine.rows
      .map((r, i) => ({ id: r.id, number: i + 1, label: r.label }))
      .filter((r) => r.id !== row.id),
  };
  const rowName = (id: string) => {
    const i = draft.machine.rows.findIndex((r) => r.id === id);
    return i >= 0 ? `row ${i + 1}` : 'a removed row';
  };
  const path = ['machine', 'rows', index];
  // Rows read as one sentence; the rule editor opens for a new rule or a problem.
  const hasIssue = issueKeys.some((k) => k.startsWith(`machine.rows.${index}.condition`));
  const [open, setOpen] = useState(() => (!last && always) || hasIssue);
  return (
    <li
      aria-label={`Row ${n}`}
      className={cx('rounded-lg border-2 p-3', last ? 'border-dashed border-line' : 'border-line')}
    >
      <div className="flex flex-wrap items-end gap-3">
        <span className="pb-1 text-lg font-bold text-ink-muted">{n}</span>
        <div className="w-56">
          <MiniInput
            id={`row-${row.id}-label`}
            label="Label (optional)"
            value={row.label ?? ''}
            disabled={!editable}
            onChange={(e) => {
              const label = e.target.value;
              const rest = { ...row };
              delete rest.label;
              onChange(label ? { ...rest, label } : rest);
            }}
          />
        </div>
        <div className="w-64">
          <MiniSelect
            id={`row-${row.id}-outcome`}
            label="Then"
            value={row.outcome.kind === 'stay' ? '__stay__' : row.outcome.stateId}
            disabled={!editable}
            error={issueAt([...path, 'outcome'])}
            onChange={(e) =>
              onChange({
                ...row,
                outcome:
                  e.target.value === '__stay__'
                    ? { kind: 'stay' }
                    : { kind: 'go', stateId: e.target.value },
              })
            }
          >
            {!last && <option value="__stay__">Stay in the current state</option>}
            {draft.machine.states.map((s) => (
              <option key={s.id} value={s.id}>
                Go to {s.name}
              </option>
            ))}
          </MiniSelect>
        </div>
        {editable && (
          <div className="ml-auto flex gap-1">
            <RowButton label={`Move row ${n} up`} disabled={index === 0} onClick={() => onMove(-1)}>
              ↑ Up
            </RowButton>
            <RowButton label={`Move row ${n} down`} disabled={last} onClick={() => onMove(1)}>
              ↓ Down
            </RowButton>
            <RowButton
              label={`Remove row ${n}`}
              className="text-danger"
              disabled={count <= 1}
              onClick={onRemove}
            >
              Remove
            </RowButton>
          </div>
        )}
      </div>
      {issueAt(path) && <p className="mt-1 text-xs font-medium text-danger">{issueAt(path)}</p>}
      <p className="mt-2 max-w-prose text-sm">
        <span className="text-xs font-semibold text-ink-muted">Row {n} reads:</span>{' '}
        <span className="text-prose">
          When{' '}
          {always
            ? 'always'
            : describeMachineCondition(
                row.condition as MachineGroup,
                symbol,
                stateName,
                rowName,
              )}{' '}
          →{' '}
          {row.outcome.kind === 'stay' ? 'stay' : `go to ${stateName(row.outcome.stateId) ?? '?'}`}
        </span>
      </p>
      {last && always ? (
        <div className="mt-3">
          <p className="text-sm">
            <span className="font-semibold">Always</span>: the fallback. The run starts in{' '}
            {row.outcome.kind === 'go' ? (stateName(row.outcome.stateId) ?? '?') : '?'}.
            {editable && (
              <button
                type="button"
                className="ml-2 text-sm underline"
                onClick={() => onChange({ ...row, condition: emptyGroup() })}
              >
                Add a rule
              </button>
            )}
          </p>
        </div>
      ) : (
        <details
          className="mt-2"
          open={open}
          onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-sm font-medium">
            {editable ? 'Edit the rule' : 'The rule in full'}
            {hasIssue && <span className="ml-2 text-xs text-danger">Needs attention</span>}
          </summary>
          <div className="mt-2">
            <ConditionTreeEditor
              root={(row.condition ?? emptyGroup()) as unknown as ConditionGroup}
              onChange={(root) => onChange({ ...row, condition: root as unknown as MachineGroup })}
              label={`Row ${n} rule`}
              path={[...path, 'condition']}
              machine={scope}
            />
          </div>
        </details>
      )}
    </li>
  );
}
