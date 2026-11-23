import {
  feedFailureMode,
  isMarketDataProvider,
  providerDataTypes,
  type ChainStep,
  type FeedFailureMode,
} from '@tm/domain';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { IntegrationError } from './feeds';
import { openIncident, resolveIncident } from './incidents';
import { notify } from './notifications';
import {
  accountFeeds,
  dataFeedConnections,
  executionIncidents,
  strategyRuntimes,
  tradingAccounts,
} from './schema';

/**
 * Each account's own data feeds (Phase 7 P2, brief §4; ADR 0108). An account
 * can have a primary feed and fallbacks in order; runs on it price from that
 * chain, and every order records the feed that priced it. An account without
 * feeds prices through the data routes, as before.
 *
 * When the feed pricing an account stops, a paper account moves to the next
 * feed that answers, with an incident and a notification ("Now pricing from
 * the fallback feed …"); a switch is never silent. An account set to pause
 * (the default for live accounts) pauses its runs and says why instead. Prices
 * move back to the primary once it has looked healthy for five minutes.
 */

/** Feeds in one account's chain; more is not useful and slows every pass. */
export const MAX_ACCOUNT_FEEDS = 5;

export interface AccountFeedChain {
  accountId: string;
  nickname: string;
  mode: 'paper' | 'live';
  /** The rule in force: the account's own, or the default for its kind. */
  onFailure: FeedFailureMode;
  /** The account's own setting; null means the default for its kind. */
  onFailureSetting: FeedFailureMode | null;
  /** In order: the first is the primary. */
  feeds: { id: string; name: string }[];
  /** The feed pricing it now; null means the primary. */
  activeId: string | null;
  primaryOkSince: string | null;
  /** True while its runs are paused because the feed stopped (pause mode). */
  pausedForFeed: boolean;
}

/** An account's feed chain, or undefined if the account is not the tenant's. */
export async function accountFeedChain(
  tx: Transaction,
  accountId: string,
): Promise<AccountFeedChain | undefined> {
  const [account] = await tx
    .select({
      id: tradingAccounts.id,
      nickname: tradingAccounts.nickname,
      mode: tradingAccounts.mode,
      feedFailure: tradingAccounts.feedFailure,
      feedActiveId: tradingAccounts.feedActiveId,
      feedPrimaryOkSince: tradingAccounts.feedPrimaryOkSince,
    })
    .from(tradingAccounts)
    .where(eq(tradingAccounts.id, accountId));
  if (!account) return undefined;
  const [feeds, paused] = await Promise.all([
    tx
      .select({ id: accountFeeds.feedId, name: dataFeedConnections.name })
      .from(accountFeeds)
      .innerJoin(dataFeedConnections, eq(dataFeedConnections.id, accountFeeds.feedId))
      .where(eq(accountFeeds.accountId, accountId))
      .orderBy(asc(accountFeeds.position)),
    openFeedIncident(tx, accountId),
  ]);
  const mode = account.mode as 'paper' | 'live';
  return {
    accountId: account.id,
    nickname: account.nickname,
    mode,
    onFailure: feedFailureMode(account.feedFailure, mode),
    onFailureSetting: account.feedFailure,
    feeds,
    activeId: account.feedActiveId,
    primaryOkSince: account.feedPrimaryOkSince?.toISOString() ?? null,
    pausedForFeed: (paused?.details as { paused?: boolean } | undefined)?.paused === true,
  };
}

/** Every account's chain, for screens: feeds in order and the one pricing now. */
export async function accountFeedChains(
  tx: Transaction,
): Promise<Map<string, { feeds: { id: string; name: string }[]; activeId: string | null }>> {
  const rows = await tx
    .select({
      accountId: accountFeeds.accountId,
      id: accountFeeds.feedId,
      name: dataFeedConnections.name,
      activeId: tradingAccounts.feedActiveId,
    })
    .from(accountFeeds)
    .innerJoin(dataFeedConnections, eq(dataFeedConnections.id, accountFeeds.feedId))
    .innerJoin(tradingAccounts, eq(tradingAccounts.id, accountFeeds.accountId))
    .orderBy(asc(accountFeeds.position));
  const out = new Map<string, { feeds: { id: string; name: string }[]; activeId: string | null }>();
  for (const r of rows) {
    const chain = out.get(r.accountId) ?? { feeds: [], activeId: r.activeId };
    chain.feeds.push({ id: r.id, name: r.name });
    out.set(r.accountId, chain);
  }
  return out;
}

/**
 * The fallback feed pricing an account now, by name, or null while it prices
 * from its primary or has no feeds of its own. Shown on its runs.
 */
export function fallbackInUse(
  chain: { feeds: { id: string; name: string }[]; activeId: string | null } | undefined,
): { id: string; name: string } | null {
  if (!chain || !chain.activeId || chain.feeds[0]?.id === chain.activeId) return null;
  return chain.feeds.find((f) => f.id === chain.activeId) ?? null;
}

/** The account a run trades on (ADR 0106), to price it from that account's feeds. */
export async function runtimeAccountId(tx: Transaction, runtimeId: string): Promise<string | null> {
  const [row] = await tx
    .select({ accountId: strategyRuntimes.accountId })
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.id, runtimeId));
  return row?.accountId ?? null;
}

async function openFeedIncident(tx: Transaction, accountId: string) {
  const [row] = await tx
    .select({ id: executionIncidents.id, details: executionIncidents.details })
    .from(executionIncidents)
    .where(
      and(
        eq(executionIncidents.kind, 'account_feed'),
        eq(executionIncidents.accountId, accountId),
        isNull(executionIncidents.resolvedAt),
      ),
    );
  return row;
}

/**
 * Sets an account's feeds, in order, and what happens when the one pricing it
 * stops. An empty list goes back to the data routes. Changing the feeds starts
 * again from the new primary.
 */
export async function setAccountFeeds(
  tx: Transaction,
  userId: string,
  accountId: string,
  input: { feedIds: string[]; onFeedFailure?: FeedFailureMode | null | undefined },
): Promise<void> {
  const before = await accountFeedChain(tx, accountId);
  if (!before) throw new IntegrationError('not_found', 'Trading account not found');
  const feedIds = input.feedIds;
  if (new Set(feedIds).size !== feedIds.length) {
    throw new IntegrationError('bad_request', 'A feed can be in the list only once');
  }
  if (feedIds.length > MAX_ACCOUNT_FEEDS) {
    throw new IntegrationError(
      'bad_request',
      `An account can have up to ${MAX_ACCOUNT_FEEDS} data feeds`,
    );
  }
  if (feedIds.length > 0) {
    const found = await tx
      .select({
        id: dataFeedConnections.id,
        name: dataFeedConnections.name,
        provider: dataFeedConnections.provider,
      })
      .from(dataFeedConnections)
      .where(inArray(dataFeedConnections.id, feedIds));
    for (const id of feedIds) {
      const feed = found.find((f) => f.id === id);
      if (!feed) throw new IntegrationError('bad_request', 'That data feed no longer exists');
      if (
        !isMarketDataProvider(feed.provider) ||
        !providerDataTypes(feed.provider).includes('quotes')
      ) {
        throw new IntegrationError('bad_request', `${feed.name} does not give live prices`);
      }
    }
  }
  const changed =
    feedIds.length !== before.feeds.length || feedIds.some((id, i) => before.feeds[i]?.id !== id);
  const onFailure =
    input.onFeedFailure === undefined ? before.onFailureSetting : input.onFeedFailure;
  if (changed) {
    await tx.delete(accountFeeds).where(eq(accountFeeds.accountId, accountId));
    if (feedIds.length > 0) {
      await tx
        .insert(accountFeeds)
        .values(feedIds.map((feedId, position) => ({ userId, accountId, feedId, position })));
    }
  }
  await tx
    .update(tradingAccounts)
    .set({
      feedFailure: onFailure,
      ...(changed ? { feedActiveId: null, feedPrimaryOkSince: null } : {}),
      updatedAt: new Date(),
      rowVersion: sql`${tradingAccounts.rowVersion} + 1`,
    })
    .where(eq(tradingAccounts.id, accountId));
  if (changed) {
    // New feeds start from their primary: an earlier switch no longer applies.
    const open = await openFeedIncident(tx, accountId);
    if (open) {
      await resolveIncident(tx, {
        userId,
        incidentId: open.id,
        by: 'user',
        note: 'The account’s data feeds were changed',
      });
    }
  }
  if (changed || onFailure !== before.onFailureSetting) {
    await recordAudit(tx, {
      userId,
      actorType: 'user',
      action: 'trading_account.feeds_changed',
      resourceType: 'trading_account',
      resourceId: accountId,
      context: {
        from: { feeds: before.feeds.map((f) => f.id), onFeedFailure: before.onFailureSetting },
        to: { feeds: feedIds, onFeedFailure: onFailure },
      },
    });
  }
}

/**
 * Applies one look at an account's chain (`chainStep`). Conditional on the
 * feed the pass saw pricing it, so when several runs' passes see the same
 * outage only one switches the account and announces it. Returns the feed
 * that prices the account after the step (null: the primary).
 */
export async function applyChainStep(
  tx: Transaction,
  input: { userId: string; chain: AccountFeedChain; step: ChainStep; now: Date },
): Promise<string | null> {
  const { chain, step, now, userId } = input;
  const accountId = chain.accountId;
  const primary = chain.feeds[0]?.id ?? null;
  const active =
    chain.activeId && chain.feeds.some((f) => f.id === chain.activeId) ? chain.activeId : null;
  const name = (id: string | null) =>
    chain.feeds.find((f) => f.id === (id ?? primary))?.name ?? 'a feed';
  const seen = and(
    eq(tradingAccounts.id, accountId),
    active === null
      ? sql`(${tradingAccounts.feedActiveId} is null or ${tradingAccounts.feedActiveId} = ${primary})`
      : eq(tradingAccounts.feedActiveId, active),
  );
  const link = '/settings/platforms';
  switch (step.kind) {
    case 'stay':
      return active;
    case 'primary_recovering':
      await tx
        .update(tradingAccounts)
        .set({ feedPrimaryOkSince: new Date(step.since) })
        .where(and(seen, isNull(tradingAccounts.feedPrimaryOkSince)));
      return active;
    case 'primary_relapsed':
      await tx.update(tradingAccounts).set({ feedPrimaryOkSince: null }).where(seen);
      return active;
    case 'switch': {
      const to = step.to === primary ? null : step.to;
      const rows = await tx
        .update(tradingAccounts)
        .set({ feedActiveId: to, feedPrimaryOkSince: null })
        .where(seen)
        .returning({ id: tradingAccounts.id });
      if (rows.length === 0) {
        // Another pass switched it first: price from what it chose.
        const [now2] = await tx
          .select({ id: tradingAccounts.feedActiveId })
          .from(tradingAccounts)
          .where(eq(tradingAccounts.id, accountId));
        return now2?.id ?? null;
      }
      await recordAudit(tx, {
        userId,
        actorType: 'system',
        action: 'trading_account.feed_switched',
        resourceType: 'trading_account',
        resourceId: accountId,
        context: { from: active ?? primary, to: step.to },
      });
      const open = await openFeedIncident(tx, accountId);
      if (to === null) {
        // Back on the primary.
        if (open) {
          await resolveIncident(tx, {
            userId,
            incidentId: open.id,
            by: 'system',
            note: `Prices are back on ${name(null)}`,
          });
        }
        await notify(tx, {
          userId,
          kind: 'disconnect',
          title: `Prices are back on ${name(null)}`,
          body:
            step.back && active
              ? `${chain.nickname} prices from its primary feed ${name(null)} again.`
              : `${chain.nickname} prices from ${name(null)} again.`,
          link,
          resourceType: 'trading_account',
          resourceId: accountId,
          dedupeKey: `account-feed:${accountId}:primary:${now.toISOString()}`,
        });
        return null;
      }
      const summary = `${name(active)} stopped sending current prices for ${chain.nickname}. Now pricing from the fallback feed ${name(to)}.`;
      if (open) {
        await tx
          .update(executionIncidents)
          .set({ summary, details: { feedId: to, paused: false } })
          .where(eq(executionIncidents.id, open.id));
        await notify(tx, {
          userId,
          kind: 'disconnect',
          title: `Now pricing from the fallback feed ${name(to)}`,
          body: summary,
          link,
          resourceType: 'execution_incident',
          resourceId: open.id,
          dedupeKey: `account-feed:${accountId}:${to}:${now.toISOString()}`,
        });
      } else {
        await openIncident(tx, {
          userId,
          kind: 'account_feed',
          accountId,
          summary,
          details: { feedId: to, paused: false },
          link,
        });
      }
      return to;
    }
    case 'pause': {
      const running = await tx
        .select({ id: strategyRuntimes.id })
        .from(strategyRuntimes)
        .where(
          and(eq(strategyRuntimes.accountId, accountId), eq(strategyRuntimes.status, 'running')),
        );
      const summary = `${name(active)} stopped sending current prices for ${chain.nickname}, so its runs are paused. Positions stay open.`;
      const details = { feedId: active ?? primary, paused: true };
      // An incident already open for a switch now records the pause.
      const open = await openFeedIncident(tx, accountId);
      if (open && (open.details as { paused?: boolean }).paused !== true) {
        await tx
          .update(executionIncidents)
          .set({ summary, details })
          .where(eq(executionIncidents.id, open.id));
      }
      await openIncident(tx, {
        userId,
        kind: 'account_feed',
        accountId,
        summary,
        details,
        pause: running.map((r) => r.id),
        link,
      });
      return active;
    }
    case 'recovered': {
      const open = await openFeedIncident(tx, accountId);
      if (open) {
        await resolveIncident(tx, {
          userId,
          incidentId: open.id,
          by: 'system',
          note: `${name(active)} sends current prices again`,
        });
        await notify(tx, {
          userId,
          kind: 'disconnect',
          title: `Prices are back on ${name(active)}`,
          body: `${name(active)} sends current prices for ${chain.nickname} again. Its paused runs stay paused until you resume them.`,
          link: '/orders',
          resourceType: 'trading_account',
          resourceId: accountId,
          dedupeKey: `account-feed:${accountId}:recovered:${now.toISOString()}`,
        });
      }
      return active;
    }
  }
}
