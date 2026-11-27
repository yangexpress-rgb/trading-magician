import { effectivePrice, nyDate } from '@tm/domain';
import Decimal from 'decimal.js';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { openIncident, resolveIncident } from './incidents';
import { notify } from './notifications';
import { OrderError } from './orders';
import { requestCancel, WORKING_STATES } from './runtime';
import {
  accountValuations,
  brokerOrders,
  executionIncidents,
  instruments,
  orderIntents,
  strategyRuntimes,
  tradingAccounts,
} from './schema';

/**
 * The account risk layer (Phase 7 P1, design deviation D4; ADR 0107). Above
 * each strategy's own limits, an account can carry two of its own, judged on
 * everything the app trades there across every run:
 *
 * - Maximum total exposure: an order that opens or adds risk is refused when
 *   it would take the account's gross exposure past the limit (the worker's
 *   pre-trade check, `risk_account_exposure`).
 * - Daily loss limit: when the account's loss for the New York trading day
 *   reaches the limit, every run on the account is paused for the rest of the
 *   day. Positions stay and nothing is canceled; an incident and a
 *   notification say why. Runs on other accounts carry on.
 *
 * The account kill switch pauses every run on the account and cancels its
 * working orders, until it is released. A halted account starts and resumes
 * nothing; releasing a halt resumes nothing either, each run is resumed on
 * purpose (as with the global kill switch, §8.1).
 */

export type AccountHaltKind = 'kill_switch' | 'daily_loss';

export interface AccountHalt {
  kind: AccountHaltKind;
  at: Date;
  reason: string | null;
  /** New York date a daily-loss halt holds for. */
  date: string | null;
}

interface HaltColumns {
  haltKind: AccountHaltKind | null;
  haltedAt: Date | null;
  haltReason: string | null;
  haltDate: string | null;
}

/** The account's halt in force now: a daily-loss halt ends with its New York day. */
export function activeHalt(row: HaltColumns, now: Date = new Date()): AccountHalt | null {
  if (!row.haltKind || !row.haltedAt) return null;
  if (row.haltKind === 'daily_loss' && row.haltDate !== nyDate(now)) return null;
  return { kind: row.haltKind, at: row.haltedAt, reason: row.haltReason, date: row.haltDate };
}

/** Why runs on the account cannot trade, in words. */
export function haltText(nickname: string, halt: AccountHalt): string {
  return halt.kind === 'kill_switch'
    ? `The kill switch is engaged on ${nickname}. Release it in Settings › Accounts first`
    : `${nickname} reached its daily loss limit and is halted for the rest of today`;
}

async function accountRow(tx: Transaction, accountId: string) {
  const [row] = await tx
    .select({
      id: tradingAccounts.id,
      nickname: tradingAccounts.nickname,
      maxExposure: tradingAccounts.maxExposure,
      dailyLossLimit: tradingAccounts.dailyLossLimit,
      haltKind: tradingAccounts.haltKind,
      haltedAt: tradingAccounts.haltedAt,
      haltReason: tradingAccounts.haltReason,
      haltDate: tradingAccounts.haltDate,
    })
    .from(tradingAccounts)
    .where(eq(tradingAccounts.id, accountId));
  return row;
}

/** The halt in force on an account, with its name; null when it may trade. */
export async function accountHalt(
  tx: Transaction,
  accountId: string,
  now: Date = new Date(),
): Promise<(AccountHalt & { nickname: string }) | null> {
  const row = await accountRow(tx, accountId);
  if (!row) return null;
  const halt = activeHalt(row, now);
  return halt ? { ...halt, nickname: row.nickname } : null;
}

/** Refuses to start or resume a run on a halted account, saying why. */
export async function assertAccountNotHalted(
  tx: Transaction,
  accountId: string,
  now: Date = new Date(),
): Promise<void> {
  const halt = await accountHalt(tx, accountId, now);
  if (halt) throw new OrderError('invalid_state', haltText(halt.nickname, halt));
}

/** The run's account, when that account is halted now. */
export async function runtimeAccountHalt(
  tx: Transaction,
  runtimeId: string,
  now: Date = new Date(),
): Promise<(AccountHalt & { nickname: string }) | null> {
  const [run] = await tx
    .select({ accountId: strategyRuntimes.accountId })
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.id, runtimeId));
  return run?.accountId ? accountHalt(tx, run.accountId, now) : null;
}

async function pauseAccountRuns(tx: Transaction, accountId: string, reason: string) {
  return tx
    .update(strategyRuntimes)
    .set({ status: 'paused', pauseReason: reason.slice(0, 500) })
    .where(and(eq(strategyRuntimes.accountId, accountId), eq(strategyRuntimes.status, 'running')))
    .returning({ id: strategyRuntimes.id });
}

/**
 * The account kill switch (A4). Engaging it pauses every running run on the
 * account and cancels the account's working orders; runs on other accounts
 * are untouched. Releasing it clears any halt on the account (a daily-loss
 * halt too) and resumes nothing.
 */
export async function setAccountKillSwitch(
  tx: Transaction,
  userId: string,
  accountId: string,
  engaged: boolean,
  reason?: string,
): Promise<{ paused: number; canceled: number }> {
  const account = await accountRow(tx, accountId);
  if (!account) throw new OrderError('not_found', 'Trading account not found');
  const now = new Date();
  if (!engaged) {
    await tx
      .update(tradingAccounts)
      .set({ haltKind: null, haltedAt: null, haltReason: null, haltDate: null })
      .where(eq(tradingAccounts.id, accountId));
    const open = await tx
      .select({ id: executionIncidents.id })
      .from(executionIncidents)
      .where(
        and(
          eq(executionIncidents.accountId, accountId),
          eq(executionIncidents.kind, 'account_daily_loss'),
          isNull(executionIncidents.resolvedAt),
        ),
      );
    for (const i of open)
      await resolveIncident(tx, {
        userId,
        incidentId: i.id,
        by: 'user',
        note: 'The account halt was released',
      });
    await recordAudit(tx, {
      userId,
      actorType: 'user',
      action: 'trading_account.halt_released',
      resourceType: 'trading_account',
      resourceId: accountId,
      context: { was: account.haltKind },
    });
    return { paused: 0, canceled: 0 };
  }

  await tx
    .update(tradingAccounts)
    .set({
      haltKind: 'kill_switch',
      haltedAt: now,
      haltReason: reason?.trim().slice(0, 500) || null,
      haltDate: null,
    })
    .where(eq(tradingAccounts.id, accountId));
  const paused = await pauseAccountRuns(
    tx,
    accountId,
    `Kill switch engaged on ${account.nickname}`,
  );
  const working = await tx
    .select({ id: orderIntents.id })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .where(
      and(eq(orderIntents.accountId, accountId), inArray(brokerOrders.state, [...WORKING_STATES])),
    );
  for (const o of working)
    await requestCancel(tx, o.id, 'user', `Canceled by the kill switch on ${account.nickname}`);
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'trading_account.kill_switch_engaged',
    resourceType: 'trading_account',
    resourceId: accountId,
    context: {
      pausedRuntimes: paused.map((p) => p.id),
      canceledOrders: working.length,
      ...(reason ? { reason } : {}),
    },
  });
  await notify(tx, {
    userId,
    kind: 'risk_pause',
    title: `Kill switch engaged on ${account.nickname}`,
    body: `${paused.length} ${paused.length === 1 ? 'run' : 'runs'} paused and ${working.length} working ${working.length === 1 ? 'order' : 'orders'} canceled on ${account.nickname}. Other accounts keep trading.`,
    link: `/orders?account=${accountId}`,
    resourceType: 'trading_account',
    resourceId: accountId,
    dedupeKey: `account_kill:${accountId}:${now.getTime()}`,
  });
  return { paused: paused.length, canceled: working.length };
}

/** Sets or clears an account's limits; null clears one (D4). */
export async function setAccountLimits(
  tx: Transaction,
  userId: string,
  accountId: string,
  limits: { maxExposure?: string | null | undefined; dailyLossLimit?: string | null | undefined },
): Promise<void> {
  const set: { maxExposure?: string | null; dailyLossLimit?: string | null } = {};
  if (limits.maxExposure !== undefined) set.maxExposure = limits.maxExposure;
  if (limits.dailyLossLimit !== undefined) set.dailyLossLimit = limits.dailyLossLimit;
  if (Object.keys(set).length === 0) return;
  await tx.update(tradingAccounts).set(set).where(eq(tradingAccounts.id, accountId));
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'trading_account.limits_changed',
    resourceType: 'trading_account',
    resourceId: accountId,
    context: set,
  });
}

/**
 * The account's profit or loss for its New York trading day so far: the app's
 * P&L on the account now, less where it stood at the latest earlier session's
 * valuation (zero before the first one). Negative is a loss.
 */
export async function accountDayPnl(
  tx: Transaction,
  accountId: string,
  sessionDate: string,
  pnl: Decimal,
): Promise<Decimal> {
  const [prev] = await tx
    .select({
      appEquity: accountValuations.appEquity,
      startingEquity: accountValuations.startingEquity,
      realized: accountValuations.realized,
      unrealized: accountValuations.unrealized,
    })
    .from(accountValuations)
    .where(
      and(
        eq(accountValuations.accountId, accountId),
        lt(accountValuations.sessionDate, sessionDate),
      ),
    )
    .orderBy(desc(accountValuations.sessionDate))
    .limit(1);
  if (!prev) return pnl;
  const before =
    prev.appEquity !== null && prev.startingEquity !== null
      ? new Decimal(prev.appEquity).minus(prev.startingEquity)
      : new Decimal(prev.realized).plus(prev.unrealized);
  return pnl.minus(before);
}

export interface DailyLossCheck {
  userId: string;
  accountId: string;
  /** The account's New York trading day being valued. */
  sessionDate: string;
  /** The app's P&L on the account now (realized, unrealized, less fees). */
  pnl: Decimal;
  /** Holdings valued at a stale or missing price: the loss is then not judged. */
  staleMarks: number;
  now: Date;
}

/**
 * Halts the account for the rest of the day when its loss reaches its daily
 * loss limit (A3): every running run on it pauses, an incident records why
 * and a notification goes out. Returns the loss when it halted.
 */
export async function checkAccountDailyLoss(
  tx: Transaction,
  input: DailyLossCheck,
): Promise<Decimal | undefined> {
  const account = await accountRow(tx, input.accountId);
  if (!account?.dailyLossLimit) return undefined;
  // A holding without a current price makes the figure uncertain; judge the next valuation.
  if (input.staleMarks > 0) return undefined;
  if (input.sessionDate !== nyDate(input.now)) return undefined;
  const loss = (await accountDayPnl(tx, input.accountId, input.sessionDate, input.pnl)).negated();
  if (loss.lt(account.dailyLossLimit)) return undefined;
  const halt = activeHalt(account, input.now);
  if (halt) return undefined;

  const money = (d: Decimal.Value) =>
    `$${new Decimal(d).toNumber().toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const summary = `${account.nickname} lost ${money(loss)} today, past its daily loss limit of ${money(account.dailyLossLimit)}. Its runs are paused for the rest of the day; positions stay open.`;
  await tx
    .update(tradingAccounts)
    .set({
      haltKind: 'daily_loss',
      haltedAt: input.now,
      haltReason: summary.slice(0, 500),
      haltDate: input.sessionDate,
    })
    .where(eq(tradingAccounts.id, input.accountId));
  const running = await tx
    .select({ id: strategyRuntimes.id })
    .from(strategyRuntimes)
    .where(
      and(eq(strategyRuntimes.accountId, input.accountId), eq(strategyRuntimes.status, 'running')),
    );
  await openIncident(tx, {
    userId: input.userId,
    kind: 'account_daily_loss',
    accountId: input.accountId,
    summary,
    details: {
      loss: loss.toFixed(2),
      limit: account.dailyLossLimit,
      sessionDate: input.sessionDate,
    },
    pause: running.map((r) => r.id),
    link: `/orders?account=${input.accountId}`,
  });
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'system',
    action: 'trading_account.daily_loss_halt',
    resourceType: 'trading_account',
    resourceId: input.accountId,
    context: { loss: loss.toFixed(2), limit: account.dailyLossLimit, runtimes: running.length },
  });
  return loss;
}

/**
 * What the account holds and has working, for the account exposure check:
 * the net quantity per instrument across every run, with the last fill price
 * as a fallback mark, and the unfilled notional of working Entry orders.
 */
export async function accountExposureBook(
  tx: Transaction,
  accountId: string,
): Promise<{
  /** `multiplier` only where it isn't 1: an option contract (ADR 0123). */
  positions: Map<string, { quantity: Decimal; lastPrice: Decimal; multiplier?: string }>;
  pendingEntry: Decimal;
}> {
  const fills = await tx.execute<{
    instrument_id: string;
    qty: string;
    last_price: string;
    multiplier: string;
  }>(sql`
    select oi.instrument_id,
           sum(case when oi.direction = 'buy' then f.quantity else -f.quantity end)::text as qty,
           (array_agg(f.price order by f.filled_at desc))[1]::text as last_price,
           min(i.multiplier)::text as multiplier
      from fill f
      join order_intent oi on oi.id = f.intent_id
      join instrument i on i.id = oi.instrument_id
     where oi.account_id = ${accountId}
     group by oi.instrument_id`);
  const positions = new Map<
    string,
    { quantity: Decimal; lastPrice: Decimal; multiplier?: string }
  >();
  for (const r of fills) {
    const q = new Decimal(r.qty);
    if (!q.isZero())
      positions.set(r.instrument_id, {
        quantity: q,
        lastPrice: new Decimal(r.last_price),
        ...(new Decimal(r.multiplier).eq(1) ? {} : { multiplier: r.multiplier }),
      });
  }
  const working = await tx
    .select({
      quantity: orderIntents.quantity,
      referencePrice: orderIntents.referencePrice,
      filled: brokerOrders.filledQuantity,
      multiplier: instruments.multiplier,
    })
    .from(orderIntents)
    .innerJoin(brokerOrders, eq(brokerOrders.intentId, orderIntents.id))
    .innerJoin(instruments, eq(instruments.id, orderIntents.instrumentId))
    .where(
      and(
        eq(orderIntents.accountId, accountId),
        eq(orderIntents.phase, 'entry'),
        inArray(brokerOrders.state, [...WORKING_STATES]),
      ),
    );
  let pendingEntry = new Decimal(0);
  for (const w of working) {
    const left = new Decimal(w.quantity).minus(w.filled ?? 0);
    if (left.gt(0) && w.referencePrice)
      pendingEntry = pendingEntry.plus(effectivePrice(left.times(w.referencePrice), w.multiplier));
  }
  return { positions, pendingEntry };
}
