'use client';

import {
  BUILTIN_UNIVERSES,
  EXCLUSION_LABELS,
  isIndicatorOnlyClass,
  PAPER_UNIVERSE_LIMIT,
  randomId,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_LABELS,
  SCHEDULE_BAR_MINUTES,
  defaultSchedule,
  isScheduled,
  sizesFromAtr,
  slotModeOf,
  type ConditionGroup,
  type ExitRule,
  type RiskDistance,
  type Schedule,
  type Selection,
  type StrategyDefinition,
} from '@tm/domain';
import {
  atrStopRule,
  DEFAULT_RISK_DISTANCE,
  expectedMoveRule,
  trailingStopRule,
  fromLegsSelection,
  toFixedLegs,
  toLegsSelection,
  toSelectionGroup,
  timeStopRule,
} from '@/lib/slot-edits';
import { ConditionTreeEditor } from './condition-editor';
import { useEditor } from './editor-context';
import { MetricRefFields } from './expression-editor';
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
  const legsRanked = definition.entry.selection?.universe.type === 'legs';
  const selection = definition.entry.kind === 'selection' && !legsRanked;
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
        <LegsChoice definition={definition} onChange={onChange} />
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
        {u.type === 'legs' ? (
          <p className="self-end pb-1 text-sm">
            <span className="font-semibold">Universe:</span> these Entry legs
          </p>
        ) : (
          <MiniSelect
            id={id('universe')}
            label="Universe"
            value={u.type === 'builtin' ? u.id : 'list'}
            onChange={(e) =>
              set({
                universe:
                  e.target.value === 'list'
                    ? { type: 'list', instrumentIds: instruments.slice(0, 10).map((i) => i.id) }
                    : {
                        type: 'builtin',
                        id: e.target.value as (typeof BUILTIN_UNIVERSES)[number],
                      },
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
        )}
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
      <label className="flex items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          disabled={!editable}
          checked={selection.keepHoldings === true}
          onChange={(e) => {
            const { keepHoldings: _k, ...rest } = selection;
            void _k;
            onChange(e.target.checked ? { ...rest, keepHoldings: true } : rest);
          }}
        />
        Keep each pick until its own exit (don&rsquo;t sell it when it leaves the top N)
      </label>
      <p className="text-xs text-ink-muted">
        {u.type === 'legs'
          ? 'Each leg must pass its own conditions and the pre-filter; the qualifying legs are ranked and the top N enter, each with its own quantity.'
          : selection.keepHoldings
            ? 'Every selected instrument gets an equal share (1/N) of the template leg’s total amount and is held until the Exit condition or an exit rule fires; new picks still enter at each rebalance, so more than N can be held.'
            : 'Every selected instrument is held with an equal share of the template leg’s total amount. Instruments that drop out of the top N are sold at the next rebalance.'}
      </p>
    </div>
  );
}

/**
 * With several fixed legs: enter every leg that qualifies, or only the best
 * ones by a metric (ADR 0049), which is a Selection group of these legs.
 */
function LegsChoice({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { editable } = useEditor();
  const legs = definition.entry.orders;
  const ranked = definition.entry.selection?.universe.type === 'legs';
  const anyLegCondition = legs.some((o) => o.legCondition);
  if (legs.length < 2 && !anyLegCondition && !ranked) return null;
  return (
    <div className="mt-3 space-y-2">
      <fieldset disabled={!editable} className="grid-fields-wide gap-2">
        <legend className="text-xs text-ink-muted">
          Each Entry leg can have its own conditions (&ldquo;+ Add a condition for this leg&rdquo;
          below). They are checked together with the regime gate.
        </legend>
        <MiniSelect
          id="legs-choice"
          label="When several legs qualify"
          value={ranked ? 'best' : 'all'}
          onChange={(e) =>
            onChange(
              e.target.value === 'best'
                ? toLegsSelection(definition)
                : fromLegsSelection(definition),
            )
          }
        >
          <option value="all">Enter every leg that qualifies</option>
          <option value="best">Enter only the best ones, ranked by a metric</option>
        </MiniSelect>
      </fieldset>
      {ranked && definition.entry.selection && (
        <SelectionEditor
          selection={definition.entry.selection}
          onChange={(s) =>
            onChange({ ...definition, entry: { ...definition.entry, selection: s } })
          }
        />
      )}
    </div>
  );
}

/**
 * The Entry's one risk distance (ADR 0049): ATR period and multiple, entered
 * once and used both to size risk-based legs and, unless it has its own, by
 * the ATR stop. Shown when a leg sizes from it or Exit has an ATR stop.
 */
export function RiskDistanceEditor({
  definition,
  onChange,
  idPrefix = '',
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
  idPrefix?: string;
}) {
  const { editable, issueAt } = useEditor();
  const sized = definition.entry.orders.some((o) => sizesFromAtr(o));
  const stop = (definition.exit.rules ?? []).find((r) => r.kind === 'atrStop');
  const usesEntry = !!stop && stop.kind === 'atrStop' && !stop.override;
  if (!sized && !usesEntry && !definition.entry.risk) return null;
  const value = definition.entry.risk ?? DEFAULT_RISK_DISTANCE;
  const set = (patch: Partial<RiskDistance>) =>
    onChange({ ...definition, entry: { ...definition.entry, risk: { ...value, ...patch } } });
  const uses = [sized && 'risk-based sizing', usesEntry && 'the ATR stop'].filter(Boolean);
  return (
    <fieldset
      disabled={!editable}
      className="mb-4 rounded-md border border-line bg-surface p-3"
      aria-describedby={`${idPrefix}risk-distance-help`}
    >
      <legend className="text-sm font-semibold">Risk distance</legend>
      <div className="grid-fields-wide gap-2">
        <MiniInput
          id={`${idPrefix}risk-atr-multiple`}
          label="ATRs from the entry price"
          inputMode="decimal"
          value={value.atrMultiple}
          error={issueAt(['entry', 'risk', 'atrMultiple'])}
          onChange={(e) => set({ atrMultiple: e.target.value.trim() })}
        />
        <MiniInput
          id={`${idPrefix}risk-atr-period`}
          label="ATR period (daily bars)"
          type="number"
          min={1}
          max={500}
          step={1}
          value={Number.isFinite(value.atrPeriod) ? String(value.atrPeriod) : ''}
          error={issueAt(['entry', 'risk', 'atrPeriod'])}
          onChange={(e) =>
            set({ atrPeriod: e.target.value === '' ? Number.NaN : Number(e.target.value) })
          }
        />
      </div>
      <p id={`${idPrefix}risk-distance-help`} className="mt-1 text-xs text-ink-muted">
        Entered once for this Entry{uses.length > 0 ? `, and used by ${uses.join(' and ')}` : ''}.
        The ATR is read on the entry day.
      </p>
    </fieldset>
  );
}

/**
 * Every way a position exits, in one list (ADR 0049): the Exit condition
 * above, the holding-period exit, the ATR stop, the expected-move exit and, with a Selection group,
 * the rebalance. Whichever comes first exits. They run on every bar,
 * whatever the schedule.
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
    const hasStop = next.some((r) => r.kind === 'atrStop');
    // An ATR stop reads the Entry's risk distance: give a new one the default.
    const entry =
      hasStop && !definition.entry.risk
        ? { ...definition.entry, risk: { ...DEFAULT_RISK_DISTANCE } }
        : definition.entry;
    onChange({ ...definition, entry, exit: next.length > 0 ? { ...exit, rules: next } : exit });
  };
  const hasTimeStop = rules.some((r) => r.kind === 'timeStop');
  const hasAtrStop = rules.some((r) => r.kind === 'atrStop');
  const hasMoveExit = rules.some((r) => r.kind === 'expectedMove');
  const hasTrailingStop = rules.some((r) => r.kind === 'trailingStop');
  const replace = (i: number, r: ExitRule) => setRules(rules.map((x, j) => (j === i ? r : x)));
  const remove = (i: number) => setRules(rules.filter((_, j) => j !== i));
  const asInt = (v: string) => (v === '' ? Number.NaN : Number(v));
  const mode = slotModeOf(definition);
  const rebalances = mode === 'selection' || (mode === 'legs' && isScheduled(definition));
  const distance = definition.entry.risk ?? DEFAULT_RISK_DISTANCE;
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-base font-semibold text-cond">Exits</h3>
      <p className="mb-2 text-sm text-ink-muted">
        Whichever comes first exits: the Exit condition above or one of these. Checked at every bar
        close, never held for the schedule.
      </p>
      <ul className="space-y-2">
        {rules.map((r, i) => {
          const own = r.kind === 'atrStop' ? r.override : undefined;
          return (
            <li
              key={r.id}
              className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-surface p-2"
            >
              {r.kind === 'timeStop' ? (
                <>
                  <MiniInput
                    id={`rule-${r.id}-bars`}
                    label="Holding-period exit: trading days held"
                    type="number"
                    min={1}
                    max={2520}
                    step={1}
                    disabled={!editable}
                    value={Number.isFinite(r.barsHeld) ? String(r.barsHeld) : ''}
                    error={issueAt(['exit', 'rules', i, 'barsHeld'])}
                    onChange={(e) => replace(i, { ...r, barsHeld: asInt(e.target.value) })}
                  />
                  <p className="flex-1 pb-1 text-xs text-ink-muted">
                    Counts the day the position opened. With daily bars, 5 days exits at the sixth
                    open, after the position was held through five closes.
                  </p>
                </>
              ) : r.kind === 'trailingStop' ? (
                <>
                  <MiniInput
                    id={`rule-${r.id}-percent`}
                    label="Trailing stop: % below the highest close since entry"
                    inputMode="decimal"
                    disabled={!editable}
                    value={r.percent}
                    error={issueAt(['exit', 'rules', i, 'percent'])}
                    onChange={(e) => replace(i, { ...r, percent: e.target.value.trim() })}
                  />
                  <p className="flex-1 pb-1 text-xs text-ink-muted">
                    Starts at the entry price and rises with each higher daily close (falls with
                    each lower one, for a short). It exits at the next open after a daily close more
                    than this far from that peak.
                  </p>
                </>
              ) : r.kind === 'expectedMove' ? (
                <div className="w-full space-y-2">
                  <p className="text-sm font-semibold">Exit beyond the expected move at entry</p>
                  <div className="grid-fields-wide gap-2">
                    <MiniInput
                      id={`rule-${r.id}-multiple`}
                      label="Expected moves from the entry price"
                      inputMode="decimal"
                      disabled={!editable}
                      value={r.multiple}
                      error={issueAt(['exit', 'rules', i, 'multiple'])}
                      onChange={(e) => replace(i, { ...r, multiple: e.target.value.trim() })}
                    />
                    <MiniSelect
                      id={`rule-${r.id}-horizon`}
                      label="Expected move over"
                      disabled={!editable}
                      value={String(r.horizon)}
                      onChange={(e) =>
                        replace(i, { ...r, horizon: e.target.value === '1' ? 1 : 5 })
                      }
                    >
                      <option value="5">5 days</option>
                      <option value="1">1 day</option>
                    </MiniSelect>
                    <MiniSelect
                      id={`rule-${r.id}-side`}
                      label="Exit on"
                      disabled={!editable}
                      value={r.side}
                      onChange={(e) => replace(i, { ...r, side: e.target.value as typeof r.side })}
                    >
                      <option value="either">A move either way</option>
                      <option value="gain">A gain only</option>
                      <option value="loss">A loss only</option>
                    </MiniSelect>
                  </div>
                  <p className="text-xs text-ink-muted">
                    Set once, at entry: the options expected move recorded for the first Entry
                    leg&rsquo;s stock on the entry day. It exits at the next open after a daily
                    close more than that many expected moves from the entry price. Needs the CBOE
                    options feed and a recorded stock or ETF.
                  </p>
                </div>
              ) : (
                <div className="w-full space-y-2">
                  <p className="text-sm font-semibold">ATR stop</p>
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={!r.override}
                      onChange={(e) => {
                        if (e.target.checked) {
                          const { override: _o, ...rest } = r;
                          void _o;
                          replace(i, rest);
                        } else replace(i, { ...r, override: { ...distance } });
                      }}
                    />
                    Use the Entry&rsquo;s risk distance ({distance.atrMultiple} × ATR(
                    {distance.atrPeriod}))
                  </label>
                  {own && (
                    <div className="grid-fields-wide gap-2">
                      <MiniInput
                        id={`rule-${r.id}-mult`}
                        label="Own distance: ATRs from the entry price"
                        inputMode="decimal"
                        disabled={!editable}
                        value={own.atrMultiple}
                        error={issueAt(['exit', 'rules', i, 'override', 'atrMultiple'])}
                        onChange={(e) =>
                          replace(i, {
                            ...r,
                            override: { ...own, atrMultiple: e.target.value.trim() },
                          })
                        }
                      />
                      <MiniInput
                        id={`rule-${r.id}-period`}
                        label="Own ATR period (daily bars)"
                        type="number"
                        min={1}
                        max={500}
                        step={1}
                        disabled={!editable}
                        value={Number.isFinite(own.atrPeriod) ? String(own.atrPeriod) : ''}
                        error={issueAt(['exit', 'rules', i, 'override', 'atrPeriod'])}
                        onChange={(e) =>
                          replace(i, {
                            ...r,
                            override: { ...own, atrPeriod: asInt(e.target.value) },
                          })
                        }
                      />
                    </div>
                  )}
                  <p className="text-xs text-ink-muted">
                    Set once, at entry: the entry price minus (long) or plus (short) the distance,
                    using the ATR on the entry day. It exits at the next open after a daily close
                    beyond it. It does not trail.
                  </p>
                </div>
              )}
              {editable && (
                <RowButton
                  label={
                    r.kind === 'timeStop'
                      ? 'Remove the holding-period exit'
                      : r.kind === 'expectedMove'
                        ? 'Remove the expected-move exit'
                        : r.kind === 'trailingStop'
                          ? 'Remove the trailing stop'
                          : 'Remove the ATR stop'
                  }
                  className="text-danger"
                  onClick={() => remove(i)}
                >
                  Remove
                </RowButton>
              )}
            </li>
          );
        })}
        {rebalances && (
          <li
            className="rounded-md border border-dashed border-line bg-surface p-2"
            aria-label="Rebalance exits (always on)"
          >
            <p className="text-sm font-semibold">Rebalance exits</p>
            <p className="text-xs text-ink-muted">
              {definition.entry.selection?.keepHoldings
                ? 'Off: each pick is held until one of its own exits fires (set under Selection group).'
                : 'Sells whatever leaves the top N at the next rebalance. On with a Selection group unless it keeps its picks.'}
            </p>
          </li>
        )}
      </ul>
      {editable && (
        <div className="mt-1 flex flex-wrap gap-2">
          {!hasTimeStop && (
            <RowButton
              label="Add a holding-period exit"
              onClick={() => setRules([...rules, timeStopRule()])}
            >
              + Holding-period exit
            </RowButton>
          )}
          {!hasAtrStop && (
            <RowButton label="Add an ATR stop" onClick={() => setRules([...rules, atrStopRule()])}>
              + ATR stop
            </RowButton>
          )}
          {!hasTrailingStop && (
            <RowButton
              label="Add a trailing stop"
              onClick={() => setRules([...rules, trailingStopRule()])}
            >
              + Trailing stop
            </RowButton>
          )}
          {!hasMoveExit && (
            <RowButton
              label="Add an exit beyond the expected move at entry"
              onClick={() => setRules([...rules, expectedMoveRule()])}
            >
              + Expected-move exit
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
  // Until a schedule is picked, it follows the bars the rules read (N184).
  const picked = definition.schedule?.frequency;
  const value = picked ?? defaultSchedule(definition);
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
          onChange({ ...definition, schedule: { frequency } });
        }}
      >
        <optgroup label="Every bar">
          {SCHEDULE_FREQUENCIES.filter((f) => SCHEDULE_BAR_MINUTES[f] !== undefined).map((f) => (
            <option key={f} value={f}>
              {SCHEDULE_LABELS[f]}
            </option>
          ))}
        </optgroup>
        <optgroup label="Once per period, after the NYSE close">
          {SCHEDULE_FREQUENCIES.filter((f) => SCHEDULE_BAR_MINUTES[f] === undefined).map((f) => (
            <option key={f} value={f}>
              {SCHEDULE_LABELS[f]}
            </option>
          ))}
        </optgroup>
      </MiniSelect>
      <p id="schedule-help" className="mt-1 text-xs text-ink-muted">
        {picked === undefined && 'Matches the bars your conditions read until you pick one. '}
        The schedule gates entries and re-selection, never exits: Exit conditions, the
        holding-period exit and risk limits still run at every bar. An &ldquo;Every bar&rdquo;
        choice checks Entry when each bar of that size closes; the others check once, after the NYSE
        close of the scheduled day.
      </p>
    </div>
  );
}
