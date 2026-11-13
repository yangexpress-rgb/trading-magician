import { randomId, type IdFactory } from './ids';
import {
  IMMEDIATE_TRIGGER,
  STRATEGY_SCHEMA_VERSION,
  type ConditionGroup,
  type ExecutionPolicy,
  type RiskProfile,
  type StrategyDefinition,
} from './schema';

/**
 * Execution defaults confirmed by Yong on 2026-10-04 (Design v1.0 §20 #7, #8, #9,
 * #10) plus the doc's own safe defaults: one open cycle, full Entry fill before
 * Exit monitoring.
 */
export const DEFAULT_EXECUTION: ExecutionPolicy = {
  multiLegPolicy: 'concurrent',
  legTimeoutSec: 60,
  onLegFailure: 'cancel_remaining',
  entryMilestone: 'full_fill',
  reentry: { mode: 'single_cycle' },
  marketHoursPolicy: 'queue',
  holidayCalendar: 'NYSE',
  staleDataSec: 60,
};

/** Paper risk defaults confirmed on 2026-10-04 (§20 #11). Values in base currency. */
export const DEFAULT_RISK: RiskProfile = {
  maxOrderNotional: '10000',
  maxStrategyExposure: '25000',
  maxActiveOrders: 10,
  dailyLossLimit: '1000',
  priceCollarPct: '5',
};

export function emptyGroup(ids: IdFactory = randomId): ConditionGroup {
  return { kind: 'group', id: ids(), op: 'and', negate: false, children: [] };
}

/** A new, empty strategy definition with the confirmed defaults applied. */
export function createDefinition(ids: IdFactory = randomId): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    // What to trade starts as specific assets, none chosen yet (ADR 0073).
    trade: { kind: 'assets' },
    entry: {
      condition: emptyGroup(ids),
      // Fire when starts as "Immediately" (N272).
      trigger: { ...IMMEDIATE_TRIGGER },
      orders: [],
    },
    exit: {
      condition: emptyGroup(ids),
      trigger: { ...IMMEDIATE_TRIGGER },
      orders: [],
      // A new strategy's Exit legs mirror Entry until the user turns it off (ADR 0049).
      mirrorEntry: true,
    },
    execution: structuredClone(DEFAULT_EXECUTION),
    risk: { ...DEFAULT_RISK },
  };
}
