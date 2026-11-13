import {
  describeCondition,
  describeLeg,
  describeTrigger,
  type SymbolLookup,
} from '@tm/domain/strategy-text';
import { stockGroup, type StrategyDefinition } from '@tm/domain';

/**
 * A strategy in plain words, for `get_strategy` (brief §4): the app's own
 * descriptions of its parts, line by line, so an agent reads the rules the
 * way the builder shows them rather than parsing the JSON alone.
 */
export function strategySummary(
  def: StrategyDefinition,
  symbol: SymbolLookup,
  currency = 'USD',
): string[] {
  const lines: string[] = [];
  const trade = def.trade;
  if (trade.kind === 'group') {
    const universe =
      trade.universe.type === 'builtin'
        ? stockGroup(trade.universe.id).label
        : `a list of ${trade.universe.instrumentIds.length} instruments (${trade.universe.instrumentIds
            .slice(0, 10)
            .map((id) => symbol(id) ?? '?')
            .join(', ')}${trade.universe.instrumentIds.length > 10 ? ', …' : ''})`;
    lines.push(`What to trade: each pick from ${universe}.`);
    if (trade.filter && trade.filter.children.length > 0)
      lines.push(`Each member must pass: ${describeCondition(trade.filter, symbol)}.`);
    if (trade.ranking) {
      const n =
        trade.ranking.count.type === 'fixed'
          ? `top ${trade.ranking.count.value}`
          : `top ${trade.ranking.count.value}%`;
      lines.push(
        `Ranked by ${trade.ranking.metric} (${trade.ranking.direction === 'desc' ? 'highest' : 'lowest'} first), keeping the ${n}.`,
      );
    }
  } else {
    const symbols = [
      ...new Set(def.entry.orders.map((o) => symbol(o.instrumentId) ?? o.instrumentId)),
    ];
    lines.push(
      symbols.length > 0
        ? `What to trade: ${symbols.join(', ')}.`
        : 'What to trade: no instruments chosen yet.',
    );
  }
  const phase = (
    name: 'Entry' | 'Exit',
    p: StrategyDefinition['entry'] | StrategyDefinition['exit'],
  ) => {
    const cond =
      p.condition.children.length > 0
        ? describeCondition(p.condition, symbol)
        : `no ${name} conditions`;
    lines.push(`${name} when: ${cond}. Fires: ${describeTrigger(p.trigger).toLowerCase()}.`);
    for (const o of p.orders)
      lines.push(`${name} leg "${o.legLabel}": ${describeLeg(o, symbol, currency)}.`);
  };
  phase('Entry', def.entry);
  phase('Exit', def.exit);
  if (def.exit.orders.length === 0 && def.exit.mirrorEntry)
    lines.push('Exit legs close what the Entry legs opened.');
  for (const g of def.groups ?? []) {
    lines.push(
      `Entry group "${g.label}": enters when ${describeCondition(g.entry.condition, symbol)}; exits when ${describeCondition(g.exit.condition, symbol)}.`,
    );
  }
  if (def.execution.flattenAtSessionEnd)
    lines.push('Flattens whatever it holds at each session end.');
  const r = def.risk;
  const risk = [
    r.maxOrderNotional && `at most ${currency} ${r.maxOrderNotional} per order`,
    r.maxStrategyExposure && `${currency} ${r.maxStrategyExposure} exposure`,
    r.maxActiveOrders && `${r.maxActiveOrders} active orders`,
    r.dailyLossLimit && `${currency} ${r.dailyLossLimit} daily loss`,
    r.maxInstrumentsHeld && `${r.maxInstrumentsHeld} instruments held`,
  ].filter(Boolean);
  if (risk.length > 0) lines.push(`Risk limits: ${risk.join(', ')}.`);
  return lines;
}
