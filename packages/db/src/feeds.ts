import {
  FAILOVER,
  isFundamentalsProvider,
  isMarketDataProvider,
  isProviderId,
  PROVIDERS,
  providerCoversVenue,
  resolveRoute,
  type FailoverStep,
  type RouteLike,
} from '@tm/domain';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import { assertFeature } from './entitlements';
import { notify } from './notifications';
import {
  credentials,
  dataFeedConnections,
  dataRoutes,
  instruments,
  strategies,
  strategyInstruments,
  strategyRuntimes,
} from './schema';

/**
 * Data feeds and routes (§9.2, §9.4, §14.4; ADR 0016). A feed is one
 * connection to a market-data provider; routes pick a primary and an optional
 * fallback feed per asset class, venue and data type. The worker checks feeds
 * and the runtime fails a route over to its fallback, and back, as needed.
 */

export class IntegrationError extends Error {
  constructor(
    public readonly code: 'not_found' | 'bad_request' | 'conflict' | 'invalid_state',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}

type Health = 'healthy' | 'degraded' | 'down' | 'unknown';
type Entitlement = 'unknown' | 'entitled' | 'not_entitled';
type DataType = 'quotes' | 'trades' | 'bars';

export interface FeedRouteUse {
  routeId: string;
  role: 'primary' | 'fallback';
  assetClass: string;
  venue: string | null;
  dataType: DataType;
  /** True when prices on this route come from this feed right now. */
  serving: boolean;
}

export interface FeedSummary {
  id: string;
  name: string;
  provider: string;
  credential: { id: string; label: string } | null;
  assetClasses: string[];
  isRealtime: boolean;
  isActive: boolean;
  health: Health;
  entitlement: Entitlement;
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** A test has been asked for and not finished yet. */
  checking: boolean;
  routes: FeedRouteUse[];
  rowVersion: number;
}

export interface RouteSummary {
  id: string;
  assetClass: string;
  venue: string | null;
  dataType: DataType;
  primary: { id: string; name: string; isActive: boolean };
  fallback: { id: string; name: string; isActive: boolean } | null;
  activeSource: 'primary' | 'fallback';
  switchedAt: string | null;
  rowVersion: number;
}

/** Strategies that are running or paused, with what their instruments need. */
export interface FeedDependent {
  runtimeId: string;
  strategyId: string;
  strategyName: string;
  status: 'running' | 'paused';
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listFeeds(tx: Transaction): Promise<FeedSummary[]> {
  const [feeds, routes, creds] = await Promise.all([
    tx.select().from(dataFeedConnections).orderBy(asc(dataFeedConnections.createdAt)),
    tx.select().from(dataRoutes),
    tx.select({ id: credentials.id, label: credentials.label }).from(credentials),
  ]);
  const labels = new Map(creds.map((c) => [c.id, c.label]));
  return feeds.map((f) => ({
    id: f.id,
    name: f.name,
    provider: f.provider,
    credential: f.credentialRef
      ? { id: f.credentialRef, label: labels.get(f.credentialRef) ?? 'Stored key' }
      : null,
    assetClasses: f.assetClasses,
    isRealtime: f.isRealtime,
    isActive: f.isActive,
    health: f.health,
    entitlement: f.entitlement,
    lastSuccessAt: f.lastSuccessAt?.toISOString() ?? null,
    lastCheckedAt: f.lastCheckedAt?.toISOString() ?? null,
    lastError: f.lastError,
    checking: f.checkRequestedAt !== null,
    routes: routes.flatMap((r) => {
      const role =
        r.primaryFeedId === f.id ? 'primary' : r.fallbackFeedId === f.id ? 'fallback' : undefined;
      if (!role) return [];
      return [
        {
          routeId: r.id,
          role,
          assetClass: r.assetClass,
          venue: r.venue,
          dataType: r.dataType,
          serving: r.activeSource === role,
        } satisfies FeedRouteUse,
      ];
    }),
    rowVersion: f.rowVersion,
  }));
}

export async function getFeed(tx: Transaction, id: string): Promise<FeedSummary> {
  const feed = (await listFeeds(tx)).find((f) => f.id === id);
  if (!feed) throw new IntegrationError('not_found', 'Data feed not found');
  return feed;
}

export async function listRoutes(tx: Transaction): Promise<RouteSummary[]> {
  const [routes, feeds] = await Promise.all([
    tx.select().from(dataRoutes).orderBy(asc(dataRoutes.assetClass), asc(dataRoutes.dataType)),
    tx
      .select({
        id: dataFeedConnections.id,
        name: dataFeedConnections.name,
        isActive: dataFeedConnections.isActive,
      })
      .from(dataFeedConnections),
  ]);
  const byId = new Map(feeds.map((f) => [f.id, f]));
  const ref = (id: string) => byId.get(id) ?? { id, name: 'Removed feed', isActive: false };
  return routes.map((r) => ({
    id: r.id,
    assetClass: r.assetClass,
    venue: r.venue,
    dataType: r.dataType,
    primary: ref(r.primaryFeedId),
    fallback: r.fallbackFeedId ? ref(r.fallbackFeedId) : null,
    activeSource: r.activeSource,
    switchedAt: r.switchedAt?.toISOString() ?? null,
    rowVersion: r.rowVersion,
  }));
}

/**
 * Running or paused strategies whose price route reaches this feed now: as
 * the primary, or as the fallback while the route is failed over (§9.4).
 */
export async function feedDependents(tx: Transaction, feedId: string): Promise<FeedDependent[]> {
  const runtimes = await tx
    .select({
      runtimeId: strategyRuntimes.id,
      strategyId: strategyRuntimes.strategyId,
      status: strategyRuntimes.status,
      strategyName: strategies.name,
    })
    .from(strategyRuntimes)
    .innerJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .where(inArray(strategyRuntimes.status, ['running', 'paused']));
  if (runtimes.length === 0) return [];
  const [uses, routes] = await Promise.all([
    tx
      .selectDistinct({
        strategyId: strategyInstruments.strategyId,
        assetClass: instruments.assetClass,
        venue: instruments.venue,
      })
      .from(strategyInstruments)
      .innerJoin(instruments, eq(instruments.id, strategyInstruments.instrumentId))
      .where(
        inArray(
          strategyInstruments.strategyId,
          runtimes.map((r) => r.strategyId),
        ),
      ),
    loadRoutes(tx),
  ]);
  const reaches = (strategyId: string) =>
    uses
      .filter((u) => u.strategyId === strategyId)
      .some((u) => {
        const route = resolveRoute(routes, {
          assetClass: u.assetClass,
          venue: u.venue,
          dataType: 'quotes',
        });
        if (!route) return false;
        return route.activeSource === 'primary'
          ? route.primaryFeedId === feedId
          : route.fallbackFeedId === feedId;
      });
  return runtimes
    .filter((r) => reaches(r.strategyId))
    .map((r) => ({ ...r, status: r.status as 'running' | 'paused' }));
}

async function loadRoutes(tx: Transaction): Promise<RouteLike[]> {
  const rows = await tx.select().from(dataRoutes);
  return rows.map((r) => ({
    id: r.id,
    assetClass: r.assetClass,
    venue: r.venue,
    dataType: r.dataType,
    primaryFeedId: r.primaryFeedId,
    fallbackFeedId: r.fallbackFeedId,
    activeSource: r.activeSource,
    primaryOkSince: r.primaryOkSince?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export interface FeedInput {
  name: string;
  provider: string;
  credentialId?: string | null | undefined;
  assetClasses: string[];
}

async function checkFeedInput(tx: Transaction, input: FeedInput) {
  if (!isProviderId(input.provider)) {
    throw new IntegrationError('bad_request', 'Choose a supported provider');
  }
  const info = PROVIDERS[input.provider];
  // Price feeds and company data feeds (ADR 0031) share this table; brokers do not.
  if (!isMarketDataProvider(input.provider) && !isFundamentalsProvider(input.provider)) {
    throw new IntegrationError('bad_request', `${info.name} does not provide market data`);
  }
  const supported: readonly string[] = info.assetClasses;
  const unsupported = input.assetClasses.filter((a) => !supported.includes(a));
  if (input.assetClasses.length === 0 || unsupported.length > 0) {
    throw new IntegrationError(
      'bad_request',
      `${info.name} covers ${info.assetClasses.join(' and ')} here`,
    );
  }
  if (info.credentialFields.length === 0) {
    if (input.credentialId) {
      throw new IntegrationError('bad_request', `${info.name} needs no API key`);
    }
    return null;
  }
  if (!input.credentialId) {
    throw new IntegrationError('bad_request', `Choose or add an API key for ${info.name}`);
  }
  const [cred] = await tx
    .select({ id: credentials.id, provider: credentials.provider })
    .from(credentials)
    .where(eq(credentials.id, input.credentialId));
  if (!cred) throw new IntegrationError('bad_request', 'That API key no longer exists');
  if (cred.provider !== input.provider) {
    throw new IntegrationError('bad_request', `That key is not for ${info.name}`);
  }
  return cred.id;
}

export async function createFeed(
  tx: Transaction,
  input: FeedInput & { userId: string },
): Promise<FeedSummary> {
  const credentialRef = await checkFeedInput(tx, input);
  // Company filings are public and free; only price feeds from a provider are a plan feature.
  if (isMarketDataProvider(input.provider)) await assertFeature(tx, 'liveData');
  const [row] = await tx
    .insert(dataFeedConnections)
    .values({
      userId: input.userId,
      name: input.name.trim().slice(0, 100),
      provider: input.provider,
      credentialRef,
      assetClasses: input.assetClasses as (typeof dataFeedConnections.$inferInsert)['assetClasses'],
      // Tested straight away, so its health is known before it is routed.
      checkRequestedAt: new Date(),
    })
    .returning({ id: dataFeedConnections.id });
  if (!row) throw new Error('feed insert failed');
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'data_feed.created',
    resourceType: 'data_feed_connection',
    resourceId: row.id,
    context: { provider: input.provider },
  });
  await addMissingRoutes(tx, input.userId, row.id);
  return getFeed(tx, row.id);
}

/** What a new feed is routed for when nothing else covers it yet. */
const AUTO_ROUTE_DATA_TYPES = ['bars', 'quotes'] as const;

/**
 * Makes a real-provider feed the primary for every asset class it covers, on
 * any venue, for bars and live prices, wherever no route exists yet. Routes the
 * user already set up are left alone. Demo feeds keep their seeded demo routes.
 */
async function addMissingRoutes(tx: Transaction, userId: string, feedId: string) {
  const [feed] = await tx
    .select()
    .from(dataFeedConnections)
    .where(eq(dataFeedConnections.id, feedId));
  if (!feed || !feed.isActive || !providerCoversVenue(feed.provider, null)) return;
  for (const assetClass of feed.assetClasses) {
    for (const dataType of AUTO_ROUTE_DATA_TYPES) {
      const [row] = await tx
        .insert(dataRoutes)
        .values({ userId, assetClass, venue: null, dataType, primaryFeedId: feed.id })
        .onConflictDoNothing()
        .returning({ id: dataRoutes.id });
      if (!row) continue;
      await recordAudit(tx, {
        userId,
        actorType: 'system',
        action: 'data_route.created',
        resourceType: 'data_route',
        resourceId: row.id,
        context: { primaryFeedId: feed.id, fallbackFeedId: null, automatic: true },
      });
    }
  }
}

export async function updateFeed(
  tx: Transaction,
  input: {
    userId: string;
    id: string;
    rowVersion: number;
    name?: string | undefined;
    credentialId?: string | null | undefined;
    assetClasses?: string[] | undefined;
  },
): Promise<FeedSummary> {
  const current = await getFeed(tx, input.id);
  if (current.rowVersion !== input.rowVersion) {
    throw new IntegrationError(
      'conflict',
      'This feed changed since you opened it. Reload and try again.',
    );
  }
  const next = {
    name: input.name ?? current.name,
    provider: current.provider,
    credentialId: input.credentialId === undefined ? current.credential?.id : input.credentialId,
    assetClasses: input.assetClasses ?? current.assetClasses,
  };
  const credentialRef = await checkFeedInput(tx, next);
  const credentialChanged = credentialRef !== (current.credential?.id ?? null);
  await tx
    .update(dataFeedConnections)
    .set({
      name: next.name.trim().slice(0, 100),
      credentialRef,
      assetClasses: next.assetClasses as (typeof dataFeedConnections.$inferInsert)['assetClasses'],
      rowVersion: current.rowVersion + 1,
      ...(credentialChanged ? { checkRequestedAt: new Date() } : {}),
    })
    .where(eq(dataFeedConnections.id, input.id));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'data_feed.updated',
    resourceType: 'data_feed_connection',
    resourceId: input.id,
    context: { credentialChanged },
  });
  return getFeed(tx, input.id);
}

/** Asks the worker to test the feed now; the page shows the result when it lands. */
export async function requestFeedCheck(tx: Transaction, id: string): Promise<FeedSummary> {
  const rows = await tx
    .update(dataFeedConnections)
    .set({ checkRequestedAt: new Date() })
    .where(eq(dataFeedConnections.id, id))
    .returning({ id: dataFeedConnections.id });
  if (rows.length === 0) throw new IntegrationError('not_found', 'Data feed not found');
  return getFeed(tx, id);
}

export interface DeactivateOptions {
  /** Moves every route that uses this feed to another active feed instead. */
  replacementFeedId?: string | undefined;
  /** Pauses the running strategies that depend on it (§9.4). */
  pauseStrategies?: boolean | undefined;
}

/**
 * Turns a feed on or off. Turning off a feed that running or paused
 * strategies depend on needs a replacement feed for its routes or pausing
 * those strategies (§9.4); otherwise it is refused with what depends on it.
 */
export async function setFeedActive(
  tx: Transaction,
  input: { userId: string; id: string; active: boolean } & DeactivateOptions,
): Promise<FeedSummary> {
  const feed = await getFeed(tx, input.id);
  if (input.active) {
    if (!feed.isActive) {
      await tx
        .update(dataFeedConnections)
        .set({ isActive: true, checkRequestedAt: new Date(), rowVersion: feed.rowVersion + 1 })
        .where(eq(dataFeedConnections.id, input.id));
      await recordAudit(tx, {
        userId: input.userId,
        actorType: 'user',
        action: 'data_feed.activated',
        resourceType: 'data_feed_connection',
        resourceId: input.id,
      });
      await addMissingRoutes(tx, input.userId, input.id);
    }
    return getFeed(tx, input.id);
  }
  if (!feed.isActive) return feed;

  const dependents = await feedDependents(tx, input.id);
  const replacement = input.replacementFeedId;
  if (dependents.length > 0 && !replacement && !input.pauseStrategies) {
    throw new IntegrationError(
      'invalid_state',
      `${dependents.map((d) => d.strategyName).join(', ')} ${dependents.length === 1 ? 'uses' : 'use'} this feed. Choose a replacement feed or pause ${dependents.length === 1 ? 'it' : 'them'}.`,
      { dependents, routes: feed.routes },
    );
  }
  if (replacement) await rerouteFeed(tx, { userId: input.userId, from: feed, to: replacement });
  if (input.pauseStrategies && !replacement) {
    for (const d of dependents.filter((x) => x.status === 'running')) {
      await tx
        .update(strategyRuntimes)
        .set({ status: 'paused', pauseReason: `Its data feed ${feed.name} was turned off.` })
        .where(and(eq(strategyRuntimes.id, d.runtimeId), eq(strategyRuntimes.status, 'running')));
      await recordAudit(tx, {
        userId: input.userId,
        actorType: 'user',
        action: 'runtime.paused',
        resourceType: 'strategy_runtime',
        resourceId: d.runtimeId,
        context: { reason: 'data_feed_deactivated', feedId: feed.id },
      });
    }
  }
  await tx
    .update(dataFeedConnections)
    .set({ isActive: false, rowVersion: feed.rowVersion + 1 })
    .where(eq(dataFeedConnections.id, input.id));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'data_feed.deactivated',
    resourceType: 'data_feed_connection',
    resourceId: input.id,
    context: {
      replacementFeedId: replacement ?? null,
      pausedRuntimes:
        input.pauseStrategies && !replacement ? dependents.map((d) => d.runtimeId) : [],
    },
  });
  return getFeed(tx, input.id);
}

async function rerouteFeed(
  tx: Transaction,
  input: { userId: string; from: FeedSummary; to: string },
) {
  const [target] = await tx
    .select()
    .from(dataFeedConnections)
    .where(eq(dataFeedConnections.id, input.to));
  if (!target || !target.isActive || target.id === input.from.id) {
    throw new IntegrationError('bad_request', 'Choose another active feed as the replacement');
  }
  for (const use of input.from.routes) {
    const [route] = await tx.select().from(dataRoutes).where(eq(dataRoutes.id, use.routeId));
    if (!route) continue;
    checkFeedFits(target, route);
    if (use.role === 'primary') {
      const fallback = route.fallbackFeedId === target.id ? null : route.fallbackFeedId;
      await tx
        .update(dataRoutes)
        .set({
          primaryFeedId: target.id,
          fallbackFeedId: fallback,
          activeSource: 'primary',
          primaryOkSince: null,
          switchedAt: route.activeSource === 'fallback' ? new Date() : route.switchedAt,
          rowVersion: route.rowVersion + 1,
        })
        .where(eq(dataRoutes.id, route.id));
      await auditPrimaryChange(tx, input.userId, route.id, route.primaryFeedId, target.id);
    } else {
      const replacementIsPrimary = route.primaryFeedId === target.id;
      await tx
        .update(dataRoutes)
        .set({
          fallbackFeedId: replacementIsPrimary ? null : target.id,
          activeSource: replacementIsPrimary ? 'primary' : route.activeSource,
          primaryOkSince: replacementIsPrimary ? null : route.primaryOkSince,
          rowVersion: route.rowVersion + 1,
        })
        .where(eq(dataRoutes.id, route.id));
    }
  }
}

/**
 * Removes a feed. A real-provider feed takes its any-venue routes with it when
 * it is their only feed (as `addMissingRoutes` made them) and no strategy is
 * running on it; any other route must be pointed at another feed first.
 */
export async function deleteFeed(
  tx: Transaction,
  input: { userId: string; id: string },
): Promise<void> {
  const before = await getFeed(tx, input.id);
  if (before.provider !== 'demo' && (await feedDependents(tx, input.id)).length === 0) {
    const sole = (await listRoutes(tx)).filter(
      (r) => r.primary.id === input.id && r.fallback === null && r.venue === null,
    );
    for (const route of sole) await deleteRoute(tx, { userId: input.userId, id: route.id });
  }
  const feed = await getFeed(tx, input.id);
  if (feed.routes.length > 0) {
    throw new IntegrationError(
      'invalid_state',
      'Routes still use this feed. Point them at another feed first.',
      { routes: feed.routes },
    );
  }
  await tx.delete(dataFeedConnections).where(eq(dataFeedConnections.id, input.id));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'data_feed.deleted',
    resourceType: 'data_feed_connection',
    resourceId: input.id,
    context: { provider: feed.provider },
  });
  // Any gaps it leaves go to the user's other feeds, oldest first.
  const others = await tx
    .select({ id: dataFeedConnections.id })
    .from(dataFeedConnections)
    .orderBy(asc(dataFeedConnections.createdAt));
  for (const other of others) await addMissingRoutes(tx, input.userId, other.id);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface RouteInput {
  assetClass: string;
  venue: string | null;
  dataType: DataType;
  primaryFeedId: string;
  fallbackFeedId: string | null;
}

function checkFeedFits(
  feed: { name: string; provider: string; assetClasses: string[] },
  route: { assetClass: string; venue: string | null },
) {
  if (!feed.assetClasses.includes(route.assetClass)) {
    throw new IntegrationError('bad_request', `${feed.name} does not cover ${route.assetClass}`);
  }
  if (!providerCoversVenue(feed.provider, route.venue)) {
    throw new IntegrationError(
      'bad_request',
      route.venue === 'DEMO' || feed.provider === 'demo'
        ? 'Demo instruments can only use a demo feed, and a demo feed only covers them'
        : `${feed.name} cannot serve that venue`,
    );
  }
}

async function checkRouteInput(tx: Transaction, input: RouteInput) {
  if (input.fallbackFeedId && input.fallbackFeedId === input.primaryFeedId) {
    throw new IntegrationError('bad_request', 'Choose a different feed as the fallback');
  }
  const ids = [input.primaryFeedId, ...(input.fallbackFeedId ? [input.fallbackFeedId] : [])];
  const feeds = await tx
    .select()
    .from(dataFeedConnections)
    .where(inArray(dataFeedConnections.id, ids));
  for (const id of ids) {
    const feed = feeds.find((f) => f.id === id);
    if (!feed) throw new IntegrationError('bad_request', 'That feed no longer exists');
    checkFeedFits(feed, input);
  }
}

export async function createRoute(
  tx: Transaction,
  input: RouteInput & { userId: string },
): Promise<RouteSummary> {
  await checkRouteInput(tx, input);
  const [existing] = await tx
    .select({ id: dataRoutes.id })
    .from(dataRoutes)
    .where(
      and(
        eq(dataRoutes.assetClass, input.assetClass as RouteRow['assetClass']),
        input.venue === null ? isNull(dataRoutes.venue) : eq(dataRoutes.venue, input.venue),
        eq(dataRoutes.dataType, input.dataType),
      ),
    );
  if (existing) {
    throw new IntegrationError(
      'conflict',
      'A route for that asset class, venue and data already exists',
    );
  }
  const [row] = await tx
    .insert(dataRoutes)
    .values({
      userId: input.userId,
      assetClass: input.assetClass as RouteRow['assetClass'],
      venue: input.venue,
      dataType: input.dataType,
      primaryFeedId: input.primaryFeedId,
      fallbackFeedId: input.fallbackFeedId,
    })
    .returning({ id: dataRoutes.id });
  if (!row) throw new Error('route insert failed');
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'data_route.created',
    resourceType: 'data_route',
    resourceId: row.id,
    context: { primaryFeedId: input.primaryFeedId, fallbackFeedId: input.fallbackFeedId },
  });
  return getRoute(tx, row.id);
}

type RouteRow = typeof dataRoutes.$inferSelect;

export async function getRoute(tx: Transaction, id: string): Promise<RouteSummary> {
  const route = (await listRoutes(tx)).find((r) => r.id === id);
  if (!route) throw new IntegrationError('not_found', 'Route not found');
  return route;
}

/** Changes a route's feeds; a new primary is audited (§9.4) and takes over at once. */
export async function updateRoute(
  tx: Transaction,
  input: {
    userId: string;
    id: string;
    rowVersion: number;
    primaryFeedId: string;
    fallbackFeedId: string | null;
  },
): Promise<RouteSummary> {
  const [route] = await tx.select().from(dataRoutes).where(eq(dataRoutes.id, input.id));
  if (!route) throw new IntegrationError('not_found', 'Route not found');
  if (route.rowVersion !== input.rowVersion) {
    throw new IntegrationError(
      'conflict',
      'This route changed since you opened it. Reload and try again.',
    );
  }
  await checkRouteInput(tx, {
    assetClass: route.assetClass,
    venue: route.venue,
    dataType: route.dataType,
    primaryFeedId: input.primaryFeedId,
    fallbackFeedId: input.fallbackFeedId,
  });
  const primaryChanged = route.primaryFeedId !== input.primaryFeedId;
  const fallbackChanged = route.fallbackFeedId !== input.fallbackFeedId;
  await tx
    .update(dataRoutes)
    .set({
      primaryFeedId: input.primaryFeedId,
      fallbackFeedId: input.fallbackFeedId,
      // A changed route starts over on its (new) primary.
      ...(primaryChanged || fallbackChanged
        ? { activeSource: 'primary' as const, primaryOkSince: null }
        : {}),
      rowVersion: route.rowVersion + 1,
    })
    .where(eq(dataRoutes.id, input.id));
  if (primaryChanged) {
    await auditPrimaryChange(tx, input.userId, route.id, route.primaryFeedId, input.primaryFeedId);
  }
  if (fallbackChanged) {
    await recordAudit(tx, {
      userId: input.userId,
      actorType: 'user',
      action: 'data_route.fallback_changed',
      resourceType: 'data_route',
      resourceId: route.id,
      context: { from: route.fallbackFeedId, to: input.fallbackFeedId },
    });
  }
  return getRoute(tx, input.id);
}

async function auditPrimaryChange(
  tx: Transaction,
  userId: string,
  routeId: string,
  from: string,
  to: string,
) {
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'data_route.primary_changed',
    resourceType: 'data_route',
    resourceId: routeId,
    context: { from, to },
  });
}

export async function deleteRoute(
  tx: Transaction,
  input: { userId: string; id: string },
): Promise<void> {
  const users = await tx
    .select({ name: strategies.name })
    .from(strategies)
    .where(and(eq(strategies.dataRouteId, input.id), isNull(strategies.deletedAt)));
  if (users.length > 0) {
    throw new IntegrationError(
      'invalid_state',
      `${users.map((u) => u.name).join(', ')} ${users.length === 1 ? 'is' : 'are'} set to use this route`,
    );
  }
  const rows = await tx
    .delete(dataRoutes)
    .where(eq(dataRoutes.id, input.id))
    .returning({ id: dataRoutes.id });
  if (rows.length === 0) throw new IntegrationError('not_found', 'Route not found');
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'data_route.deleted',
    resourceType: 'data_route',
    resourceId: input.id,
  });
}

// ---------------------------------------------------------------------------
// Worker: feed checks
// ---------------------------------------------------------------------------

export async function claimFeedChecks(
  db: Database,
  options: { leaseSeconds: number; everySeconds: number; limit: number },
): Promise<{ feedId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_feed_checks(${options.leaseSeconds}, ${options.everySeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ feedId: r.claimed_id, userId: r.claimed_user }));
}

export interface FeedToCheck {
  id: string;
  name: string;
  provider: string;
  credentialRef: string | null;
  isActive: boolean;
  health: Health;
}

export async function loadFeedToCheck(
  tx: Transaction,
  id: string,
): Promise<FeedToCheck | undefined> {
  const [row] = await tx
    .select({
      id: dataFeedConnections.id,
      name: dataFeedConnections.name,
      provider: dataFeedConnections.provider,
      credentialRef: dataFeedConnections.credentialRef,
      isActive: dataFeedConnections.isActive,
      health: dataFeedConnections.health,
    })
    .from(dataFeedConnections)
    .where(eq(dataFeedConnections.id, id));
  return row;
}

export interface FeedCheckResult {
  ok: boolean;
  entitlement: Entitlement;
  realtime?: boolean | undefined;
  /** Secret-free, short; shown to the person. */
  error?: string | undefined;
}

/** Stores a check's outcome; an active feed that goes down is announced once. */
export async function recordFeedCheck(
  tx: Transaction,
  input: { userId: string; feed: FeedToCheck; result: FeedCheckResult; now: Date },
): Promise<void> {
  const { feed, result, now } = input;
  const health: Health = result.ok ? 'healthy' : 'down';
  await tx
    .update(dataFeedConnections)
    .set({
      health,
      entitlement: result.entitlement,
      lastCheckedAt: now,
      lastError: result.ok ? null : (result.error ?? 'The check failed').slice(0, 300),
      checkRequestedAt: null,
      checkLeaseExpiresAt: null,
      ...(result.ok ? { lastSuccessAt: now } : {}),
      ...(result.realtime === undefined ? {} : { isRealtime: result.realtime }),
    })
    .where(eq(dataFeedConnections.id, feed.id));
  if (feed.health === health) return;
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'system',
    action: 'data_feed.health_changed',
    resourceType: 'data_feed_connection',
    resourceId: feed.id,
    context: { from: feed.health, to: health },
  });
  if (feed.isActive && health === 'down' && feed.health !== 'unknown') {
    await notify(tx, {
      userId: input.userId,
      kind: 'disconnect',
      title: `${feed.name} is not responding`,
      body: result.error ?? 'Its last check failed.',
      link: '/settings/data-feeds',
      resourceType: 'data_feed_connection',
      resourceId: feed.id,
      dedupeKey: `feed-down:${feed.id}:${now.toISOString().slice(0, 13)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Runtime: routing and failover
// ---------------------------------------------------------------------------

export interface RoutingFeed {
  id: string;
  name: string;
  provider: string;
  credentialRef: string | null;
  isActive: boolean;
}

export interface Routing {
  routes: RouteLike[];
  feeds: Map<string, RoutingFeed>;
}

export async function loadRouting(tx: Transaction): Promise<Routing> {
  const [routes, feeds] = await Promise.all([
    loadRoutes(tx),
    tx
      .select({
        id: dataFeedConnections.id,
        name: dataFeedConnections.name,
        provider: dataFeedConnections.provider,
        credentialRef: dataFeedConnections.credentialRef,
        isActive: dataFeedConnections.isActive,
      })
      .from(dataFeedConnections),
  ]);
  return { routes, feeds: new Map(feeds.map((f) => [f.id, f])) };
}

/**
 * Applies one failover step to a route. Conditional on the route's current
 * source, so when several passes see the same outage only one switches it
 * and announces it.
 */
export async function applyFailoverStep(
  tx: Transaction,
  input: {
    userId: string;
    route: RouteLike;
    step: FailoverStep;
    now: Date;
    feeds: Routing['feeds'];
  },
): Promise<boolean> {
  const { route, step, now } = input;
  const name = (id: string | null) => (id ? (input.feeds.get(id)?.name ?? 'a feed') : 'a feed');
  const where = (source: 'primary' | 'fallback') =>
    and(eq(dataRoutes.id, route.id), eq(dataRoutes.activeSource, source));
  switch (step.kind) {
    case 'stay':
      return false;
    case 'primary_recovering': {
      await tx
        .update(dataRoutes)
        .set({ primaryOkSince: new Date(step.since) })
        .where(and(where('fallback'), isNull(dataRoutes.primaryOkSince)));
      return false;
    }
    case 'primary_relapsed': {
      await tx.update(dataRoutes).set({ primaryOkSince: null }).where(where('fallback'));
      return false;
    }
    case 'fail_over':
    case 'switch_back': {
      const to = step.kind === 'fail_over' ? 'fallback' : 'primary';
      const rows = await tx
        .update(dataRoutes)
        .set({ activeSource: to, switchedAt: now, primaryOkSince: null })
        .where(where(to === 'fallback' ? 'primary' : 'fallback'))
        .returning({ id: dataRoutes.id });
      if (rows.length === 0) return false;
      const from = to === 'fallback' ? route.primaryFeedId : route.fallbackFeedId;
      const toFeed = to === 'fallback' ? route.fallbackFeedId : route.primaryFeedId;
      await recordAudit(tx, {
        userId: input.userId,
        actorType: 'system',
        action: to === 'fallback' ? 'data_route.failed_over' : 'data_route.switched_back',
        resourceType: 'data_route',
        resourceId: route.id,
        context: { from, to: toFeed, assetClass: route.assetClass, venue: route.venue },
      });
      await notify(tx, {
        userId: input.userId,
        kind: 'disconnect',
        title:
          to === 'fallback'
            ? `Prices switched to ${name(toFeed)}`
            : `Prices are back on ${name(toFeed)}`,
        body:
          to === 'fallback'
            ? `${name(from)} stopped sending current ${route.assetClass} prices, so the backup feed took over.`
            : `${name(toFeed)} has been healthy for ${FAILOVER.recoverAfterMs / 60_000} minutes.`,
        link: '/settings/data-feeds',
        resourceType: 'data_route',
        resourceId: route.id,
        dedupeKey: `route:${route.id}:${to}:${now.toISOString()}`,
      });
      return true;
    }
  }
}

/** For tests and screens: feeds an active route currently draws on. */
export function servingFeedId(route: RouteLike): string {
  return route.activeSource === 'fallback' && route.fallbackFeedId
    ? route.fallbackFeedId
    : route.primaryFeedId;
}

const routingInfoCache = new Map<string, { assetClass: string; venue: string }>();

/** An instrument's asset class and venue; instruments are shared and never change these. */
export async function instrumentRoutingInfo(
  tx: Transaction,
  instrumentId: string,
): Promise<{ assetClass: string; venue: string } | undefined> {
  const cached = routingInfoCache.get(instrumentId);
  if (cached) return cached;
  const [row] = await tx
    .select({ assetClass: instruments.assetClass, venue: instruments.venue })
    .from(instruments)
    .where(eq(instruments.id, instrumentId));
  if (row) routingInfoCache.set(instrumentId, row);
  return row;
}
