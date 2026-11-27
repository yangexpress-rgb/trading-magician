import type { ActiveCycle } from '@tm/db';
import {
  isOptionLeg,
  isTerminalOrderState,
  legKey,
  legOrderFor,
  safetyCloseReason,
  type PlannedLeg,
  type StrategyDefinition,
} from '@tm/domain';
import { optionsState, placeOptionFlatten, ROLL_ATTEMPT, type OptionPassContext } from './orders';

/**
 * The roll rule (options brief v0.2 §10, ADR 0123 Phase O3): once a contract
 * the cycle holds has the rule's days to expiry or fewer, the cycle closes
 * its contracts and opens its Entry's options legs again, picking later
 * contracts from their own rules: one action, in the same cycle. Shares a
 * covered call is sold on stay held, so its call is bought back and sold
 * again on a later expiry.
 *
 * Two stages, each a pass or more:
 * - closing: every contract held closes as a limit (short legs first, §7.4);
 * - opening: once none is held or closing, the Entry's options legs are placed
 *   again as a new attempt (ROLL_ATTEMPT + the roll's number), so the planner's
 *   own Entry legs and their keys are never reused.
 * The planner keeps the cycle open while a roll runs. A roll that opens
 * nothing (no contract matched, or refused) ends, and a cycle left holding
 * nothing then closes as closed before expiry.
 */

/** Starts a roll for a cycle, unless one is running. */
export function startRoll(ctx: OptionPassContext, c: ActiveCycle, days: number): void {
  const state = optionsState(ctx.work);
  if (state.rolls?.[c.id]) return;
  const no = (state.rollsDone?.[c.id] ?? 0) + 1;
  state.rolls = {
    ...state.rolls,
    [c.id]: { stage: 'closing', no, days, at: ctx.now.toISOString() },
  };
  ctx.logger.info({ runtimeId: ctx.work.id, cycleId: c.id, roll: no }, 'options roll started');
}

export const rollRunning = (ctx: Pick<OptionPassContext, 'work'>, c: ActiveCycle) =>
  !!ctx.work.state.options?.rolls?.[c.id];

const optionHeld = (ctx: OptionPassContext, c: ActiveCycle) =>
  [...c.positions].filter(
    ([id, q]) => !q.isZero() && ctx.work.instruments.get(id)?.assetClass === 'option',
  );

/**
 * One pass of a running roll. `place` places one Entry leg as the runtime
 * places any (sizing, risk, the options path); it returns false when nothing
 * was recorded yet (the market is closed, or a covered call waits for its
 * shares), so the leg is tried again next pass.
 */
export async function stepRoll(
  ctx: OptionPassContext,
  c: ActiveCycle,
  definition: StrategyDefinition,
  place: (leg: PlannedLeg) => Promise<boolean | undefined>,
): Promise<'rolling' | 'rolled' | 'opened_nothing' | undefined> {
  const state = optionsState(ctx.work);
  const roll = state.rolls?.[c.id];
  if (!roll) return undefined;
  const reason = safetyCloseReason({ kind: 'rolled', days: roll.days });
  if (roll.stage === 'closing') {
    const held = optionHeld(ctx, c);
    // Short legs first: their buy-backs go before any long is sold.
    held.sort(([, a], [, b]) => a.cmp(b));
    for (const [instrumentId, quantity] of held)
      await placeOptionFlatten(ctx, { cycle: c, instrumentId, quantity, closeReason: reason });
    const working = c.legs.some(
      (l) =>
        l.phase === 'flatten' &&
        !isTerminalOrderState(l.state) &&
        ctx.work.instruments.get(l.instrumentId)?.assetClass === 'option',
    );
    if (held.length > 0 || working) return 'rolling';
    // Nothing left to close: the deferred closes are done with.
    if (state.pendingCloses?.[c.id]) {
      const { [c.id]: _done, ...rest } = state.pendingCloses;
      void _done;
      state.pendingCloses = rest;
    }
    state.rolls = { ...state.rolls, [c.id]: { ...roll, stage: 'opening' } };
  }
  const attempt = ROLL_ATTEMPT + roll.no;
  const legs = legOrderFor(definition, 'entry').filter(isOptionLeg);
  for (const o of legs) {
    if (c.legs.some((l) => l.phase === 'entry' && l.legId === o.id && l.attempt === attempt))
      continue;
    await place({
      key: legKey('entry', o.id, attempt),
      legId: o.id,
      phase: 'entry',
      attempt,
      dueAt: ctx.now.getTime(),
      reference: { kind: 'trigger', phase: 'entry' },
    });
  }
  // Done once every leg of this roll has an order that has ended.
  const records = (id: string) =>
    c.legs.filter((l) => l.phase === 'entry' && l.legId === id && l.attempt === attempt);
  const ended = legs.every((o) => {
    const r = records(o.id);
    return r.length > 0 && r.every((l) => isTerminalOrderState(l.state));
  });
  if (!ended) return 'rolling';
  const { [c.id]: _finished, ...rest } = state.rolls ?? {};
  void _finished;
  state.rolls = rest;
  state.rollsDone = { ...state.rollsDone, [c.id]: roll.no };
  if (optionHeld(ctx, c).length > 0) return 'rolled';
  ctx.logger.warn(
    { runtimeId: ctx.work.id, cycleId: c.id, roll: roll.no },
    'options roll opened nothing',
  );
  return 'opened_nothing';
}

/** A cycle's rolls are forgotten once it has ended. */
export function forgetRolls(ctx: Pick<OptionPassContext, 'work'>): void {
  const state = ctx.work.state.options;
  if (!state) return;
  const open = new Set(ctx.work.cycles.map((c) => c.id));
  const keep = <T>(r: Record<string, T> | undefined) =>
    r ? Object.fromEntries(Object.entries(r).filter(([k]) => open.has(k))) : r;
  if (state.rolls) state.rolls = keep(state.rolls);
  if (state.rollsDone) state.rollsDone = keep(state.rollsDone);
  if (state.shareCloses) state.shareCloses = keep(state.shareCloses);
}
