import {
  liveTradingEnabled,
  PDT_EQUITY,
  PDT_WARNING,
  resolveRoute,
  type BrokerAccountBalance,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isPlatformAdmin } from './admin';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { IntegrationError } from './feeds';
import { notify } from './notifications';
import {
  accountFeeds,
  dataFeedConnections,
  dataRoutes,
  instruments,
  strategyInstruments,
  tradingAccounts,
} from './schema';

/**
 * The live gate (Phase 7 P3, brief §6; ADR 0109). Live trading is a
 * capability, not a default:
 *
 * - Nothing live happens unless the server runs with LIVE_TRADING_ENABLED=true
 *   (off by default; `liveTradingEnabled`). With it off no live platform can
 *   be added, no run starts or resumes on a live account and the worker
 *   refuses to open a live account's broker.
 * - Adding a live platform needs a live key, the person's real-money
 *   acknowledgement and, for now, a platform admin: inviting other members to
 *   live trading is a separate launch decision (brief §10).
 * - A live account starts in pilot mode, under hard caps per order and on
 *   total exposure, until a person ends pilot mode on purpose.
 * - A live run starts only on a real-time feed, with its own confirmation.
 */

/** A new live account's pilot caps (brief §6), in dollars. */
export const PILOT_DEFAULTS = { maxOrder: '500', maxExposure: '2500' } as const;
/** The most pilot caps can be raised to before pilot mode is ended (O191). */
export const PILOT_CEILING = { maxOrder: '5000', maxExposure: '25000' } as const;

export const LIVE_OFF_TEXT = 'Live trading is turned off on this server.';
export const DELAYED_FEED_TEXT =
  "This account's data is delayed — live trading needs a real-time feed.";
export { PDT_EQUITY, PDT_WARNING };

interface PilotColumns {
  mode: 'paper' | 'live';
  pilotMaxOrder: string | null;
  pilotMaxExposure: string | null;
  pilotEndedAt: Date | null;
}

/** A live account's pilot caps while it is in pilot mode; null for paper or after it ended. */
export function pilotOf(a: PilotColumns): { maxOrder: string; maxExposure: string } | null {
  if (a.mode !== 'live' || a.pilotEndedAt) return null;
  return {
    maxOrder: a.pilotMaxOrder ?? PILOT_DEFAULTS.maxOrder,
    maxExposure: a.pilotMaxExposure ?? PILOT_DEFAULTS.maxExposure,
  };
}

/** Throws unless a live platform may be added now. */
export async function assertLivePlatformAllowed(
  tx: Transaction,
  provider: string,
  acknowledged: boolean,
): Promise<void> {
  if (!liveTradingEnabled()) {
    throw new IntegrationError(
      'invalid_state',
      `${LIVE_OFF_TEXT} Only paper platforms can be added.`,
    );
  }
  if (provider !== 'alpaca') {
    throw new IntegrationError('bad_request', 'Live trading is available with Alpaca only');
  }
  if (!(await isPlatformAdmin(tx))) {
    throw new IntegrationError('invalid_state', 'Live trading is not open to members yet');
  }
  if (!acknowledged) {
    throw new IntegrationError(
      'bad_request',
      'Confirm that you understand this platform trades real money',
    );
  }
}

async function liveAccount(tx: Transaction, accountId: string) {
  const [a] = await tx.select().from(tradingAccounts).where(eq(tradingAccounts.id, accountId));
  if (!a) throw new IntegrationError('not_found', 'Trading account not found');
  if (a.mode !== 'live') {
    throw new IntegrationError('invalid_state', 'Pilot mode is for live accounts only');
  }
  return a;
}

const dollars = (v: string) =>
  `$${new Decimal(v).toNumber().toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Sets a live account's pilot caps, within the ceiling, while it is in pilot mode. */
export async function setAccountPilot(
  tx: Transaction,
  userId: string,
  accountId: string,
  caps: { maxOrder: string; maxExposure: string },
): Promise<void> {
  const a = await liveAccount(tx, accountId);
  const before = pilotOf(a);
  if (!before) throw new IntegrationError('invalid_state', 'Pilot mode has ended on this account');
  for (const [value, ceiling, name] of [
    [caps.maxOrder, PILOT_CEILING.maxOrder, 'per order'],
    [caps.maxExposure, PILOT_CEILING.maxExposure, 'on total exposure'],
  ] as const) {
    const v = new Decimal(value);
    if (!v.isFinite() || v.lte(0) || v.gt(ceiling)) {
      throw new IntegrationError(
        'bad_request',
        `The pilot cap ${name} must be above $0 and at most ${dollars(ceiling)}`,
      );
    }
  }
  await tx
    .update(tradingAccounts)
    .set({
      pilotMaxOrder: caps.maxOrder,
      pilotMaxExposure: caps.maxExposure,
      updatedAt: new Date(),
      rowVersion: sql`${tradingAccounts.rowVersion} + 1`,
    })
    .where(eq(tradingAccounts.id, accountId));
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'trading_account.pilot_changed',
    resourceType: 'trading_account',
    resourceId: accountId,
    context: { from: before, to: caps },
  });
}

/** Ends pilot mode on a live account: a separate, deliberate action. */
export async function endPilotMode(
  tx: Transaction,
  userId: string,
  accountId: string,
): Promise<void> {
  const a = await liveAccount(tx, accountId);
  const before = pilotOf(a);
  if (!before) return;
  await tx
    .update(tradingAccounts)
    .set({
      pilotEndedAt: new Date(),
      updatedAt: new Date(),
      rowVersion: sql`${tradingAccounts.rowVersion} + 1`,
    })
    .where(and(eq(tradingAccounts.id, accountId), isNull(tradingAccounts.pilotEndedAt)));
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'trading_account.pilot_ended',
    resourceType: 'trading_account',
    resourceId: accountId,
    context: { caps: before },
  });
  await notify(tx, {
    userId,
    kind: 'risk_pause',
    title: `Pilot mode ended on ${a.nickname}`,
    body: `Orders on ${a.nickname} are no longer held to ${dollars(before.maxOrder)} each and ${dollars(before.maxExposure)} in total; the account's and each strategy's own limits still apply.`,
    link: '/settings/accounts',
    resourceType: 'trading_account',
    resourceId: accountId,
    dedupeKey: `pilot-ended:${accountId}`,
  });
}

/**
 * Why a run cannot start (or resume) on a live account now, in words, or null
 * when it may: the server's flag, and a real-time feed among the feeds that
 * price it (the account's own chain, else the data routes for the strategy's
 * instruments).
 */
export async function liveStartProblem(
  tx: Transaction,
  accountId: string,
  strategyId: string,
): Promise<{ reason: 'live_disabled' | 'live_feed_delayed'; message: string } | null> {
  if (!liveTradingEnabled()) return { reason: 'live_disabled', message: LIVE_OFF_TEXT };
  const chain = await tx
    .select({ realtime: dataFeedConnections.isRealtime, active: dataFeedConnections.isActive })
    .from(accountFeeds)
    .innerJoin(dataFeedConnections, eq(dataFeedConnections.id, accountFeeds.feedId))
    .where(eq(accountFeeds.accountId, accountId));
  let realtime: boolean;
  if (chain.length > 0) {
    realtime = chain.some((f) => f.active && f.realtime);
  } else {
    const [routes, uses] = await Promise.all([
      tx.select().from(dataRoutes),
      tx
        .selectDistinct({ assetClass: instruments.assetClass, venue: instruments.venue })
        .from(strategyInstruments)
        .innerJoin(instruments, eq(instruments.id, strategyInstruments.instrumentId))
        .where(eq(strategyInstruments.strategyId, strategyId)),
    ]);
    const feedIds = new Set<string>();
    for (const u of uses.length > 0 ? uses : [{ assetClass: 'stock', venue: '' }]) {
      const route = resolveRoute(
        routes.map((r) => ({
          ...r,
          primaryOkSince: r.primaryOkSince?.toISOString() ?? null,
        })),
        { assetClass: u.assetClass, venue: u.venue, dataType: 'quotes' },
      );
      if (route) {
        feedIds.add(route.primaryFeedId);
        if (route.fallbackFeedId) feedIds.add(route.fallbackFeedId);
      }
    }
    const feeds =
      feedIds.size === 0
        ? []
        : await tx
            .select({
              realtime: dataFeedConnections.isRealtime,
              active: dataFeedConnections.isActive,
            })
            .from(dataFeedConnections)
            .where(inArray(dataFeedConnections.id, [...feedIds]));
    realtime = feeds.some((f) => f.active && f.realtime);
  }
  return realtime ? null : { reason: 'live_feed_delayed', message: DELAYED_FEED_TEXT };
}

/** Records a refused live start or resume, so it shows in the audit trail (A7). */
export async function recordLiveRefusal(
  tx: Transaction,
  input: {
    userId: string;
    strategyId: string;
    accountId: string | undefined;
    reason: string;
    message: string;
  },
): Promise<void> {
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'strategy.live_start_refused',
    resourceType: 'strategy',
    resourceId: input.strategyId,
    context: { accountId: input.accountId ?? null, reason: input.reason, message: input.message },
  });
}

/** Keeps what the broker last reported about an account, for pattern-day-trader awareness. */
export async function recordBrokerFigures(
  tx: Transaction,
  accountId: string,
  balance: BrokerAccountBalance | undefined,
): Promise<void> {
  if (!balance) return;
  await tx
    .update(tradingAccounts)
    .set({
      brokerEquity: balance.equity,
      ...(balance.dayTrades !== undefined ? { brokerDayTrades: balance.dayTrades } : {}),
      ...(balance.margin !== undefined ? { brokerMargin: balance.margin } : {}),
    })
    .where(eq(tradingAccounts.id, accountId));
}
