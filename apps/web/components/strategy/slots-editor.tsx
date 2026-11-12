'use client';

import {
  AVAILABLE_STOCK_GROUPS,
  type BuiltinUniverse,
  stockGroup,
  EXCLUSION_LABELS,
  getMetric,
  isIndicatorOnlyClass,
  randomId,
  SCHEDULE_BARS,
  SCHEDULE_BAR_LABELS,
  SCHEDULE_DAYS,
  SCHEDULE_DAYS_LABELS,
  SCHEDULE_WHICH,
  SCHEDULE_WHICH_LABELS,
  isCalendarSchedule,
  scheduleLabel,
  defaultSchedule,
  hasLeftGroupRule,
  stopCloseWord,
  isScheduled,
  sizesFromAtr,
  slotModeOf,
  type ConditionGroup,
  type ExitRule,
  type GroupTrade,
  type RiskDistance,
  type Schedule,
  type ScheduleBar,
  type ScheduleDays,
  type ScheduleWhich,
  type StrategyDefinition,
} from '@tm/domain';
import { Card } from '@tm/ui';
import {
  addAsset,
  DEFAULT_RISK_DISTANCE,
  defaultRanking,
  fromLegsSelection,
  removeAsset,
  replaceAsset,
  toAssets,
  toGroup,
  tradedAssets,
  withExitShortcut,
  withLeftGroup,
  withTrailingCondition,
} from '@/lib/slot-edits';
import { ConditionTreeEditor } from './condition-editor';
import { useEditor } from './editor-context';
import { MetricRefFields } from './expression-editor';
import { MiniInput, MiniSelect, RowButton } from './fields';
import { InstrumentSelect } from './instrument-select';
import { SymbolLookup } from './symbol-lookup';

/** A built-in group's name in the Members select, with its size. */
const universeLabel = (id: BuiltinUniverse) => {
  const g = stockGroup(id);
  return `${g.label} (${g.members.size.toLocaleString('en-US')} current members)`;
};

const emptyGroup = (): ConditionGroup => ({
  kind: 'group',
  id: randomId(),
  op: 'and',
  negate: false,
  children: [],
});

/**
 * What to trade (ADR 0073), the first part of a strategy: specific assets
 * (the Entry legs' instruments, picked here and written to the legs), or a
 * group with an optional filter and an optional ranking.
 */
export function WhatToTrade({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { instruments: all, accounts, editable, issueAt } = useEditor();
  // Only tradable instruments can be traded (v1.2 item 5).
  const instruments = all.filter((i) => !isIndicatorOnlyClass(i.assetClass));
  const group = definition.trade.kind === 'group' ? definition.trade : undefined;
  const account = accounts.find((a) => a.isDefault) ?? accounts[0];
  const assets = tradedAssets(definition);
  return (
    <Card className="border-l-4 border-l-line-strong">
      <h2 id="trade-heading" className="text-lg font-semibold">
        What to trade
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        Specific stocks or ETFs, or a group to pick from with an optional filter and ranking.
      </p>
      <fieldset disabled={!editable} className="min-w-0">
        <legend className="sr-only">What to trade</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="trade-kind"
              checked={!group}
              onChange={() => onChange(toAssets(definition, assets[0] ?? instruments[0]?.id ?? ''))}
            />
            Specific assets
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="trade-kind"
              checked={!!group}
              onChange={() =>
                onChange(
                  toGroup(
                    definition,
                    instruments.slice(0, 10).map((i) => i.id),
                    account?.id ?? '',
                  ),
                )
              }
            />
            A group: filter and rank its members
          </label>
        </div>
      </fieldset>
      {issueAt(['trade']) && (
        <p className="mt-2 text-xs font-medium text-danger">{issueAt(['trade'])}</p>
      )}
      {group ? (
        <GroupEditor
          group={group}
          onChange={(trade) => onChange({ ...definition, trade })}
          sellsLeavers={hasLeftGroupRule(definition)}
          leavesSold={readsContextEntry(definition)}
          onSellsLeavers={(on) => onChange(withLeftGroup(definition, on))}
        />
      ) : (
        <AssetsEditor definition={definition} assets={assets} onChange={onChange} />
      )}
    </Card>
  );
}

/** Specific assets: one picker per asset; each change is written to every leg and condition. */
function AssetsEditor({
  definition,
  assets,
  onChange,
}: {
  definition: StrategyDefinition;
  assets: string[];
  onChange: (def: StrategyDefinition) => void;
}) {
  const { accounts, editable } = useEditor();
  const account = accounts.find((a) => a.isDefault) ?? accounts[0];
  return (
    <div className="mt-3 space-y-2">
      {assets.length === 0 && (
        <InstrumentSelect
          id="trade-asset-new"
          label="Stock or ETF"
          value=""
          allowContext={false}
          tradableOnly
          onChange={(id) => id && onChange(addAsset(definition, id, account?.id ?? ''))}
        />
      )}
      {assets.map((id, i) => (
        <div key={id} className="flex flex-wrap items-end gap-2">
          <InstrumentSelect
            id={`trade-asset-${i}`}
            label={assets.length === 1 ? 'Stock or ETF' : `Asset ${i + 1}`}
            value={id}
            allowContext={false}
            tradableOnly
            onChange={(next) => next && next !== id && onChange(replaceAsset(definition, id, next))}
          />
          {editable && assets.length > 1 && (
            <RowButton
              label={`Remove asset ${i + 1}`}
              className="text-danger"
              onClick={() => onChange(removeAsset(definition, id))}
            >
              Remove
            </RowButton>
          )}
        </div>
      ))}
      {editable && assets.length > 0 && (
        <SymbolLookup
          id="trade-add-asset"
          label="Trade another asset together with these"
          actionLabel="Add"
          tradableOnly
          onPick={(found) =>
            !assets.includes(found.id) &&
            onChange(addAsset(definition, found.id, account?.id ?? ''))
          }
        />
      )}
      <p className="text-xs text-ink-muted">
        {assets.length > 1
          ? 'These are entered and exited together, as one position. Changing an asset here changes it in every leg and condition.'
          : 'Changing the asset here changes it in every leg and condition that names it.'}
      </p>
      {definition.entry.rankedLegs && (
        <RankedLegsNote definition={definition} onChange={onChange} />
      )}
    </div>
  );
}

/** Schema 2's ranked legs, kept as saved (ADR 0073): shown, and can be turned off. */
function RankedLegsNote({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const { editable } = useEditor();
  const r = definition.entry.rankedLegs;
  if (!r) return null;
  const n = r.count.type === 'fixed' ? `top ${r.count.value}` : `top ${r.count.value}%`;
  return (
    <div className="rounded-md border border-dashed border-line bg-surface p-2 text-sm" role="note">
      <p>
        <span className="font-semibold">Kept as saved:</span> only the {n} qualifying{' '}
        {definition.entry.orders.length === 1 ? 'leg' : 'legs'} by{' '}
        {getMetric(r.metric)?.label ?? r.metric} ({r.direction === 'desc' ? 'highest' : 'lowest'}{' '}
        first) enter. It runs as before; to build this today, use a group of these assets with a
        ranking.
      </p>
      {editable && (
        <RowButton
          label="Enter every qualifying leg instead"
          className="mt-1"
          onClick={() => onChange(fromLegsSelection(definition))}
        >
          Enter every qualifying leg instead
        </RowButton>
      )}
    </div>
  );
}

function GroupEditor({
  group,
  onChange,
  sellsLeavers,
  leavesSold,
  onSellsLeavers,
}: {
  group: GroupTrade;
  onChange: (g: GroupTrade) => void;
  /** Whether Exit has the Left the group rule (ADR 0073), shown here as a group setting (N222). */
  sellsLeavers: boolean;
  /** Whether Enter when reads "this stock", so holdings are not sold while it is false. */
  leavesSold: boolean;
  onSellsLeavers: (on: boolean) => void;
}) {
  const { instruments: all, issueAt, editable, universeClasses } = useEditor();
  // An index can be watched by a filter but never held (v1.2 item 5).
  const instruments = all.filter((i) => !isIndicatorOnlyClass(i.assetClass));
  const err = (...rest: (string | number)[]) => issueAt(['trade', ...rest]);
  const u = group.universe;
  const listed = u.type === 'list' ? new Set(u.instrumentIds) : new Set<string>();
  const set = (patch: Partial<GroupTrade>) => onChange({ ...group, ...patch });
  const id = (f: string) => `trade-${f}`;
  const ranking = group.ranking;
  const setRanking = (patch: Partial<NonNullable<GroupTrade['ranking']>>) =>
    ranking && set({ ranking: { ...ranking, ...patch } });

  return (
    <div className="mt-3 space-y-4">
      <section aria-labelledby={id('group-heading')}>
        <h3 id={id('group-heading')} className="text-sm font-semibold">
          1. Group
        </h3>
        <fieldset disabled={!editable} className="grid-fields-wide mt-1 gap-2">
          <legend className="sr-only">Group</legend>
          <MiniSelect
            id={id('universe')}
            label="Members"
            value={u.type === 'builtin' ? u.id : 'list'}
            error={err('universe')}
            onChange={(e) =>
              set({
                universe:
                  e.target.value === 'list'
                    ? { type: 'list', instrumentIds: instruments.slice(0, 10).map((i) => i.id) }
                    : {
                        type: 'builtin',
                        id: e.target.value as BuiltinUniverse,
                      },
              })
            }
          >
            <optgroup label="Indexes">
              {AVAILABLE_STOCK_GROUPS.filter((g) => g.kind === 'index').map((g) => (
                <option key={g.id} value={g.id}>
                  {universeLabel(g.id)}
                </option>
              ))}
            </optgroup>
            <optgroup label="S&amp;P 500 sectors">
              {AVAILABLE_STOCK_GROUPS.filter((g) => g.kind === 'sector').map((g) => (
                <option key={g.id} value={g.id}>
                  {universeLabel(g.id)}
                </option>
              ))}
            </optgroup>
            <option value="list">My list of instruments</option>
          </MiniSelect>
        </fieldset>
        {u.type === 'builtin' && (
          <p className="mt-1 text-xs text-ink-muted" role="note">
            Back tests use today&rsquo;s {stockGroup(u.id).label} members for the whole period, so
            companies that left the group are missing (survivorship bias): results look better than
            history did. Paper runs use the members on each day they run.
          </p>
        )}
        {u.type === 'list' && (
          <fieldset disabled={!editable} className="mt-2 min-w-0">
            <legend className="text-xs font-medium text-ink-muted">
              Instruments in the list ({u.instrumentIds.length}). Type any other US stock or ETF
              below to add it.
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
            {editable && (
              <SymbolLookup
                id={id('add-symbol')}
                label="Add a stock or ETF to the list"
                actionLabel="Add"
                tradableOnly
                onPick={(found) =>
                  set({
                    universe: {
                      type: 'list',
                      instrumentIds: u.instrumentIds.includes(found.id)
                        ? u.instrumentIds
                        : [...u.instrumentIds, found.id],
                    },
                  })
                }
              />
            )}
          </fieldset>
        )}
      </section>

      <section aria-labelledby={id('filter-heading')}>
        <h3 id={id('filter-heading')} className="text-sm font-semibold text-cond">
          2. Filter <span className="font-normal text-ink-muted">(optional)</span>
        </h3>
        <p className="mb-2 text-xs text-ink-muted">
          Checked for each member at every Entry check, before ranking, with &ldquo;this
          stock&rdquo; meaning that member. Members that fail are left out (
          {EXCLUSION_LABELS.filter_false.toLowerCase()}), and so are members it can&rsquo;t be
          decided for yet.
        </p>
        {group.filter ? (
          <>
            <ConditionTreeEditor
              root={group.filter}
              label="Filter"
              path={['trade', 'filter']}
              onChange={(filter) => set({ filter })}
            />
            {editable && (
              <RowButton
                label="Remove the filter"
                className="mt-1 text-danger"
                onClick={() => {
                  const { filter: _f, ...rest } = group;
                  void _f;
                  onChange(rest);
                }}
              >
                Remove filter
              </RowButton>
            )}
          </>
        ) : (
          editable && (
            <RowButton label="Add a filter" onClick={() => set({ filter: emptyGroup() })}>
              + Add filter
            </RowButton>
          )
        )}
      </section>

      <section aria-labelledby={id('ranking-heading')}>
        <h3 id={id('ranking-heading')} className="text-sm font-semibold">
          3. Ranking <span className="font-normal text-ink-muted">(optional)</span>
        </h3>
        {ranking ? (
          <>
            <fieldset disabled={!editable} className="grid-fields-wide mt-1 gap-2">
              <legend className="sr-only">Ranking</legend>
              <MetricRefFields
                value={{ metric: ranking.metric, params: ranking.params }}
                classes={universeClasses}
                id={id}
                label="Rank by"
                error={err('ranking')}
                onChange={(ref) => setRanking({ metric: ref.metric, params: ref.params })}
              />
              <MiniSelect
                id={id('direction')}
                label="Order"
                value={ranking.direction}
                onChange={(e) => setRanking({ direction: e.target.value as 'desc' | 'asc' })}
              >
                <option value="desc">Highest first</option>
                <option value="asc">Lowest first</option>
              </MiniSelect>
              <MiniSelect
                id={id('count-type')}
                label="Keep"
                value={ranking.count.type}
                onChange={(e) =>
                  setRanking({
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
                label={ranking.count.type === 'percent' ? 'Percent' : 'N'}
                type="number"
                min={ranking.count.type === 'percent' ? 0.1 : 1}
                max={ranking.count.type === 'percent' ? 100 : 600}
                step={ranking.count.type === 'percent' ? 'any' : 1}
                value={Number.isFinite(ranking.count.value) ? String(ranking.count.value) : ''}
                error={err('ranking', 'count', 'value')}
                onChange={(e) =>
                  setRanking({
                    count: {
                      ...ranking.count,
                      value: e.target.value === '' ? Number.NaN : Number(e.target.value),
                    },
                  })
                }
              />
              {/* Per pick by default; a total split equally stays available (O146). */}
              <MiniSelect
                id={id('amount')}
                label="Entry amount"
                value={group.splitTotal ? 'split' : 'each'}
                onChange={(e) => {
                  if (e.target.value === 'split') set({ splitTotal: true });
                  else {
                    const { splitTotal: _s, ...rest } = group;
                    void _s;
                    onChange(rest);
                  }
                }}
              >
                <option value="each">For each pick</option>
                <option value="split">A total, split equally across the picks</option>
              </MiniSelect>
            </fieldset>
            {editable && (
              <RowButton
                label="Remove the ranking"
                className="mt-1 text-danger"
                onClick={() => {
                  // Without a ranking there are no picks to split over.
                  const { ranking: _r, splitTotal: _s, ...rest } = group;
                  void _r;
                  void _s;
                  onChange(rest);
                }}
              >
                Remove ranking
              </RowButton>
            )}
          </>
        ) : (
          <>
            <p className="mb-1 text-xs text-ink-muted">
              Without a ranking every member that passes the filter is a candidate, up to &ldquo;Max
              instruments held&rdquo; in Risk limits.
            </p>
            {editable && (
              <RowButton
                label="Add a ranking"
                onClick={() =>
                  set({
                    ranking: defaultRanking(u.type === 'list' ? u.instrumentIds.length : 3),
                  })
                }
              >
                + Add ranking
              </RowButton>
            )}
          </>
        )}
      </section>
      <p className="text-xs text-ink-muted">
        Each candidate is then traded on its own by the Entry leg: its own Entry check, position and
        Exit.
      </p>
      {/* "Left the group" is a group setting, not an Exit (N222). */}
      <fieldset disabled={!editable}>
        <legend className="sr-only">Holdings that leave the group</legend>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={sellsLeavers}
            aria-describedby={id('leavers-help')}
            onChange={(e) => onSellsLeavers(e.target.checked)}
          />
          Sell a pick when it leaves the group
        </label>
        {/* Help sits outside the label so the checkbox's name stays short. */}
        <p id={id('leavers-help')} className="ml-5 text-xs text-ink-muted">
          At each Check Entry, sells a holding that no longer passes the filter or the ranking
          {leavesSold ? '' : ', and every holding while Enter when is false'}. Untick it to keep
          each pick until Exit when sells it.
        </p>
      </fieldset>
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
 * above, the holding-period exit, the ATR stop, the trailing stop, the
 * expected-move exit and, for a group, "Left the group" (ADR 0073).
 * Whichever comes first exits, each time Check Exit is due.
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
  const kept = rules.filter((r) => r.kind !== 'leftGroup');
  // Stops read closes at the Check Exit bar size (O144, ADR 0073).
  const closes = stopCloseWord(definition);
  const replace = (i: number, r: ExitRule) => setRules(rules.map((x, j) => (j === i ? r : x)));
  const remove = (i: number) => setRules(rules.filter((_, j) => j !== i));
  const asInt = (v: string) => (v === '' ? Number.NaN : Number(v));
  const mode = slotModeOf(definition);
  // Per-leg conditions kept as saved still rebalance on a calendar Check Entry.
  const rebalances = mode === 'legs' && isScheduled(definition);
  const distance = definition.entry.risk ?? DEFAULT_RISK_DISTANCE;
  return (
    <div className="mt-3">
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-muted">Add to Exit when:</span>
          {/* Each adds its condition to Exit when (N217, N221, ADR 0074, ADR 0076). */}
          <RowButton
            label="Add a trailing stop to Exit when"
            onClick={() => onChange(withTrailingCondition(definition))}
          >
            + Trailing stop
          </RowButton>
          <RowButton
            label="Add a holding-period exit to Exit when"
            onClick={() => onChange(withExitShortcut(definition, 'holdingPeriod'))}
          >
            + Holding period
          </RowButton>
          <RowButton
            label="Add an ATR stop to Exit when"
            onClick={() => onChange(withExitShortcut(definition, 'atrStop'))}
          >
            + ATR stop
          </RowButton>
          <RowButton
            label="Add an expected-move exit to Exit when"
            onClick={() => onChange(withExitShortcut(definition, 'expectedMove'))}
          >
            + Expected move
          </RowButton>
        </div>
      )}
      {kept.length > 0 && (
        <p className="mt-3 text-sm text-ink-muted">
          Kept as saved: these exits run as before, alongside Exit when, because moving them into it
          would change when they exit.
        </p>
      )}
      <ul className="mt-2 space-y-2">
        {rules.map((r, i) => {
          // Left the group is a group setting in What to trade (N222).
          if (r.kind === 'leftGroup') return null;
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
                    label="Holding-period exit (kept as saved): trading days held"
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
                    label="Trailing stop (kept as saved): % below the highest close since entry"
                    inputMode="decimal"
                    disabled={!editable}
                    value={r.percent}
                    error={issueAt(['exit', 'rules', i, 'percent'])}
                    onChange={(e) => replace(i, { ...r, percent: e.target.value.trim() })}
                  />
                  <p className="flex-1 pb-1 text-xs text-ink-muted">
                    Starts at the entry price and rises with each higher {closes} close (falls with
                    each lower one, for a short). It exits at the next bar after a {closes} close
                    more than this far from that peak. Kept as saved because of this Exit&rsquo;s
                    Fire when; new trailing stops are Exit when conditions.
                  </p>
                </>
              ) : r.kind === 'expectedMove' ? (
                <div className="w-full space-y-2">
                  <p className="text-sm font-semibold">
                    Exit beyond the expected move at entry (kept as saved)
                  </p>
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
                    leg&rsquo;s stock on the entry day. It exits at the next bar after a {closes}{' '}
                    close more than that many expected moves from the entry price. Needs the CBOE
                    options feed and a recorded stock or ETF.
                  </p>
                </div>
              ) : (
                <div className="w-full space-y-2">
                  <p className="text-sm font-semibold">ATR stop (kept as saved)</p>
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
                    using the ATR on the entry day. It exits at the next bar after a {closes} close
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
              Kept as saved: per-leg conditions on a calendar Check Entry sell a leg that no longer
              qualifies at the next check.
            </p>
          </li>
        )}
      </ul>
    </div>
  );
}

/** The three Check Entry / Check Exit boxes (N227): which bar, its size, and the days. */
function ScheduleBoxes({
  prefix,
  phase,
  value,
  runOption,
  describedBy,
  onPick,
}: {
  prefix: string;
  phase: 'Entry' | 'Exit';
  /** Undefined: Check Exit on every bar the run steps on. */
  value: Schedule | undefined;
  runOption?: boolean;
  describedBy: string;
  onPick: (schedule: Schedule | undefined) => void;
}) {
  const { editable } = useEditor();
  const s = value ?? { which: 'every' as const, bar: '1d' as const, days: 'daily' as const };
  const daily = s.bar === '1d';
  // On daily bars, 1st, 2nd and last are all "after the close": shown as Every.
  const which = value === undefined ? 'run' : daily && s.which !== 'beforeOpen' ? 'every' : s.which;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <MiniSelect
        id={prefix}
        label={`Check ${phase}`}
        value={which}
        disabled={!editable}
        aria-describedby={describedBy}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'run') return onPick(undefined);
          const w = v as ScheduleWhich;
          // 1st, 2nd and last need an intraday bar: keep the size, else 5 minutes.
          const bar = daily && w !== 'every' && w !== 'beforeOpen' ? '5m' : s.bar;
          onPick({ ...s, which: w, bar });
        }}
      >
        {runOption && <option value="run">Every bar the run steps on</option>}
        {SCHEDULE_WHICH.map((w) => (
          <option key={w} value={w} disabled={daily && w !== 'every' && w !== 'beforeOpen'}>
            {SCHEDULE_WHICH_LABELS[w]}
          </option>
        ))}
      </MiniSelect>
      {value !== undefined && (
        <>
          <MiniSelect
            id={`${prefix}-bar`}
            label={`${phase} bar size`}
            value={s.bar}
            disabled={!editable}
            onChange={(e) => {
              const bar = e.target.value as ScheduleBar;
              const w = bar === '1d' && s.which !== 'beforeOpen' ? 'every' : s.which;
              onPick({ ...s, bar, which: w });
            }}
          >
            {SCHEDULE_BARS.map((b) => (
              <option key={b} value={b}>
                {SCHEDULE_BAR_LABELS[b]}
              </option>
            ))}
          </MiniSelect>
          <MiniSelect
            id={`${prefix}-days`}
            label={`${phase} days`}
            value={s.days}
            disabled={!editable}
            onChange={(e) => onPick({ ...s, days: e.target.value as ScheduleDays })}
          >
            {SCHEDULE_DAYS.map((d) => (
              <option key={d} value={d}>
                {SCHEDULE_DAYS_LABELS[d].replace(/^./, (c) => c.toUpperCase())}
              </option>
            ))}
          </MiniSelect>
        </>
      )}
    </div>
  );
}

/** Whether a group's Enter when reads "this stock" (checked per candidate). */
function readsContextEntry(def: StrategyDefinition): boolean {
  return JSON.stringify(def.entry.condition).includes('"00000000-0000-0000-0000-000000000000"');
}

/** Check Entry: when Entry, and a group's filter and ranking, are checked (N184, ADR 0073, N227). */
export function ScheduleField({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  // Until a schedule is picked, it follows the bars the rules read (N184).
  const picked = definition.entry.schedule;
  const value = picked ?? defaultSchedule(definition);
  const group = definition.trade.kind === 'group';
  return (
    <div className="mb-3">
      <ScheduleBoxes
        prefix="schedule"
        phase="Entry"
        value={value}
        describedBy="schedule-help"
        onPick={(schedule) =>
          schedule && onChange({ ...definition, entry: { ...definition.entry, schedule } })
        }
      />
      <p id="schedule-help" className="mt-1 text-xs text-ink-muted">
        Checks: {scheduleLabel(value)}.{' '}
        {picked === undefined && 'Matches the bars your conditions read until you pick one. '}
        {group
          ? 'Each check filters and ranks the group again, then checks Enter when for each candidate. '
          : ''}
        &ldquo;Every&rdquo; checks as each bar of that size closes; 1st and 2nd check once that bar
        after the open is in; Last checks at the close; Before the open checks one bar (at most an
        hour) before 9:30, so orders go in at the open. Exit has its own Check Exit.
      </p>
    </div>
  );
}

/** Check Exit (ADR 0073, N227): when the Exit condition and exit rules are checked. */
export function ExitScheduleField({
  definition,
  onChange,
}: {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}) {
  const picked = definition.exit.schedule;
  return (
    <div className="mb-3">
      <ScheduleBoxes
        prefix="exit-schedule"
        phase="Exit"
        value={picked}
        runOption
        describedBy="exit-schedule-help"
        onPick={(schedule) => {
          const { schedule: _s, ...exit } = definition.exit;
          void _s;
          onChange({ ...definition, exit: schedule ? { ...exit, schedule } : exit });
        }}
      />
      <p id="exit-schedule-help" className="mt-1 text-xs text-ink-muted">
        {picked === undefined
          ? 'Until you pick one, Exit is checked on every bar a back test or paper run steps on, as before. '
          : `Checks: ${scheduleLabel(picked)}. ` +
            (isCalendarSchedule(picked)
              ? 'The exit rules wait for these days too, so a stop can be days late. '
              : '')}
        Exit when and every exit rule are checked on this schedule. The trailing, ATR and
        expected-move stops read {stopCloseWord(definition)} closes
        {picked && (picked.bar === '1m' || picked.bar === '30m') && picked.which !== 'beforeOpen'
          ? ' (no feed serves 1- or 30-minute bars yet)'
          : ''}
        ; the ATR itself stays daily.
      </p>
    </div>
  );
}
