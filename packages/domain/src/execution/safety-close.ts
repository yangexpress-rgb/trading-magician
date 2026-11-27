/**
 * Safety closes (N306, ADR 0105): closing orders the app places on its own,
 * not from a strategy's Exit rules. Every one states why, in words, on the
 * order, in the incident log and in a notification; the database refuses a
 * safety close without a reason.
 */
export type SafetyCloseTrigger =
  /** The strategy trailing stop in Risk limits fired (N291, ADR 0100). */
  | { kind: 'strategy_trailing_stop'; detail?: string | undefined }
  /** Flatten at session end is on (N256). */
  | { kind: 'session_end' }
  /** A multi-leg order's leg did not fill and the plan closes filled legs (§6.7). */
  | { kind: 'leg_failed' }
  /** An option the cycle holds expires today: closed from 15:00 New York time (options brief §8.3). */
  | { kind: 'closed_before_expiry' }
  /** An option expired out of the money and the broker removed it: settled at 0 (§8.3). */
  | { kind: 'expired_worthless' }
  /** A short leg of an options combo was assigned: the rest and the shares close (§8.3, O2). */
  | { kind: 'assigned'; detail?: string | undefined }
  /** A short call is likely to be exercised early for a dividend: the combo closes (§7.5, O2). */
  | { kind: 'dividend_risk'; detail?: string | undefined }
  /** The strategy's roll rule: the contract closes and a later one opens from Entry (O3). */
  | { kind: 'rolled'; days: number };

export const SAFETY_CLOSE_LABELS: Record<SafetyCloseTrigger['kind'], string> = {
  strategy_trailing_stop: 'Trailing stop (whole strategy)',
  session_end: 'Flatten at session end',
  leg_failed: 'A leg of the order did not fill',
  closed_before_expiry: 'Closed before expiry',
  expired_worthless: 'Expired worthless',
  assigned: 'Assigned',
  dividend_risk: 'Closed before a dividend',
  rolled: 'Rolled',
};

/** The reason a safety close records, in plain language. */
export function safetyCloseReason(t: SafetyCloseTrigger): string {
  switch (t.kind) {
    case 'strategy_trailing_stop':
      return (
        `${SAFETY_CLOSE_LABELS.strategy_trailing_stop}, a Risk limit: ` +
        (t.detail ??
          'the strategy fell further below its best since entry than its Trailing stop (%) allows, so every position was closed.')
      );
    case 'session_end':
      return `${SAFETY_CLOSE_LABELS.session_end}: the strategy is set to close everything it holds in the last minutes of the regular session.`;
    case 'leg_failed':
      return `${SAFETY_CLOSE_LABELS.leg_failed}: another leg of this multi-leg order did not fill, and the strategy is set to cancel the rest and close filled legs.`;
    case 'closed_before_expiry':
      return `${SAFETY_CLOSE_LABELS.closed_before_expiry}: the option expires today, so the app closes it from 15:00 New York time, at the mid and from 15:20 at the bid or ask, rather than hold it into expiry.`;
    case 'assigned':
      return `${SAFETY_CLOSE_LABELS.assigned}: ${t.detail ?? 'a short option of this combo was assigned, so the broker delivered shares at the strike'}. The app closes the rest of the combo and the shares in the regular session.`;
    case 'dividend_risk':
      return `${SAFETY_CLOSE_LABELS.dividend_risk}: ${t.detail ?? 'a short call of this combo is worth less than the dividend over its intrinsic value, so it is likely to be exercised early'}, so the app closes the combo before the ex-dividend date.`;
    case 'rolled':
      return `${SAFETY_CLOSE_LABELS.rolled}: the contract has ${t.days} day${t.days === 1 ? '' : 's'} or fewer to expiry, so the strategy's roll rule closes it and opens a later one from the Entry's rules, in the same cycle.`;
    case 'expired_worthless':
      return `${SAFETY_CLOSE_LABELS.expired_worthless}: the option expired out of the money and the broker removed it, so it was settled at 0 and the premium paid is the loss.`;
  }
}

/**
 * Whether the strategy trailing stop is judged on this paper pass (N306): on
 * the strategy's own bars, as in the back test. A strategy with an intraday
 * rule is judged on every pass; a daily one only when a new bar has closed.
 * Going flat is always taken at once, so the stop resets for the next entry.
 */
export function strategyTrailDue(input: {
  intraday: boolean;
  newBar: boolean;
  holding: boolean;
}): boolean {
  return input.intraday || input.newBar || !input.holding;
}
