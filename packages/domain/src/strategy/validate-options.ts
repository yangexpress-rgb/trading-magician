import type { StrategyDefinition } from './schema';
import { isOptionLeg } from './schema';
import type { ValidationAdd, ValidationContext } from './validate';

/**
 * Validation of options legs (options trading brief v0.2 §5.1, ADR 0123).
 * Runs only when a strategy has an options leg, so no stock or ETF strategy
 * is checked any differently.
 */

/** Whether any leg of the strategy, its entry groups included, trades options. */
export function hasOptionLegs(def: StrategyDefinition): boolean {
  const phases = [def.entry, def.exit, ...(def.groups ?? []).flatMap((g) => [g.entry, g.exit])];
  return phases.some((p) => p?.orders.some(isOptionLeg));
}

export function checkOptionLegs(
  def: StrategyDefinition,
  ctx: ValidationContext,
  add: ValidationAdd,
): void {
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
  for (const phase of ['entry', 'exit'] as const) {
    def[phase].orders.forEach((o, i) => {
      if (!isOptionLeg(o)) return;
      const path = [phase, 'orders', i, 'option'];
      if (!ctx.optionsTradingEnabled) {
        add(
          'error',
          'options_off',
          `Options trading is turned off on this server, so "${o.legLabel}" can't trade options`,
          path,
          o.id,
        );
        return;
      }
      // Phase O0 builds the foundations only; options orders arrive with O1.
      add(
        'error',
        'options_not_built',
        `"${o.legLabel}" is an options leg, and options orders aren't available yet`,
        path,
        o.id,
      );
    });
  }
}
