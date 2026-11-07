'use client';

import {
  BUILTIN_UNIVERSES,
  EXCLUSION_LABELS,
  isIndicatorOnlyClass,
  PAPER_UNIVERSE_LIMIT,
  randomId,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_LABELS,
  type ConditionGroup,
  type ExitRule,
  type FireMode,
  type Schedule,
  type Selection,
  type StrategyDefinition,
} from '@tm/domain';
import { atrStopRule, toFixedLegs, toSelectionGroup, timeStopRule } from '@/lib/slot-edits';
import { ConditionTreeEditor } from './condition-editor';
import { useEditor } from './editor-context';
import { defaultMetricRef, MetricRefFields } from './expression-editor';
import { MiniInput, MiniSelect, RowButton } from './fields';

const UNIVERSE_LABELS: Record<(typeof BUILTIN_UNIVERSES)[number], string> = {
  sp500: 'S&P 500 (current members)',
};

const emptyGroup = (): ConditionGroup => ({
  kind: 'group',
  id: randomId(),
  op: 'and',
  negate: false,
  children: [],
});

/**
 * How Entry picks what to trade (v1.2 items 1 and 2): fixed legs that each
 * name an instrument, or a Selection group that ranks a universe by a
 * registry metric and holds the top N, equally weighted.
 */
export function EntryStructure({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { instruments: all, accounts, editable } = useEditor();
  // Only tradable instruments can be a leg or a universe member (v1.2 item 5).
  const instruments = all.filter((i) => !isIndicatorOnlyClass(i.assetClass));
  const selection = definition.entry.kind === 'selection';
  const account = accounts.find((a) => a.isDefault) ?? accounts[0];
  return (
    <div className="mb-4 rounded-md border border-line bg-surface p-3">
      <fieldset disabled={!editable} className="min-w-0">
        <legend className="text-sm font-semibold">What Entry trades</legend>
        <div className="mt-1 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="entry-kind"
              checked={!selection}
              onChange={() => onChange(toFixedLegs(definition, instruments[0]?.id ?? ''))}
            />
            Fixed legs: each leg names its instrument
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="entry-kind"
              checked={selection}
              onChange={() =>
                onChange(
                  toSelectionGroup(
                    definition,
                    instruments.slice(0, 10).map((i) => i.id),
                    account?.id ?? '',
                  ),
                )
              }
            />
            Selection group: rank a universe and hold the top N
          </label>
        </div>
      </fieldset>
      {selection && definition.entry.selection ? (
        <SelectionEditor
          selection={definition.entry.selection}
          onChange={(s) =>
            onChange({ ...definition, entry: { ...definition.entry, selection: s } })
          }
        />
      ) : (
        <FireModeEditor definition={definition} onChange={onChange} />
      )}
    </div>
  );
}

function SelectionEditor({
  selection,
  onChange,
}: {
  selection: Selection;
  onChange: (s: Selection) => void;
}) {
  const { instruments: all, issueAt, editable, universeClasses } = useEditor();
  // An index can be watched by a pre-filter but never held (v1.2 item 5).
  const instruments = all.filter((i) => !isIndicatorOnlyClass(i.assetClass));
  const path = ['entry', 'selection'] as const;
  const err = (...rest: (string | number)[]) => issueAt([...path, ...rest]);
  const u = selection.universe;
  const listed = u.type === 'list' ? new Set(u.instrumentIds) : new Set<string>();
  const set = (patch: Partial<Selection>) => onChange({ ...selection, ...patch });
  const id = (f: string) => `selection-${f}`;

  return (
    <div className="mt-3 space-y-3">
      <fieldset disabled={!editable} className="grid-fields-wide gap-2">
        <legend className="sr-only">Selection group</legend>
        <MiniSelect
          id={id('universe')}
          label="Universe"
          value={u.type === 'builtin' ? u.id : 'list'}
          onChange={(e) =>
            set({
              universe:
                e.target.value === 'list'
                  ? { type: 'list', instrumentIds: instruments.slice(0, 10).map((i) => i.id) }
                  : { type: 'builtin', id: e.target.value as (typeof BUILTIN_UNIVERSES)[number] },
            })
          }
        >
          {BUILTIN_UNIVERSES.map((b) => (
            <option key={b} value={b}>
              {UNIVERSE_LABELS[b]}
            </option>
          ))}
          <option value="list">My list of instruments</option>
        </MiniSelect>
        <MetricRefFields
          value={selection.ranking}
          classes={universeClasses}
          id={id}
          label="Rank by"
          error={err('ranking')}
          onChange={(ranking) => set({ ranking })}
        />
        <MiniSelect
          id={id('direction')}
          label="Order"
          value={selection.direction}
          onChange={(e) => set({ direction: e.target.value as Selection['direction'] })}
        >
          <option value="desc">Highest first</option>
          <option value="asc">Lowest first</option>
        </MiniSelect>
        <MiniSelect
          id={id('count-type')}
          label="Hold"
          value={selection.count.type}
          onChange={(e) =>
            set({
              count:
                e.target.value === 'percent'
                  ? { type: 'percent', value: 10 }
                  : { type: 'fixed', value: 3 },
            })
          }
        >
          <option value="fixed">The top N</option>
          <option value="percent">The top N percent</option>
        </MiniSelect>
        <MiniInput
          id={id('count')}
          label={selection.count.type === 'percent' ? 'Percent' : 'N'}
          type="number"
          min={selection.count.type === 'percent' ? 0.1 : 1}
          max={selection.count.type === 'percent' ? 100 : 600}
          step={selection.count.type === 'percent' ? 'any' : 1}
          value={Number.isFinite(selection.count.value) ? String(selection.count.value) : ''}
          error={err('count', 'value')}
          onChange={(e) =>
            set({
              count: {
                ...selection.count,
                value: e.target.value === '' ? Number.NaN : Number(e.target.value),
              },
            })
          }
        />
        <MiniSelect id={id('weighting')} label="Weighting" value="equal" disabled>
          <option value="equal">Equal weight</option>
        </MiniSelect>
      </fieldset>

      {u.type === 'builtin' && (
        <p className="text-xs text-ink-muted" role="note">
          Back tests use today&rsquo;s S&amp;P 500 members for the whole period, so companies that
          left the index are missing (survivorship bias): results look better than history did.
          Paper runs take list universes of up to {PAPER_UNIVERSE_LIMIT} instruments for now.
        </p>
      )}
      {u.type === 'list' && (
        <fieldset disabled={!editable} className="min-w-0">
          <legend className="text-xs font-medium text-ink-muted">
            Instruments in the list ({u.instrumentIds.length}). Find more with &ldquo;Find an
            instrument&rdquo; above.
          </legend>
          {err('universe', 'instrumentIds') && (
            <p className="text-xs font-medium text-danger">{err('universe', 'instrumentIds')}</p>
          )}
          <div className="mt-1 grid max-h-48 grid-cols-2 gap-1 overflow-y-auto text-sm sm:grid-cols-4">
            {instruments.map((i) => (
              <label key={i.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={listed.has(i.id)}
                  onChange={(e) =>
                    set({
                      universe: {
                        type: 'list',
                        instrumentIds: e.target.checked
                          ? [...u.instrumentIds, i.id]
                          : u.instrumentIds.filter((x) => x !== i.id),
                      },
                    })
                  }
                />
                {i.symbol}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div>
        <h4 className="text-sm font-semibold text-cond">Pre-filter</h4>
        <p className="mb-2 text-xs text-ink-muted">
          Checked for each member before ranking, with &ldquo;Each selected instrument&rdquo;
          meaning that member. Members that fail are left out (
          {EXCLUSION_LABELS.filter_false.toLowerCase()}), and so are members it can&rsquo;t be
          decided for yet.
        </p>
        {selection.preFilter ? (
          <>
            <ConditionTreeEditor
              root={selection.preFilter}
              label="Pre-filter"
              path={[...path, 'preFilter']}
              onChange={(preFilter) => set({ preFilter })}
            />
            {editable && (
              <RowButton
                label="Remove the pre-filter"
                className="mt-1 text-danger"
                onClick={() => {
                  const { preFilter: _p, ...rest } = selection;
                  void _p;
                  onChange(rest);
                }}
              >
                Remove pre-filter
              </RowButton>
            )}
          </>
        ) : (
          editable && (
            <RowButton label="Add a pre-filter" onClick={() => set({ preFilter: emptyGroup() })}>
              + Add pre-filter
            </RowButton>
          )
        )}
      </div>
      <p className="text-xs text-ink-muted">
        The Entry conditions above gate the whole selection, for example a market regime filter.
        Leave them empty to rebalance on every scheduled date. Instruments that drop out of the top
        N are sold at the next rebalance.
      </p>
    </div>
  );
}

/** With per-leg conditions: enter every leg that qualifies, or only the best one (item 2). */
function FireModeEditor({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { editable, instruments } = useEditor();
  const legs = definition.entry.orders;
  const fire: FireMode = definition.entry.fireMode ?? { mode: 'allPassing' };
  const anyLegCondition = legs.some((o) => o.legCondition);
  if (legs.length < 2 && !anyLegCondition && fire.mode === 'allPassing') return null;
  const classes = [
    ...new Set(
      legs.map((o) => instruments.find((i) => i.id === o.instrumentId)?.assetClass ?? 'stock'),
    ),
  ];
  const set = (fireMode: FireMode | undefined) => {
    const { fireMode: _f, ...entry } = definition.entry;
    void _f;
    onChange({ ...definition, entry: fireMode ? { ...entry, fireMode } : entry });
  };
  return (
    <fieldset disabled={!editable} className="mt-3 grid-fields-wide gap-2">
      <legend className="text-xs text-ink-muted">
        Each Entry leg can have its own conditions (&ldquo;+ Add a condition for this leg&rdquo;
        below). They are checked together with the Entry conditions above.
      </legend>
      <MiniSelect
        id="fire-mode"
        label="When several legs qualify"
        value={fire.mode}
        onChange={(e) =>
          set(
            e.target.value === 'bestByMetric'
              ? { mode: 'bestByMetric', metric: defaultMetricRef() }
              : undefined,
          )
        }
      >
        <option value="allPassing">Enter every leg that qualifies</option>
        <option value="bestByMetric">Enter only the best one, by a metric</option>
      </MiniSelect>
      {fire.mode === 'bestByMetric' && (
        <MetricRefFields
          value={fire.metric}
          classes={classes}
          id={(f) => `fire-${f}`}
          label="Best by (highest)"
          onChange={(metric) => set({ mode: 'bestByMetric', metric })}
        />
      )}
    </fieldset>
  );
}

/**
 * Rules that exit alongside the Exit conditions (v1.2 item 4): the first to
 * trigger exits. They run on every bar, whatever the schedule.
 */
export function ExitRulesEditor({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { editable, issueAt } = useEditor();
  const rules = definition.exit.rules ?? [];
  const setRules = (next: ExitRule[]) => {
    const { rules: _r, ...exit } = definition.exit;
    void _r;
    onChange({ ...definition, exit: next.length > 0 ? { ...exit, rules: next } : exit });
  };
  const hasTimeStop = rules.some((r) => r.kind === 'timeStop');
  const hasAtrStop = rules.some((r) => r.kind === 'atrStop');
  const patch = (i: number, p: Partial<ExitRule>) =>
    setRules(rules.map((x, j) => (j === i ? ({ ...x, ...p } as ExitRule) : x)));
  const remove = (i: number) => setRules(rules.filter((_, j) => j !== i));
  const asInt = (v: string) => (v === '' ? Number.NaN : Number(v));
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-base font-semibold text-cond">Exit rules</h3>
      <p className="mb-2 text-sm text-ink-muted">
        Combined with the Exit conditions by OR: whichever triggers first exits. Checked at every
        bar close, never held for the schedule.
      </p>
      {rules.length > 0 && (
        <ul className="space-y-2">
          {rules.map((r, i) => (
            <li
              key={r.id}
              className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface p-2"
            >
              {r.kind === 'timeStop' ? (
                <>
                  <MiniInput
                    id={`rule-${r.id}-bars`}
                    label="Exit after this many trading days held"
                    type="number"
                    min={1}
                    max={2520}
                    step={1}
                    disabled={!editable}
                    value={Number.isFinite(r.barsHeld) ? String(r.barsHeld) : ''}
                    error={issueAt(['exit', 'rules', i, 'barsHeld'])}
                    onChange={(e) => patch(i, { barsHeld: asInt(e.target.value) })}
                  />
                  <p className="flex-1 pb-1 text-xs text-ink-muted">
                    Counts the day the position opened. With daily bars, 5 days exits at the sixth
                    open, after the position was held through five closes.
                  </p>
                </>
              ) : (
                <>
                  <MiniInput
                    id={`rule-${r.id}-mult`}
                    label="ATR stop: ATRs from the entry price"
                    inputMode="decimal"
                    disabled={!editable}
                    value={r.atrMultiple}
                    error={issueAt(['exit', 'rules', i, 'atrMultiple'])}
                    onChange={(e) => patch(i, { atrMultiple: e.target.value.trim() })}
                  />
                  <MiniInput
                    id={`rule-${r.id}-period`}
                    label="ATR period (daily bars)"
                    type="number"
                    min={1}
                    max={500}
                    step={1}
                    disabled={!editable}
                    value={Number.isFinite(r.atrPeriod) ? String(r.atrPeriod) : ''}
                    error={issueAt(['exit', 'rules', i, 'atrPeriod'])}
                    onChange={(e) => patch(i, { atrPeriod: asInt(e.target.value) })}
                  />
                  <p className="flex-1 pb-1 text-xs text-ink-muted">
                    The stop is set once, at entry: the entry price minus (long) or plus (short)
                    this many ATRs, using the ATR on the entry day. It exits at the next open after
                    a daily close beyond it. It does not trail.
                  </p>
                </>
              )}
              {editable && (
                <RowButton
                  label={r.kind === 'timeStop' ? 'Remove the time stop' : 'Remove the ATR stop'}
                  className="text-danger"
                  onClick={() => remove(i)}
                >
                  Remove
                </RowButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="mt-1 flex flex-wrap gap-2">
          {!hasTimeStop && (
            <RowButton label="Add a time stop" onClick={() => setRules([...rules, timeStopRule()])}>
              + Exit after N trading days held
            </RowButton>
          )}
          {!hasAtrStop && (
            <RowButton label="Add an ATR stop" onClick={() => setRules([...rules, atrStopRule()])}>
              + Stop N ATRs from the entry price
            </RowButton>
          )}
        </div>
      )}
    </div>
  );
}

/** When Entry and re-selection are evaluated (v1.2 item 4). */
export function ScheduleField({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { editable } = useEditor();
  const value = definition.schedule?.frequency ?? 'daily';
  return (
    <div className="mb-3">
      <MiniSelect
        id="schedule"
        label="Evaluate Entry and re-selection"
        value={value}
        disabled={!editable}
        aria-describedby="schedule-help"
        onChange={(e) => {
          const frequency = e.target.value as Schedule['frequency'];
          const { schedule: _s, ...rest } = definition;
          void _s;
          onChange(frequency === 'daily' ? rest : { ...rest, schedule: { frequency } });
        }}
      >
        {SCHEDULE_FREQUENCIES.map((f) => (
          <option key={f} value={f}>
            {SCHEDULE_LABELS[f]}
          </option>
        ))}
      </MiniSelect>
      <p id="schedule-help" className="mt-1 text-xs text-ink-muted">
        The schedule gates entries and re-selection, never risk exits: Exit conditions, the time
        stop and risk limits still run at every bar. A scheduled date is evaluated once, after that
        day&rsquo;s NYSE close.
      </p>
    </div>
  );
}
