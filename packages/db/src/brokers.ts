import { isProviderId, PROVIDERS, type AccountCapabilities } from '@tm/domain';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import { assertFeature, assertWithinLimit, hasRoomFor } from './entitlements';
import { definitionAccounts, type Leg } from './strategy-accounts';
import { IntegrationError } from './feeds';
import { notify } from './notifications';
import {
  brokerConnections,
  credentials,
  instruments,
  strategies,
  strategyRuntimes,
  tradingAccounts,
} from './schema';
import { updateStrategy } from './strategies';

/**
 * Trading platforms and accounts (§9.3, §9.4, §14.4; ADR 0018). A platform is
 * one connection to a broker, signed in with a stored paper key; the worker
 * checks it and discovers its accounts. Accounts can be renamed, made the
 * default, or have routing turned off; turning off anything a running
 * strategy uses asks first and pauses it.
 */

type Health = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface AccountDependent {
  runtimeId: string;
  strategyId: string;
  strategyName: string;
  status: 'running' | 'paused';
  accountIds: string[];
}

export interface AccountSummary {
  id: string;
  platformId: string;
  nickname: string;
  maskedExternalId: string;
  mode: 'paper';
  currency: string;
  capabilities: AccountCapabilities;
  isDefault: boolean;
  isActive: boolean;
  lastSyncedAt: string | null;
  usedBy: { strategyId: string; strategyName: string; status: 'running' | 'paused' }[];
  rowVersion: number;
}

export interface PlatformSummary {
  id: string;
  name: string;
  provider: string;
  environment: 'paper';
  credential: { id: string; label: string } | null;
  isActive: boolean;
  health: Health;
  lastCheckedAt: string | null;
  lastError: string | null;
  checking: boolean;
  accounts: AccountSummary[];
  rowVersion: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Running or paused strategies whose orders go to any of `accountIds`. */
export async function accountDependents(
  tx: Transaction,
  accountIds: readonly string[],
): Promise<AccountDependent[]> {
  if (accountIds.length === 0) return [];
  const rows = await tx
    .select({
      runtimeId: strategyRuntimes.id,
      strategyId: strategies.id,
      strategyName: strategies.name,
      status: strategyRuntimes.status,
      definition: strategies.draftDefinition,
    })
    .from(strategyRuntimes)
    .innerJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .where(inArray(strategyRuntimes.status, ['running', 'paused']));
  const wanted = new Set(accountIds);
  return rows.flatMap((r) => {
    const used = definitionAccounts(r.definition).filter((a) => wanted.has(a));
    if (used.length === 0) return [];
    return [
      {
        runtimeId: r.runtimeId,
        strategyId: r.strategyId,
        strategyName: r.strategyName,
        status: r.status as 'running' | 'paused',
        accountIds: used,
      },
    ];
  });
}

export async function listPlatforms(tx: Transaction): Promise<PlatformSummary[]> {
  const rows = await tx
    .select({
      p: brokerConnections,
      credentialLabel: credentials.label,
    })
    .from(brokerConnections)
    .leftJoin(credentials, eq(credentials.id, brokerConnections.credentialRef))
    .orderBy(asc(brokerConnections.createdAt));
  const accounts = await tx.select().from(tradingAccounts).orderBy(asc(tradingAccounts.createdAt));
  const dependents = await accountDependents(
    tx,
    accounts.map((a) => a.id),
  );
  return rows.map(({ p, credentialLabel }) => ({
    id: p.id,
    name: p.name,
    provider: p.provider,
    environment: 'paper',
    credential: p.credentialRef ? { id: p.credentialRef, label: credentialLabel ?? '' } : null,
    isActive: p.isActive,
    health: p.health,
    lastCheckedAt: iso(p.lastCheckedAt),
    lastError: p.lastError,
    checking: p.checkRequestedAt !== null,
    rowVersion: p.rowVersion,
    accounts: accounts
      .filter((a) => a.brokerConnectionId === p.id)
      .map((a) => ({
        id: a.id,
        platformId: p.id,
        nickname: a.nickname,
        maskedExternalId: a.maskedExternalId,
        mode: 'paper',
        currency: a.currency,
        capabilities: a.capabilities as AccountCapabilities,
        isDefault: a.isDefault,
        isActive: a.isActive,
        lastSyncedAt: iso(a.lastSyncedAt),
        usedBy: dependents
          .filter((d) => d.accountIds.includes(a.id))
          .map((d) => ({
            strategyId: d.strategyId,
            strategyName: d.strategyName,
            status: d.status,
          })),
        rowVersion: a.rowVersion,
      })),
  }));
}

export async function getPlatform(tx: Transaction, id: string): Promise<PlatformSummary> {
  const found = (await listPlatforms(tx)).find((p) => p.id === id);
  if (!found) throw new IntegrationError('not_found', 'Trading platform not found');
  return found;
}

export async function getAccount(tx: Transaction, id: string): Promise<AccountSummary> {
  for (const p of await listPlatforms(tx)) {
    const a = p.accounts.find((x) => x.id === id);
    if (a) return a;
  }
  throw new IntegrationError('not_found', 'Trading account not found');
}

async function checkPlatformInput(
  tx: Transaction,
  input: { provider: string; credentialId: string | null | undefined },
) {
  if (!isProviderId(input.provider)) {
    throw new IntegrationError('bad_request', 'Choose a supported platform');
  }
  const info = PROVIDERS[input.provider];
  if (
    !(info.offers as readonly string[]).includes('broker') ||
    info.credentialFields.length === 0
  ) {
    throw new IntegrationError('bad_request', `${info.name} cannot be added as a trading platform`);
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

export async function createPlatform(
  tx: Transaction,
  input: {
    userId: string;
    name: string;
    provider: string;
    credentialId: string | null | undefined;
  },
): Promise<PlatformSummary> {
  const credentialRef = await checkPlatformInput(tx, input);
  await assertFeature(tx, 'paperIntegrations');
  const [row] = await tx
    .insert(brokerConnections)
    .values({
      userId: input.userId,
      name: input.name.trim().slice(0, 100),
      provider: input.provider,
      credentialRef,
      // Connected straight away: the worker checks it and discovers its accounts.
      checkRequestedAt: new Date(),
    })
    .returning({ id: brokerConnections.id });
  if (!row) throw new Error('platform insert failed');
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'broker_connection.created',
    resourceType: 'broker_connection',
    resourceId: row.id,
    context: { provider: input.provider },
  });
  return getPlatform(tx, row.id);
}

export async function updatePlatform(
  tx: Transaction,
  input: {
    userId: string;
    id: string;
    rowVersion: number;
    name?: string | undefined;
    credentialId?: string | undefined;
  },
): Promise<PlatformSummary> {
  const current = await getPlatform(tx, input.id);
  if (current.rowVersion !== input.rowVersion) {
    throw new IntegrationError(
      'conflict',
      'This platform changed since you opened it. Reload and try again.',
    );
  }
  const credentialRef =
    input.credentialId === undefined
      ? (current.credential?.id ?? null)
      : await checkPlatformInput(tx, {
          provider: current.provider,
          credentialId: input.credentialId,
        });
  const credentialChanged = credentialRef !== (current.credential?.id ?? null);
  await tx
    .update(brokerConnections)
    .set({
      name: (input.name ?? current.name).trim().slice(0, 100),
      credentialRef,
      ...(credentialChanged ? { checkRequestedAt: new Date() } : {}),
      rowVersion: current.rowVersion + 1,
    })
    .where(eq(brokerConnections.id, input.id));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'broker_connection.updated',
    resourceType: 'broker_connection',
    resourceId: input.id,
    context: { credentialChanged },
  });
  return getPlatform(tx, input.id);
}

/** Connect, reconnect or test: the worker checks the platform and rediscovers its accounts. */
export async function requestPlatformCheck(tx: Transaction, id: string): Promise<PlatformSummary> {
  const current = await getPlatform(tx, id);
  if (current.provider === 'demo') return current;
  await tx
    .update(brokerConnections)
    .set({ checkRequestedAt: new Date() })
    .where(eq(brokerConnections.id, id));
  return getPlatform(tx, id);
}

async function pauseFor(
  tx: Transaction,
  userId: string,
  dependents: AccountDependent[],
  reason: string,
  context: Record<string, unknown>,
) {
  for (const d of dependents.filter((x) => x.status === 'running')) {
    await tx
      .update(strategyRuntimes)
      .set({ status: 'paused', pauseReason: reason })
      .where(and(eq(strategyRuntimes.id, d.runtimeId), eq(strategyRuntimes.status, 'running')));
    await recordAudit(tx, {
      userId,
      actorType: 'user',
      action: 'runtime.paused',
      resourceType: 'strategy_runtime',
      resourceId: d.runtimeId,
      context,
    });
  }
}

function inUseError(dependents: AccountDependent[], what: string) {
  const names = dependents.map((d) => d.strategyName).join(', ');
  return new IntegrationError(
    'invalid_state',
    `${names} ${dependents.length === 1 ? 'trades' : 'trade'} through ${what}. Confirm to pause ${dependents.length === 1 ? 'it' : 'them'} and turn it off.`,
    { dependents },
  );
}

export async function setPlatformActive(
  tx: Transaction,
  input: { userId: string; id: string; active: boolean; pauseStrategies?: boolean | undefined },
): Promise<PlatformSummary> {
  const platform = await getPlatform(tx, input.id);
  if (input.active === platform.isActive) return platform;
  if (!input.active) {
    const dependents = await accountDependents(
      tx,
      platform.accounts.filter((a) => a.isActive).map((a) => a.id),
    );
    if (dependents.length > 0 && !input.pauseStrategies)
      throw inUseError(dependents, platform.name);
    await pauseFor(
      tx,
      input.userId,
      dependents,
      `Its trading platform ${platform.name} was turned off.`,
      {
        reason: 'broker_connection_deactivated',
        brokerConnectionId: platform.id,
      },
    );
  }
  await tx
    .update(brokerConnections)
    .set({
      isActive: input.active,
      ...(input.active && platform.provider !== 'demo' ? { checkRequestedAt: new Date() } : {}),
      rowVersion: platform.rowVersion + 1,
    })
    .where(eq(brokerConnections.id, input.id));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: input.active ? 'broker_connection.activated' : 'broker_connection.deactivated',
    resourceType: 'broker_connection',
    resourceId: input.id,
  });
  return getPlatform(tx, input.id);
}

export async function deletePlatform(
  tx: Transaction,
  input: { userId: string; id: string },
): Promise<void> {
  const platform = await getPlatform(tx, input.id);
  if (platform.provider === 'demo') {
    throw new IntegrationError('conflict', 'The demo platform stays; you can turn it off instead.');
  }
  const ids = platform.accounts.map((a) => a.id);
  const referenced =
    ids.length > 0 &&
    (await tx
      .select({
        id: strategies.id,
        definition: strategies.draftDefinition,
        defaultAccountId: strategies.defaultAccountId,
      })
      .from(strategies)
      .then((rows) =>
        rows.some(
          (r) =>
            (r.defaultAccountId && ids.includes(r.defaultAccountId)) ||
            definitionAccounts(r.definition).some((a) => ids.includes(a)),
        ),
      ));
  if (referenced || platform.accounts.some((a) => a.isDefault)) {
    throw new IntegrationError(
      'conflict',
      'Strategies use its accounts. Move them to another account, or turn the platform off instead.',
    );
  }
  try {
    await tx.transaction(async (sp) => {
      await sp.delete(brokerConnections).where(eq(brokerConnections.id, input.id));
    });
  } catch (error) {
    const code =
      (error as { code?: string; cause?: { code?: string } }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (code === '23503') {
      throw new IntegrationError(
        'conflict',
        'Its accounts have order history, which is kept. Turn the platform off instead.',
      );
    }
    throw error;
  }
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'broker_connection.deleted',
    resourceType: 'broker_connection',
    resourceId: input.id,
  });
}

export interface AccountUpdate {
  userId: string;
  id: string;
  rowVersion: number;
  nickname?: string | undefined;
  /** Make this the default account for new strategies. */
  makeDefault?: boolean | undefined;
  /** With makeDefault: also move strategies from the old default (§9.4). */
  migrateStrategies?: boolean | undefined;
  active?: boolean | undefined;
  /** With active false: pause the strategies that trade through it. */
  pauseStrategies?: boolean | undefined;
}

export interface AccountUpdateResult {
  account: AccountSummary;
  /** Strategies moved to the new default, and those left because they are running. */
  migrated: number;
  skipped: number;
}

export async function updateAccount(
  tx: Transaction,
  input: AccountUpdate,
): Promise<AccountUpdateResult> {
  const account = await getAccount(tx, input.id);
  if (account.rowVersion !== input.rowVersion) {
    throw new IntegrationError(
      'conflict',
      'This account changed since you opened it. Reload and try again.',
    );
  }
  const platform = await getPlatform(tx, account.platformId);
  let migrated = 0;
  let skipped = 0;

  if (input.active === false && account.isActive) {
    const dependents = await accountDependents(tx, [account.id]);
    if (dependents.length > 0 && !input.pauseStrategies)
      throw inUseError(dependents, account.nickname);
    await pauseFor(
      tx,
      input.userId,
      dependents,
      `Its trading account ${account.nickname} was turned off.`,
      {
        reason: 'trading_account_deactivated',
        accountId: account.id,
      },
    );
  }
  if (input.active === true && !platform.isActive) {
    throw new IntegrationError('invalid_state', `Turn on ${platform.name} first`);
  }
  if (input.active === true && !account.isActive) {
    await assertWithinLimit(tx, input.userId, 'connectedAccounts');
  }
  if (input.makeDefault && !account.isDefault) {
    if (!(input.active ?? account.isActive) || !platform.isActive) {
      throw new IntegrationError('invalid_state', 'Only an active account can be the default');
    }
    const [previous] = await tx
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.isDefault, true));
    if (previous) {
      await tx
        .update(tradingAccounts)
        .set({ isDefault: false, rowVersion: sql`${tradingAccounts.rowVersion} + 1` })
        .where(eq(tradingAccounts.id, previous.id));
    }
    if (previous && input.migrateStrategies) {
      ({ migrated, skipped } = await migrateStrategies(tx, input.userId, previous.id, account.id));
    }
    await recordAudit(tx, {
      userId: input.userId,
      actorType: 'user',
      action: 'trading_account.default_changed',
      resourceType: 'trading_account',
      resourceId: account.id,
      context: { from: previous?.id ?? null, migrated, skipped },
    });
  }
  await tx
    .update(tradingAccounts)
    .set({
      nickname: (input.nickname ?? account.nickname).trim().slice(0, 100) || account.nickname,
      isActive: input.active ?? account.isActive,
      ...(input.makeDefault ? { isDefault: true } : {}),
      rowVersion: account.rowVersion + 1,
    })
    .where(eq(tradingAccounts.id, account.id));
  if (input.active !== undefined && input.active !== account.isActive) {
    await recordAudit(tx, {
      userId: input.userId,
      actorType: 'user',
      action: input.active ? 'trading_account.activated' : 'trading_account.deactivated',
      resourceType: 'trading_account',
      resourceId: account.id,
    });
  }
  return { account: await getAccount(tx, account.id), migrated, skipped };
}

/** Moves strategies that are not running from one account to another. */
async function migrateStrategies(tx: Transaction, userId: string, from: string, to: string) {
  const rows = await tx
    .select({
      id: strategies.id,
      status: strategies.status,
      rowVersion: strategies.rowVersion,
      definition: strategies.draftDefinition,
      defaultAccountId: strategies.defaultAccountId,
    })
    .from(strategies);
  let migrated = 0;
  let skipped = 0;
  for (const r of rows) {
    const uses = r.defaultAccountId === from || definitionAccounts(r.definition).includes(from);
    if (!uses) continue;
    if (r.status === 'actively_executing') {
      skipped += 1;
      continue;
    }
    const def = structuredClone(r.definition) as {
      entry: { orders: Leg[] };
      exit: { orders: Leg[] };
      groups?: { entry: { orders: Leg[] }; exit: { orders: Leg[] } }[];
    };
    // The strategy's own legs and its entry groups' (v1.2 item 8).
    for (const p of [def, ...(def.groups ?? [])])
      for (const leg of [...p.entry.orders, ...p.exit.orders]) {
        if (leg.accountId === from) leg.accountId = to;
      }
    await updateStrategy(tx, userId, r.id, {
      rowVersion: r.rowVersion,
      definition: def as never,
    });
    await tx
      .update(strategies)
      .set({ defaultAccountId: to })
      .where(and(eq(strategies.id, r.id), eq(strategies.defaultAccountId, from)));
    migrated += 1;
  }
  return { migrated, skipped };
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

export async function claimBrokerChecks(
  db: Database,
  options: { leaseSeconds: number; everySeconds: number; limit: number },
): Promise<{ platformId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_broker_checks(${options.leaseSeconds}, ${options.everySeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ platformId: r.claimed_id, userId: r.claimed_user }));
}

export interface PlatformToCheck {
  id: string;
  name: string;
  provider: string;
  credentialRef: string | null;
  isActive: boolean;
  health: Health;
}

export async function loadPlatformToCheck(
  tx: Transaction,
  id: string,
): Promise<PlatformToCheck | undefined> {
  const [row] = await tx
    .select({
      id: brokerConnections.id,
      name: brokerConnections.name,
      provider: brokerConnections.provider,
      credentialRef: brokerConnections.credentialRef,
      isActive: brokerConnections.isActive,
      health: brokerConnections.health,
    })
    .from(brokerConnections)
    .where(eq(brokerConnections.id, id));
  return row;
}

export interface DiscoveredAccountInput {
  externalId: string;
  displayId: string;
  currency: string;
  nickname: string;
  capabilities: AccountCapabilities;
}

export async function recordPlatformCheck(
  tx: Transaction,
  input: {
    userId: string;
    platform: PlatformToCheck;
    now: Date;
    ok: boolean;
    error?: string | undefined;
    accounts?: DiscoveredAccountInput[] | undefined;
  },
): Promise<void> {
  const { platform, now } = input;
  const health: Health = input.ok ? 'healthy' : 'down';
  await tx
    .update(brokerConnections)
    .set({
      health,
      lastCheckedAt: now,
      lastError: input.ok ? null : (input.error ?? 'The check failed').slice(0, 300),
      checkRequestedAt: null,
      checkLeaseExpiresAt: null,
    })
    .where(eq(brokerConnections.id, platform.id));

  for (const found of input.accounts ?? []) {
    const [existing] = await tx
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.brokerConnectionId, platform.id),
          eq(tradingAccounts.externalId, found.externalId),
        ),
      );
    if (existing) {
      await tx
        .update(tradingAccounts)
        .set({
          maskedExternalId: found.displayId,
          currency: found.currency,
          capabilities: found.capabilities,
          lastSyncedAt: now,
        })
        .where(eq(tradingAccounts.id, existing.id));
      continue;
    }
    const [created] = await tx
      .insert(tradingAccounts)
      .values({
        userId: input.userId,
        brokerConnectionId: platform.id,
        nickname: found.nickname.slice(0, 100),
        externalId: found.externalId,
        maskedExternalId: found.displayId,
        currency: found.currency,
        capabilities: found.capabilities,
        lastSyncedAt: now,
        // Past the plan's limit an account is listed but left off (ADR 0022).
        isActive: await hasRoomFor(tx, 'connectedAccounts'),
      })
      .returning({ id: tradingAccounts.id, isActive: tradingAccounts.isActive });
    await recordAudit(tx, {
      userId: input.userId,
      actorType: 'system',
      action: 'trading_account.discovered',
      resourceType: 'trading_account',
      resourceId: created?.id ?? platform.id,
      context: {
        brokerConnectionId: platform.id,
        ...(created?.isActive === false ? { leftOff: 'plan_limit' } : {}),
      },
    });
  }

  if (platform.health === health) return;
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'system',
    action: 'broker_connection.health_changed',
    resourceType: 'broker_connection',
    resourceId: platform.id,
    context: { from: platform.health, to: health },
  });
  if (platform.isActive && health === 'down' && platform.health !== 'unknown') {
    await notify(tx, {
      userId: input.userId,
      kind: 'disconnect',
      title: `${platform.name} is not responding`,
      body: input.error ?? 'Its last check failed.',
      link: '/settings/accounts',
      resourceType: 'broker_connection',
      resourceId: platform.id,
      dedupeKey: `broker-down:${platform.id}:${now.toISOString().slice(0, 13)}`,
    });
  }
}

export interface AccountRouting {
  accountId: string;
  nickname: string;
  provider: string;
  platformActive: boolean;
  credentialRef: string | null;
  externalId: string | null;
  capabilities: AccountCapabilities;
}

/** How to reach each account's broker, for the runtime (ADR 0018). */
export async function loadAccountRouting(
  tx: Transaction,
  accountIds: readonly string[],
): Promise<Map<string, AccountRouting>> {
  if (accountIds.length === 0) return new Map();
  const rows = await tx
    .select({
      accountId: tradingAccounts.id,
      nickname: tradingAccounts.nickname,
      provider: brokerConnections.provider,
      platformActive: brokerConnections.isActive,
      credentialRef: brokerConnections.credentialRef,
      externalId: tradingAccounts.externalId,
      capabilities: tradingAccounts.capabilities,
    })
    .from(tradingAccounts)
    .innerJoin(brokerConnections, eq(brokerConnections.id, tradingAccounts.brokerConnectionId))
    .where(inArray(tradingAccounts.id, [...accountIds]));
  return new Map(
    rows.map((r) => [r.accountId, { ...r, capabilities: r.capabilities as AccountCapabilities }]),
  );
}

/** The app's instrument for a broker symbol, for positions: real listings only. */
export async function instrumentIdForSymbol(
  tx: Transaction,
  symbol: string,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: instruments.id })
    .from(instruments)
    .where(and(eq(instruments.symbol, symbol), ne(instruments.venue, 'DEMO')))
    .orderBy(asc(instruments.createdAt))
    .limit(1);
  return row?.id;
}
