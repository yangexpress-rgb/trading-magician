import { LEVEL_NEEDED, OPTIONS_LEVEL_TEXT, type OptionsLevel } from '../options/trading';
import { CONTEXT_INSTRUMENT_ID } from './evaluate';
import type { PlannedOrder, StrategyDefinition } from './schema';
import { isOptionLeg } from './schema';
import type { ValidationAdd, ValidationContext } from './validate';

/**
 * Validation of options legs (options trading brief v0.2 §5.1, ADR 0123).
 * Runs only when a strategy has an options leg or an options exit rule, so no
 * stock or ETF strategy is checked any differently.
 */

/** Whether any leg of the strategy, its entry groups included, trades options. */
export function hasOptionLegs(def: StrategyDefinition): boolean {
  const phases = [def.entry, def.exit, ...(def.groups ?? []).flatMap((g) => [g.entry, g.exit])];
  return phases.some((p) => p?.orders.some(isOptionLeg));
}

const OPTION_RULES = new Set(['optionTarget', 'optionDte']);

/** Whether the strategy uses an options-only exit rule (§8.4). */
export const hasOptionRules = (def: StrategyDefinition) =>
  [def.exit, ...(def.groups ?? []).map((g) => g.exit)].some((x) =>
    (x.rules ?? []).some((r) => OPTION_RULES.has(r.kind)),
  );

/** Phase O1: options legs buy to open and sell to close. Combos (sell to open) arrive in O2. */
const OPEN_SIDES: readonly PlannedOrder['side'][] = ['buy'];
const CLOSE_SIDES: readonly PlannedOrder['side'][] = ['sell', 'close', 'reduce'];

export function checkOptionLegs(
  def: StrategyDefinition,
  ctx: ValidationContext,
  add: ValidationAdd,
): void {
  // Options exits need options legs to read (§8.4).
  if (!hasOptionLegs(def)) {
    (def.exit.rules ?? []).forEach((r, i) => {
      if (OPTION_RULES.has(r.kind))
        add(
          'error',
          'option_rule_without_options',
          'Options exits need an options leg to read: this strategy trades no options',
          ['exit', 'rules', i],
          r.id,
        );
    });
    return;
  }
  // Options legs belong to the strategy's own Entry and Exit (ADR 0123).
  (def.groups ?? []).forEach((g, gi) => {
    for (const phase of ['entry', 'exit'] as const)
      g[phase].orders.forEach((o, i) => {
        if (isOptionLeg(o))
          add(
            'error',
            'options_in_group',
            `"${o.legLabel}" is an options leg: options legs can't be in an entry group`,
            ['groups', gi, phase, 'orders', i, 'option'],
            o.id,
          );
      });
  });
  if (!ctx.optionsTradingEnabled) {
    for (const phase of ['entry', 'exit'] as const)
      def[phase].orders.forEach((o, i) => {
        if (isOptionLeg(o))
          add(
            'error',
            'options_off',
            `Options trading is turned off on this server, so "${o.legLabel}" can't trade options`,
            [phase, 'orders', i, 'option'],
            o.id,
          );
      });
    return;
  }
  if (def.trade.kind === 'group')
    add(
      'error',
      'options_in_selection',
      'Options legs trade one named stock or ETF: a Selection group strategy can’t trade options',
      ['trade'],
    );
  if (def.execution.marketHoursPolicy === 'extended_if_supported')
    add(
      'error',
      'options_extended_hours',
      'Options trade in the regular session only: choose another market-hours setting',
      ['execution', 'marketHoursPolicy'],
    );
  const entryUnderlyings = new Set(
    def.entry.orders.filter(isOptionLeg).map((o) => `${o.instrumentId}|${o.option?.right}`),
  );
  for (const phase of ['entry', 'exit'] as const) {
    def[phase].orders.forEach((o, i) => {
      if (!isOptionLeg(o)) return;
      const path = [phase, 'orders', i];
      const err = (code: string, message: string, at: (string | number)[] = []) =>
        add('error', code, message, [...path, ...at], o.id);
      const allowed = phase === 'entry' ? OPEN_SIDES : CLOSE_SIDES;
      if (!allowed.includes(o.side))
        err(
          o.side === 'sell_short' ? 'options_sell_to_open' : 'options_side',
          o.side === 'sell_short'
            ? `"${o.legLabel}" sells an option to open: that is only possible inside a defined-risk combo`
            : phase === 'entry'
              ? `"${o.legLabel}" must buy its option to open`
              : `"${o.legLabel}" must sell to close the option its Entry leg bought`,
          ['side'],
        );
      if (o.instrumentId !== CONTEXT_INSTRUMENT_ID) {
        const inst = ctx.instruments.get(o.instrumentId);
        if (inst && inst.assetClass !== 'stock' && inst.assetClass !== 'etf')
          err(
            'options_underlying',
            `"${o.legLabel}" trades options on ${inst.symbol}: options need a stock or ETF underlying`,
            ['instrumentId'],
          );
      }
      const account = ctx.accounts.get(o.accountId);
      if (account && account.mode !== 'paper')
        err(
          'options_live_account',
          `"${o.legLabel}" trades options on ${account.nickname}, a live account: options trade on paper accounts only`,
          ['accountId'],
        );
      const level = account?.capabilities.optionsLevel;
      if (account && level !== undefined && level < LEVEL_NEEDED.long)
        err(
          'options_level',
          `${account.nickname} is at options level ${level} (${OPTIONS_LEVEL_TEXT[level as OptionsLevel] ?? 'unknown'}); "${o.legLabel}" needs level ${LEVEL_NEEDED.long} (${OPTIONS_LEVEL_TEXT[LEVEL_NEEDED.long]})`,
          ['accountId'],
        );
      if (o.timeInForce !== 'day' && o.timeInForce !== 'gtc')
        err(
          'options_time_in_force',
          `"${o.legLabel}" is an options leg: use day or good-till-canceled`,
          ['timeInForce'],
        );
      // §7.1: the app prices every options order as a limit at the quote's mid.
      if (o.orderType !== 'market' || o.limitPrice || o.stopPrice)
        err(
          'options_order_type',
          `"${o.legLabel}" is an options leg: the app sends it as a limit at the quote's mid, so leave its order type at Market and set no price`,
          ['orderType'],
        );
      if (o.quantity.type !== 'units' && o.quantity.type !== 'notional')
        err(
          'options_quantity',
          `"${o.legLabel}" is an options leg: size it in contracts or in dollars of premium`,
          ['quantity', 'type'],
        );
      if (
        phase === 'exit' &&
        !def.exit.mirrorEntry &&
        !entryUnderlyings.has(`${o.instrumentId}|${o.option?.right}`)
      )
        err(
          'options_exit_unmatched',
          `"${o.legLabel}" closes an option no Entry leg buys: match its stock and call or put to an Entry leg`,
          ['option'],
        );
    });
  }
  // A strategy trailing stop reads the premium, which moves many times faster than the stock.
  const trail = def.risk.trailingStopPct;
  if (trail !== undefined && Number(trail) < 25)
    add(
      'warning',
      'options_trailing_stop',
      `The strategy trailing stop of ${trail}% is measured on option premium, which can move that much in minutes: widen it or turn it off`,
      ['risk', 'trailingStopPct'],
    );
}
