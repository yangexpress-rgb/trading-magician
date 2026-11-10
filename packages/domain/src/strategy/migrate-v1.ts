import Decimal from 'decimal.js';

/**
 * Schema version 1 → 2: the Strategy Lab simplification (ADR 0049).
 *
 * Stored versions are never rewritten; every read of a version 1 document
 * goes through `migrateV1`, which gives the same strategy in the new shape
 * and a note for everything it changed. The notes are what the migration
 * report (`pnpm --filter @tm/db strategies:migration-report`) lists per
 * strategy. A note's `effect` says whether the strategy behaves exactly as
 * before (`same`), keeps an old form that the builder no longer offers
 * (`grandfathered`), or behaves differently on purpose (`changes`).
 *
 * The function works on plain JSON, before the schema parses it, so it sees
 * the stored document exactly as saved.
 */

export type MigrationEffect = 'same' | 'grandfathered' | 'changes';

export interface MigrationNote {
  code:
    | 'risk_quantity'
    | 'risk_distance'
    | 'atr_stop_shares_distance'
    | 'atr_stop_override'
    | 'risk_distance_conflict'
    | 'best_by_metric'
    | 'fire_mode_dropped'
    | 'extended_hours_policy'
    | 'extended_hours_dropped'
    | 'direction_derived'
    | 'direction_mismatch'
    | 'timing_only_switch'
    | 'timing_only_widened'
    | 'max_instruments_held'
    | 'weighting_dropped'
    | 'rsi_metric'
    | 'bollinger_statistic'
    | 'indicator_kept'
    | 'cooldown_bars'
    | 'slot_exit_trigger'
    | 'slot_exit_trigger_changed'
    | 'exit_leg_stop'
    | 'mirror_on'
    | 'mirror_off'
    // Schema 2 → 3 (migrate-v2.ts, ADR 0073).
    | 'trade_assets'
    | 'trade_group'
    | 'schedule_moved'
    | 'left_group_rule'
    | 'per_pick_amount'
    | 'split_total_kept'
    | 'ranked_legs_kept'
    | 'leg_conditions_kept'
    | 'trailing_stop_in_exit_when'
    | 'trailing_stop_kept';
  effect: MigrationEffect;
  message: string;
  /** Where in the definition, e.g. "entry.orders[0]" or "groups[0].exit.rules". */
  where: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const SECONDS_PER_DAY = 86_400;

const sameDecimal = (a: unknown, b: unknown) => {
  try {
    return new Decimal(String(a)).eq(new Decimal(String(b)));
  } catch {
    return false;
  }
};

/** Whether a v1 Entry ran in slot mode (a Selection group, per-leg conditions or best-by-metric). */
function slotModeV1(entry: Json): boolean {
  if (entry.kind === 'selection') return true;
  const fire = isObj(entry.fireMode) ? entry.fireMode : undefined;
  if (fire?.mode === 'bestByMetric') return true;
  return arr(entry.orders).some((o) => isObj(o) && isObj(o.legCondition));
}

const isDefaultTrigger = (t: Json) =>
  (t.mode ?? 'on_transition') === 'on_transition' &&
  Number(t.cooldownSec ?? 0) === 0 &&
  Number(t.confirmationBars ?? 0) === 0;

export function migrateV1(input: Json): { doc: Json; notes: MigrationNote[] } {
  const doc = structuredClone(input);
  const notes: MigrationNote[] = [];
  const note = (
    code: MigrationNote['code'],
    effect: MigrationEffect,
    where: string,
    message: string,
  ) => notes.push({ code, effect, where, message });

  const execution = isObj(doc.execution) ? doc.execution : (doc.execution = {});
  const parts: { entry: Json; exit: Json; at: string }[] = [];
  if (isObj(doc.entry) && isObj(doc.exit)) parts.push({ entry: doc.entry, exit: doc.exit, at: '' });
  arr(doc.groups).forEach((g, i) => {
    if (isObj(g) && isObj(g.entry) && isObj(g.exit))
      parts.push({ entry: g.entry, exit: g.exit, at: `groups[${i}].` });
  });

  // -- Timed legs without conditions: one strategy-level switch (§2.12).
  const allLegs: { o: Json; where: string }[] = [];
  for (const p of parts)
    for (const phase of ['entry', 'exit'] as const)
      arr(p[phase].orders).forEach((o, i) => {
        if (isObj(o)) allLegs.push({ o, where: `${p.at}${phase}.orders[${i}]` });
      });
  const timed = allLegs.filter(
    ({ o }) => isObj(o.timing) && o.timing.mode !== undefined && o.timing.mode !== 'immediate',
  );
  const timingOnly = allLegs.filter(({ o }) => o.timingOnly === true);
  if (timingOnly.length > 0) {
    execution.timingOnly = true;
    note(
      'timing_only_switch',
      'same',
      'execution',
      `"Allow timed entries without conditions" is on, because ${timingOnly.map((l) => l.where).join(', ')} went on timing alone`,
    );
    const widened = timed.filter(({ o }) => o.timingOnly !== true);
    if (widened.length > 0)
      note(
        'timing_only_widened',
        'changes',
        widened.map((l) => l.where).join(', '),
        'These timed legs waited for their phase condition; with the strategy-level switch on they now go on timing alone too',
      );
  }

  // -- Extended hours: the strategy's market-hours policy only (§2.9).
  const extended = allLegs.filter(({ o }) => o.extendedHours === true);
  if (extended.length > 0) {
    const policy = execution.marketHoursPolicy;
    const dayLimit = (o: Json) => o.orderType === 'limit' && (o.timeInForce ?? 'day') === 'day';
    if (policy === 'queue' || policy === undefined) {
      execution.marketHoursPolicy = 'extended_if_supported';
      note(
        'extended_hours_policy',
        extended.every(({ o }) => dayLimit(o)) ? 'same' : 'changes',
        extended.map((l) => l.where).join(', '),
        'Legs asked for extended hours, so "When the market is closed" is now "Extended hours if supported": day limit orders placed outside the session go in extended hours' +
          (extended.every(({ o }) => dayLimit(o))
            ? ''
            : '; legs that are not day limit orders now wait for the regular session'),
      );
    } else {
      note(
        'extended_hours_dropped',
        policy === 'extended_if_supported' && extended.every(({ o }) => dayLimit(o))
          ? 'same'
          : 'changes',
        extended.map((l) => l.where).join(', '),
        `The per-leg extended-hours box is gone; the strategy's policy ("${String(policy)}") decides`,
      );
    }
  }

  // -- The Exit mirror becomes a visible switch (§2.8), set from whether Exit followed Entry.
  for (const p of parts) {
    const follows = v1ExitFollowsEntry(arr(p.entry.orders), arr(p.exit.orders));
    p.exit.mirrorEntry = follows;
    note(
      follows ? 'mirror_on' : 'mirror_off',
      'same',
      `${p.at}exit`,
      follows
        ? '"Mirror Entry legs" is on: the Exit legs were exactly what Entry pre-fills'
        : '"Mirror Entry legs" is off: the Exit legs were edited by hand',
    );
  }

  for (const { o } of allLegs) {
    delete o.timingOnly;
    delete o.extendedHours;
  }

  for (const p of parts) {
    const { entry, exit, at } = p;
    const slot = slotModeV1(entry);

    // -- One risk quantity type (§2.7) and one risk distance per Entry (§2.1).
    let distance: { atrPeriod: number; atrMultiple: string } | undefined;
    for (const phase of ['entry', 'exit'] as const)
      arr(p[phase].orders).forEach((o, i) => {
        if (!isObj(o) || !isObj(o.quantity)) return;
        const q = o.quantity;
        const where = `${at}${phase}.orders[${i}]`;
        if (q.type === 'risk_sized') {
          o.quantity = {
            type: 'risk',
            value: q.value,
            rounding: q.rounding ?? 'down',
            amountIn: 'dollars',
            distanceFrom: 'stop_price',
          };
          note(
            'risk_quantity',
            'same',
            where,
            'Risk sized (dollars at risk, stop price) → Risk: dollars, from the stop price',
          );
        } else if (q.type === 'risk_atr') {
          if (phase === 'entry' && q.atrPeriod !== undefined && q.atrMultiple !== undefined) {
            const mine = { atrPeriod: Number(q.atrPeriod), atrMultiple: String(q.atrMultiple) };
            if (!distance) distance = mine;
            else if (
              distance.atrPeriod !== mine.atrPeriod ||
              !sameDecimal(distance.atrMultiple, mine.atrMultiple)
            )
              note(
                'risk_distance_conflict',
                'changes',
                where,
                `This leg sized from ${mine.atrMultiple} × ATR(${mine.atrPeriod}), another from ${distance.atrMultiple} × ATR(${distance.atrPeriod}); the Entry has one risk distance, the first one`,
              );
          }
          o.quantity = {
            type: 'risk',
            value: q.value,
            rounding: q.rounding ?? 'down',
            amountIn: 'pct_equity',
            distanceFrom: 'atr',
          };
          note(
            'risk_quantity',
            'same',
            where,
            'Risk (ATR) → Risk: % of equity, from the ATR risk distance',
          );
        }
      });
    const rules = arr(exit.rules);
    const stop = rules.find((r): r is Json => isObj(r) && r.kind === 'atrStop');
    if (stop) {
      const own = { atrPeriod: Number(stop.atrPeriod), atrMultiple: String(stop.atrMultiple) };
      delete stop.atrPeriod;
      delete stop.atrMultiple;
      if (!distance) {
        distance = own;
      } else if (
        distance.atrPeriod === own.atrPeriod &&
        sameDecimal(distance.atrMultiple, own.atrMultiple)
      ) {
        note(
          'atr_stop_shares_distance',
          'same',
          `${at}exit.rules`,
          `The ATR stop and risk sizing both used ${own.atrMultiple} × ATR(${own.atrPeriod}); the stop now uses the Entry's risk distance`,
        );
      } else {
        stop.override = own;
        note(
          'atr_stop_override',
          'same',
          `${at}exit.rules`,
          `The ATR stop (${own.atrMultiple} × ATR(${own.atrPeriod})) differs from the sizing distance (${distance.atrMultiple} × ATR(${distance.atrPeriod})), so it keeps its own as an override`,
        );
      }
    }
    if (distance) {
      entry.risk = distance;
      note(
        'risk_distance',
        'same',
        `${at}entry`,
        `Risk distance ${distance.atrMultiple} × ATR(${distance.atrPeriod}) entered once on the Entry`,
      );
    }

    // -- Best by metric → a Selection group of "these legs" (§2.3).
    const fire = isObj(entry.fireMode) ? entry.fireMode : undefined;
    if (fire?.mode === 'bestByMetric' && entry.kind !== 'selection') {
      entry.kind = 'selection';
      entry.selection = {
        universe: { type: 'legs' },
        ranking: fire.metric,
        direction: 'desc',
        count: { type: 'fixed', value: 1 },
      };
      note(
        'best_by_metric',
        'same',
        `${at}entry`,
        'Fire mode "best by metric" → a Selection group of these legs, ranked by the same metric, highest first, top 1; leg conditions are each leg\'s pre-filter',
      );
    } else if (fire) {
      note(
        'fire_mode_dropped',
        'same',
        `${at}entry`,
        `Fire mode "${String(fire.mode)}" had no effect and is gone`,
      );
    }
    delete entry.fireMode;
    if (isObj(entry.selection) && 'weighting' in entry.selection) {
      delete entry.selection.weighting;
      note(
        'weighting_dropped',
        'same',
        `${at}entry.selection`,
        'Equal weight is the only weighting; the field is gone',
      );
    }

    // -- Direction is derived from the legs (§2.11).
    if (entry.direction !== undefined) {
      const sides = arr(entry.orders).map((o) => (isObj(o) ? o.side : undefined));
      const derived = sides.length > 0 && sides.every((s) => s === 'sell_short') ? 'short' : 'long';
      note(
        derived === entry.direction ? 'direction_derived' : 'direction_mismatch',
        derived === entry.direction ? 'same' : 'changes',
        `${at}entry`,
        derived === entry.direction
          ? `Direction "${String(entry.direction)}" now comes from the Entry legs${at === '' && arr(doc.groups).length === 0 ? '; with one entry group, trade lists no longer add a direction column' : ''}`
          : `Direction was stored as "${String(entry.direction)}" but the legs make it "${derived}" (validation used to reject this)`,
      );
      delete entry.direction;
    }

    // -- Triggers: cooldown in bars (§2.12); no Exit trigger in slot mode (§2.6).
    for (const phase of ['entry', 'exit'] as const) {
      const t = p[phase].trigger;
      if (!isObj(t)) continue;
      const sec = Number(t.cooldownSec ?? 0);
      if (phase === 'exit' && slot) {
        if (isDefaultTrigger(t))
          note(
            'slot_exit_trigger',
            'same',
            `${at}exit.trigger`,
            'The hidden Exit trigger is gone: the Exit condition is checked directly on every bar',
          );
        else
          note(
            'slot_exit_trigger_changed',
            'changes',
            `${at}exit.trigger`,
            `A hidden Exit trigger (${String(t.mode ?? 'on_transition')}, ${Number(t.confirmationBars ?? 0)} confirmation bars, ${sec} s cooldown) applied to this Selection group or per-leg strategy; the Exit condition is now checked directly`,
          );
        delete p[phase].trigger;
        continue;
      }
      delete t.cooldownSec;
      t.cooldownBars = Math.floor(sec / SECONDS_PER_DAY);
      if (sec > 0)
        note(
          'cooldown_bars',
          sec % SECONDS_PER_DAY === 0 ? 'same' : 'changes',
          `${at}${phase}.trigger`,
          `Cooldown ${sec} s → ${t.cooldownBars as number} bars (a daily bar is a day; across weekends and holidays the old seconds were shorter than the bars)`,
        );
    }

    // -- Exit legs are market or close orders; old stop prices are kept (§2.13).
    arr(exit.orders).forEach((o, i) => {
      if (isObj(o) && (o.orderType === 'stop' || o.orderType === 'stop_limit'))
        note(
          'exit_leg_stop',
          'grandfathered',
          `${at}exit.orders[${i}]`,
          `Exit leg "${String(o.legLabel)}" is a ${o.orderType === 'stop' ? 'stop' : 'stop-limit'} order. It keeps working as saved; the builder no longer offers stop orders on Exit legs (use the ATR stop)`,
        );
    });
  }

  // -- Risk limit rename (§2.13).
  if (isObj(doc.risk) && 'maxOpenPositions' in doc.risk) {
    doc.risk.maxInstrumentsHeld = doc.risk.maxOpenPositions;
    delete doc.risk.maxOpenPositions;
    note(
      'max_instruments_held',
      'same',
      'risk',
      'Maximum open positions → Maximum instruments held',
    );
  }

  // -- One computation per name (§2.2): RSI is the registry metric, Bollinger the statistic.
  rewriteExpressions(doc, notes);

  doc.schemaVersion = 2;
  return { doc, notes };
}

/** Every expression slot of a v1 document: conditions and order prices, as [holder, key, where]. */
function rewriteExpressions(doc: Json, notes: MigrationNote[]) {
  const visit = (holder: Json, key: string, where: string) => {
    const e = holder[key];
    if (!isObj(e)) return;
    const replaced = convertExpr(e, where, notes);
    if (replaced) holder[key] = replaced;
    const now = holder[key] as Json;
    if (now.kind === 'calc')
      arr(now.args).forEach((_, i) => visit(now.args as unknown as Json, String(i), where));
    if (now.kind === 'stat') visit(now, 'input', where);
  };
  const tree = (node: unknown, where: string) => {
    if (!isObj(node)) return;
    if (node.kind === 'group') arr(node.children).forEach((c) => tree(c, where));
    else if (node.kind === 'comparison')
      for (const side of ['left', 'right', 'upper']) visit(node, side, where);
  };
  const phases: { p: Json; at: string }[] = [];
  for (const phase of ['entry', 'exit'])
    if (isObj(doc[phase])) phases.push({ p: doc[phase] as Json, at: phase });
  arr(doc.groups).forEach((g, i) => {
    if (!isObj(g)) return;
    for (const phase of ['entry', 'exit'])
      if (isObj(g[phase])) phases.push({ p: g[phase] as Json, at: `groups[${i}].${phase}` });
  });
  for (const { p, at } of phases) {
    tree(p.condition, `${at}.condition`);
    if (isObj(p.selection)) tree(p.selection.preFilter, `${at}.selection.preFilter`);
    arr(p.orders).forEach((o, i) => {
      if (!isObj(o)) return;
      tree(o.legCondition, `${at}.orders[${i}].legCondition`);
      visit(o, 'limitPrice', `${at}.orders[${i}]`);
      visit(o, 'stopPrice', `${at}.orders[${i}]`);
    });
  }
}

const BOLLINGER_FN: Record<string, string> = {
  upper: 'BB_UPPER',
  middle: 'BB_MIDDLE',
  lower: 'BB_LOWER',
};

function convertExpr(e: Json, where: string, notes: MigrationNote[]): Json | undefined {
  if (e.kind !== 'indicator') return undefined;
  const params = isObj(e.params) ? e.params : {};
  const adjustment = e.adjustment ?? 'split_and_dividend';
  const session = e.session ?? 'regular';
  const offset = Number(e.offset ?? 0);
  if (e.name === 'RSI') {
    if (
      (e.field ?? 'close') === 'close' &&
      adjustment === 'split_and_dividend' &&
      session === 'regular'
    ) {
      notes.push({
        code: 'rsi_metric',
        effect: 'same',
        where,
        message: 'RSI indicator → the RSI metric (same period, interval and bars ago)',
      });
      const interval = e.interval ?? '1d';
      return {
        kind: 'metric',
        id: e.id,
        metric: 'rsi',
        params: { period: params.period ?? 14, ...(interval !== '1d' ? { interval } : {}) },
        instrumentId: e.instrumentId,
        ...(offset > 0 ? { offset } : {}),
      };
    }
    notes.push({
      code: 'indicator_kept',
      effect: 'grandfathered',
      where,
      message: `RSI of ${String(e.field)} (${String(adjustment)}, ${String(session)} session) has no metric form and is kept as saved`,
    });
    return undefined;
  }
  if (e.name === 'BBANDS') {
    const period = Number(params.period ?? 20);
    const fn = BOLLINGER_FN[String(params.band ?? 'upper')];
    if (period >= 2 && fn) {
      notes.push({
        code: 'bollinger_statistic',
        effect: 'same',
        where,
        message:
          'Bollinger band indicator → the Bollinger statistic of the same price (same period, deviations and bars ago)',
      });
      return {
        kind: 'stat',
        id: e.id,
        fn,
        input: {
          kind: 'market',
          id: `${String(e.id)}-input`,
          instrumentId: e.instrumentId,
          field: e.field ?? 'close',
          interval: e.interval ?? '1d',
          adjustment,
          session,
          offset: 0,
        },
        period,
        multiplier: String(params.stdDev ?? 2),
        ...(offset > 0 ? { offset } : {}),
      };
    }
    notes.push({
      code: 'indicator_kept',
      effect: 'grandfathered',
      where,
      message: 'A 1-bar Bollinger band has no statistic form and is kept as saved',
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The version 1 mirror comparison (ADR 0028), used once to set the switch.

const OPPOSITE: Record<string, string> = { buy: 'sell', sell_short: 'buy_to_cover' };

function v1Defaults(o: Json): Json {
  const q = isObj(o.quantity) ? o.quantity : {};
  return {
    ...o,
    quantity: { ...q, rounding: q.rounding ?? 'down' },
    timeInForce: o.timeInForce ?? 'day',
    extendedHours: o.extendedHours ?? false,
    timing: o.timing ?? { mode: 'immediate' },
    timingOnly: o.timingOnly ?? false,
  };
}

function v1ExitLabel(entryLabel: string): string {
  const trimmed = entryLabel.trim();
  const label = /^entry\b/i.test(trimmed)
    ? `Exit${trimmed.slice(5)}`
    : `Exit ${trimmed || 'leg'}`.trim();
  return label.slice(0, 40);
}

function v1Mirror(entry: Json[]): Json[] {
  const out: Json[] = [];
  const closed = new Set<string>();
  for (const e of entry) {
    const q = isObj(e.quantity) ? e.quantity : {};
    const opposite = OPPOSITE[String(e.side)];
    const side = q.type === 'units' && opposite ? opposite : 'close';
    if (side === 'close') {
      const key = `${String(e.instrumentId)}|${String(e.accountId)}`;
      if (closed.has(key)) continue;
      closed.add(key);
    }
    out.push({
      legLabel: v1ExitLabel(String(e.legLabel ?? '')),
      instrumentId: e.instrumentId,
      accountId: e.accountId,
      side,
      quantity: { ...q },
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: e.extendedHours,
      timing: { mode: 'immediate' },
      timingOnly: false,
    });
  }
  const taken = new Set(
    entry.map((e) =>
      String(e.legLabel ?? '')
        .trim()
        .toLowerCase(),
    ),
  );
  for (const o of out) {
    let label = String(o.legLabel);
    for (let n = 2; taken.has(label.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      label = String(o.legLabel).slice(0, 40 - suffix.length) + suffix;
    }
    taken.add(label.toLowerCase());
    o.legLabel = label;
  }
  return out;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** Whether a v1 Exit was still exactly what its Entry pre-fills (or empty). */
export function v1ExitFollowsEntry(entry: unknown[], exit: unknown[]): boolean {
  if (exit.length === 0) return true;
  const e = entry.filter(isObj).map(v1Defaults);
  const x = exit
    .filter(isObj)
    .map(v1Defaults)
    .map(({ id: _id, ...rest }) => rest);
  return canonical(x) === canonical(v1Mirror(e));
}
