import { createHash } from 'node:crypto';
import {
  canonicalJson,
  collectInstrumentUses,
  createDefinition,
  paperRunBlocker,
  parseDefinition,
  planTransition,
  STATUS_LABELS,
  STRATEGY_SCHEMA_VERSION,
  validateStrategy,
  type AccountCapabilities,
  type AccountInfo,
  type InstrumentInfo,
  type StrategyDefinition,
  type StrategyStatus,
  type ValidationContext,
  type ValidationResult,
} from '@tm/domain';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  isNotNull,
  gte,
  lt,
  max,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { activeFundamentalsFeed } from './company-reports';
import {
  applyLibraryChoice,
  libraryNumbers,
  strategyLibraryRecord,
  unlinkDeletedStrategy,
  type LibraryChoice,
  type StrategyLibraryRecord,
} from './library-lab';
import { activeOptionsFeed, addOptionUnderlyings, listOptionUniverse } from './options';
import { demoDataEnabled } from './demo';
import { recordAudit } from './audit';
import { preferredLegAccountId } from './leg-accounts';
import { sharedProvenance, type SharedProvenance } from './share-provenance';
import { assertWithinLimit } from './entitlements';
import { notify } from './notifications';
import { cancelWorkingOrders, closePositions, listPositions } from './order-views';
import { createRuntime, stopRuntime } from './runtime';
import type { Transaction } from './client';
import {
  brokerConnections,
  backtestRuns,
  dataFeedConnections,
  dataRoutes,
  instruments,
  profiles,
  strategies,
  strategyInstruments,
  strategyLibraryEntries,
  strategyStatusChanges,
  strategyVersions,
  tradingAccounts,
} from './schema';

/**
 * Strategy persistence (Design v1.0 §6.1–6.3, §14.1). Every function runs
 * inside withTenant(); row-level security scopes reads and writes to that
 * tenant, and `userId` is the same server-side tenant id, used for inserts.
 *
 * Rules:
 * - The draft is mutable. Versions are immutable snapshots (trigger + grants).
 * - Starting a strategy snapshots the draft as a version unless it equals the
 *   current version, and records the acknowledged warnings.
 * - After a strategy has been active, any change to its rules also publishes a
 *   new version, so history points at the exact rules that ran (§6.2).
 * - Rules can't change while the strategy is actively executing.
 * - Deleting is a soft delete; deleted strategies behave as not found.
 * - Every mutation checks `rowVersion` (optimistic concurrency) and writes an
 *   audit event.
 */

export type StrategyErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'invalid_definition'
  | 'transition_blocked'
  | 'limit_reached';

export class StrategyError extends Error {
  constructor(
    public readonly code: StrategyErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'StrategyError';
  }
}

export function definitionHash(def: StrategyDefinition): string {
  return createHash('sha256').update(canonicalJson(def)).digest('hex');
}

function parseOrThrow(input: unknown): StrategyDefinition {
  try {
    return parseDefinition(input);
  } catch (error) {
    const issues = (error as { issues?: unknown }).issues;
    throw new StrategyError(
      'invalid_definition',
      'The strategy definition is not in a format this version understands',
      issues,
    );
  }
}

// ---------------------------------------------------------------------------
// Reading

export const STRATEGY_SORTS = [
  'updated',
  'created',
  'name',
  'status',
  'number',
  'assets',
  'version',
  'account',
  'backtest',
] as const;
export type StrategySort = (typeof STRATEGY_SORTS)[number];

export interface StrategyListQuery {
  search?: string | undefined;
  statuses?: readonly StrategyStatus[] | undefined;
  instrumentId?: string | undefined;
  updatedFrom?: Date | undefined;
  updatedTo?: Date | undefined;
  archived?: 'exclude' | 'include' | 'only' | undefined;
  /** Only copies received by sharing (ADR 0056). */
  shared?: boolean | undefined;
  sort?: StrategySort | undefined;
  direction?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface StrategySummary {
  id: string;
  name: string;
  /** The Strategy Library number (ADR 0054); null until the first save with instruments. */
  libraryNumber: string | null;
  description: string;
  tags: string[];
  status: StrategyStatus;
  hasBeenActive: boolean;
  currentVersionNo: number | null;
  accountMode: 'paper' | 'live' | null;
  instruments: { id: string; symbol: string }[];
  /** The newest back test of any version, or null when none has run. */
  latestBacktest: StrategyLatestBacktest | null;
  /** A copy received by sharing (ADR 0056): the list shows a Shared badge. */
  shared: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  rowVersion: number;
}

export interface StrategyLatestBacktest {
  runId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  /** Net return in percent, for a completed run. */
  netReturnPct: string | null;
  finishedAt: Date | null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listStrategies(
  tx: Transaction,
  query: StrategyListQuery = {},
): Promise<{ items: StrategySummary[]; total: number }> {
  const where: SQL[] = [isNull(strategies.deletedAt)];
  const archived = query.archived ?? 'exclude';
  if (archived === 'exclude') where.push(isNull(strategies.archivedAt));
  if (archived === 'only') where.push(isNotNull(strategies.archivedAt));
  if (query.search?.trim()) {
    const pattern = `%${escapeLike(query.search.trim())}%`;
    where.push(
      or(
        ilike(strategies.name, pattern),
        ilike(strategies.description, pattern),
        sql`array_to_string(${strategies.tags}, ' ') ilike ${pattern}`,
        // Its Strategy Library number (ADR 0054).
        sql`exists (select 1 from ${strategyLibraryEntries} where ${strategyLibraryEntries.id} = ${strategies.libraryEntryId} and (${strategyLibraryEntries.registrationNumber} ilike ${pattern} or array_to_string(${strategyLibraryEntries.formerNumbers}, ' ') ilike ${pattern}))`,
      ) as SQL,
    );
  }
  if (query.statuses?.length) where.push(inArray(strategies.status, [...query.statuses]));
  if (query.shared) where.push(isNotNull(strategies.receivedShareId));
  if (query.updatedFrom) where.push(gte(strategies.updatedAt, query.updatedFrom));
  if (query.updatedTo) where.push(lt(strategies.updatedAt, query.updatedTo));
  if (query.instrumentId) {
    where.push(
      exists(
        tx
          .select({ one: sql`1` })
          .from(strategyInstruments)
          .where(
            and(
              eq(strategyInstruments.strategyId, strategies.id),
              eq(strategyInstruments.instrumentId, query.instrumentId),
            ),
          ),
      ),
    );
  }

  const dir = query.direction === 'asc' ? 'asc' : 'desc';
  // Every column of the Lab list can sort (N157); empty values always go last.
  const sortColumn = {
    updated: sql`${strategies.updatedAt}`,
    created: sql`${strategies.createdAt}`,
    name: sql`lower(${strategies.name})`,
    status: sql`${strategies.status}`,
    number: sql`(select ${strategyLibraryEntries.registrationNumber} from ${strategyLibraryEntries} where ${strategyLibraryEntries.id} = ${strategies.libraryEntryId})`,
    assets: sql`(select string_agg(distinct ${instruments.symbol}, ',' order by ${instruments.symbol}) from ${strategyInstruments} join ${instruments} on ${instruments.id} = ${strategyInstruments.instrumentId} where ${strategyInstruments.strategyId} = ${strategies.id})`,
    version: sql`${strategyVersions.versionNo}`,
    account: sql`${tradingAccounts.mode}`,
    backtest: sql`(select (${backtestRuns.summary} ->> 'netReturnPct')::numeric from ${backtestRuns} where ${backtestRuns.strategyId} = ${strategies.id} order by ${backtestRuns.createdAt} desc limit 1)`,
  }[query.sort ?? 'updated'];

  const rows = await tx
    .select({
      s: strategies,
      currentVersionNo: strategyVersions.versionNo,
      accountMode: tradingAccounts.mode,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(strategies)
    .leftJoin(strategyVersions, eq(strategyVersions.id, strategies.currentVersionId))
    .leftJoin(tradingAccounts, eq(tradingAccounts.id, strategies.defaultAccountId))
    .where(and(...where))
    .orderBy(
      sql`${sortColumn} ${sql.raw(dir)} nulls last`,
      desc(strategies.updatedAt),
      asc(strategies.id),
    )
    .limit(Math.min(query.limit ?? 50, 200))
    .offset(query.offset ?? 0);

  const ids = rows.map((r) => r.s.id);
  const uses = ids.length
    ? await tx
        .selectDistinct({
          strategyId: strategyInstruments.strategyId,
          id: instruments.id,
          symbol: instruments.symbol,
        })
        .from(strategyInstruments)
        .innerJoin(instruments, eq(instruments.id, strategyInstruments.instrumentId))
        .where(inArray(strategyInstruments.strategyId, ids))
        .orderBy(instruments.symbol)
    : [];

  const latestRuns = ids.length
    ? await tx
        .selectDistinctOn([backtestRuns.strategyId], {
          strategyId: backtestRuns.strategyId,
          runId: backtestRuns.id,
          status: backtestRuns.status,
          netReturnPct: sql<string | null>`${backtestRuns.summary} ->> 'netReturnPct'`,
          finishedAt: backtestRuns.finishedAt,
        })
        .from(backtestRuns)
        .where(inArray(backtestRuns.strategyId, ids))
        .orderBy(backtestRuns.strategyId, desc(backtestRuns.createdAt))
    : [];
  const latestByStrategy = new Map(latestRuns.map(({ strategyId, ...run }) => [strategyId, run]));
  const numbers = await libraryNumbers(
    tx,
    rows.flatMap((r) => (r.s.libraryEntryId ? [r.s.libraryEntryId] : [])),
  );

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ s, currentVersionNo, accountMode }) => ({
      id: s.id,
      name: s.name,
      libraryNumber: s.libraryEntryId ? (numbers.get(s.libraryEntryId) ?? null) : null,
      description: s.description,
      tags: s.tags,
      status: s.status,
      hasBeenActive: s.hasBeenActive,
      currentVersionNo,
      accountMode,
      instruments: uses
        .filter((u) => u.strategyId === s.id)
        .map((u) => ({ id: u.id, symbol: u.symbol })),
      latestBacktest: latestByStrategy.get(s.id) ?? null,
      shared: s.receivedShareId !== null,
      archivedAt: s.archivedAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      rowVersion: s.rowVersion,
    })),
  };
}

export interface StrategyVersionSummary {
  id: string;
  versionNo: number;
  definitionHash: string;
  createdAt: Date;
}

export interface StrategyDetail {
  id: string;
  name: string;
  /** Its Strategy Library record (ADR 0054); null until the first save with instruments. */
  library: StrategyLibraryRecord | null;
  /** Who shared this copy (ADR 0056); null for a strategy made here. */
  sharedBy: SharedProvenance | null;
  description: string;
  tags: string[];
  status: StrategyStatus;
  hasBeenActive: boolean;
  definition: StrategyDefinition;
  definitionHash: string;
  currentVersion: StrategyVersionSummary | null;
  /** True when the draft differs from the current version. */
  hasUnpublishedChanges: boolean;
  versions: StrategyVersionSummary[];
  statusHistory: {
    fromStatus: StrategyStatus;
    toStatus: StrategyStatus;
    versionNo: number | null;
    reason: string | null;
    acknowledgedWarnings: string[];
    changedAt: Date;
  }[];
  baseCurrency: string;
  timezone: string;
  defaultAccountId: string | null;
  dataRouteId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  rowVersion: number;
}

export async function loadStrategyRow(tx: Transaction, id: string) {
  const [row] = await tx
    .select()
    .from(strategies)
    .where(and(eq(strategies.id, id), isNull(strategies.deletedAt)));
  if (!row) throw new StrategyError('not_found', 'Strategy not found');
  return row;
}

export async function getStrategy(tx: Transaction, id: string): Promise<StrategyDetail> {
  const row = await loadStrategyRow(tx, id);
  const versions = await tx
    .select({
      id: strategyVersions.id,
      versionNo: strategyVersions.versionNo,
      definitionHash: strategyVersions.definitionHash,
      createdAt: strategyVersions.createdAt,
    })
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, id))
    .orderBy(desc(strategyVersions.versionNo));
  const history = await tx
    .select({
      fromStatus: strategyStatusChanges.fromStatus,
      toStatus: strategyStatusChanges.toStatus,
      versionNo: strategyVersions.versionNo,
      reason: strategyStatusChanges.reason,
      acknowledgedWarnings: strategyStatusChanges.acknowledgedWarnings,
      changedAt: strategyStatusChanges.changedAt,
    })
    .from(strategyStatusChanges)
    .leftJoin(strategyVersions, eq(strategyVersions.id, strategyStatusChanges.versionId))
    .where(eq(strategyStatusChanges.strategyId, id))
    .orderBy(desc(strategyStatusChanges.changedAt));

  const current = versions.find((v) => v.id === row.currentVersionId) ?? null;
  return {
    id: row.id,
    name: row.name,
    library: await strategyLibraryRecord(tx, row.libraryEntryId),
    sharedBy: await sharedProvenance(tx, row.receivedShareId),
    description: row.description,
    tags: row.tags,
    status: row.status,
    hasBeenActive: row.hasBeenActive,
    definition: parseOrThrow(row.draftDefinition),
    definitionHash: row.draftHash,
    currentVersion: current,
    hasUnpublishedChanges: current?.definitionHash !== row.draftHash,
    versions,
    statusHistory: history,
    baseCurrency: row.baseCurrency,
    timezone: row.timezone,
    defaultAccountId: row.defaultAccountId,
    dataRouteId: row.dataRouteId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rowVersion: row.rowVersion,
  };
}

/** An immutable version's definition, for the version history view. */
export async function getStrategyVersion(tx: Transaction, strategyId: string, versionNo: number) {
  await loadStrategyRow(tx, strategyId);
  const [v] = await tx
    .select()
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.strategyId, strategyId), eq(strategyVersions.versionNo, versionNo)),
    );
  if (!v) throw new StrategyError('not_found', 'Version not found');
  return {
    id: v.id,
    versionNo: v.versionNo,
    definitionHash: v.definitionHash,
    createdAt: v.createdAt,
    definition: parseOrThrow(v.definition),
  };
}

// ---------------------------------------------------------------------------
// Validation context from the tenant's own instruments, accounts and feeds

export async function loadValidationContext(
  tx: Transaction,
  now = new Date(),
): Promise<ValidationContext> {
  const instrumentRows = await tx
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      assetClass: instruments.assetClass,
      lotSize: instruments.lotSize,
      venue: instruments.venue,
      shortable: instruments.shortable,
    })
    .from(instruments);
  const accountRows = await tx
    .select({
      id: tradingAccounts.id,
      nickname: tradingAccounts.nickname,
      mode: tradingAccounts.mode,
      isActive: tradingAccounts.isActive,
      platformActive: brokerConnections.isActive,
      capabilities: tradingAccounts.capabilities,
    })
    .from(tradingAccounts)
    .innerJoin(brokerConnections, eq(brokerConnections.id, tradingAccounts.brokerConnectionId));
  const routeRows = await tx
    .select({ assetClass: dataRoutes.assetClass, dataType: dataRoutes.dataType })
    .from(dataRoutes)
    .innerJoin(dataFeedConnections, eq(dataFeedConnections.id, dataRoutes.primaryFeedId))
    .where(eq(dataFeedConnections.isActive, true));

  const routes = new Set(routeRows.map((r) => `${r.assetClass}:${r.dataType}`));
  return {
    instruments: new Map<string, InstrumentInfo>(
      instrumentRows.map((i) => [
        i.id,
        {
          symbol: i.symbol,
          assetClass: i.assetClass,
          lotSize: i.lotSize,
          venue: i.venue,
          shortable: i.shortable,
        },
      ]),
    ),
    accounts: new Map<string, AccountInfo>(
      accountRows.map((a) => [
        a.id,
        {
          nickname: a.nickname,
          mode: a.mode,
          isActive: a.isActive && a.platformActive,
          capabilities: a.capabilities as AccountCapabilities,
        },
      ]),
    ),
    hasFeed: (assetClass, dataType) => routes.has(`${assetClass}:${dataType}`),
    hasCompanyFeed: (await activeFundamentalsFeed(tx)) !== undefined,
    options: {
      feedOn: (await activeOptionsFeed(tx)) !== undefined,
      universe: new Set((await listOptionUniverse(tx)).map((u) => u.underlyingId)),
    },
    demoInstrumentsRemoved: !demoDataEnabled(),
    now,
  };
}

export interface LatestBacktest {
  runId: string;
  definitionHash: string;
  finishedAt: Date;
}

/**
 * The latest completed back test, for the activation gate (§7.4). A missing
 * or mismatched one is a warning to acknowledge on paper (§20 #12, proposed).
 */
async function latestBacktestFor(
  tx: Transaction,
  strategyId: string,
): Promise<LatestBacktest | null> {
  const [run] = await tx
    .select({
      runId: backtestRuns.id,
      definitionHash: backtestRuns.definitionHash,
      finishedAt: backtestRuns.finishedAt,
    })
    .from(backtestRuns)
    .where(and(eq(backtestRuns.strategyId, strategyId), eq(backtestRuns.status, 'completed')))
    .orderBy(desc(backtestRuns.finishedAt))
    .limit(1);
  return run?.finishedAt ? { ...run, finishedAt: run.finishedAt } : null;
}

export async function validateStoredStrategy(
  tx: Transaction,
  id: string,
): Promise<{
  validation: ValidationResult;
  definitionHash: string;
  backtest: LatestBacktest | null;
}> {
  const row = await loadStrategyRow(tx, id);
  const definition = parseOrThrow(row.draftDefinition);
  const ctx = await loadValidationContext(tx);
  const backtest = await latestBacktestFor(tx, id);
  return {
    validation: validateStrategy(definition, {
      ...ctx,
      definitionHash: row.draftHash,
      backtest: backtest && {
        definitionHash: backtest.definitionHash,
        completedAt: backtest.finishedAt,
      },
    }),
    definitionHash: row.draftHash,
    backtest,
  };
}

// ---------------------------------------------------------------------------
// Writing

async function rebuildInstrumentIndex(
  tx: Transaction,
  userId: string,
  strategyId: string,
  def: StrategyDefinition,
) {
  await tx.delete(strategyInstruments).where(eq(strategyInstruments.strategyId, strategyId));
  const uses = collectInstrumentUses(def);
  if (uses.length === 0) return;
  // Unknown instrument ids stay in the draft as validation errors; only real ones are indexed.
  const known = new Set(
    (
      await tx
        .select({ id: instruments.id })
        .from(instruments)
        .where(inArray(instruments.id, [...new Set(uses.map((u) => u.instrumentId))]))
    ).map((r) => r.id),
  );
  const unique = new Map(
    uses
      .filter((u) => known.has(u.instrumentId))
      .map((u) => [`${u.instrumentId}:${u.phase}:${u.role}`, u]),
  );
  if (unique.size === 0) return;
  await tx.insert(strategyInstruments).values(
    [...unique.values()].map((u) => ({
      userId,
      strategyId,
      instrumentId: u.instrumentId,
      phase: u.phase,
      role: u.role,
    })),
  );
  // The auto-add rule (options data brief v2 §2): a US stock or ETF in a strategy
  // joins the options universe, so its recording and history rebuild start.
  await addOptionUnderlyings(tx, [...known]);
}

async function insertVersion(
  tx: Transaction,
  userId: string,
  strategyId: string,
  def: StrategyDefinition,
  hash: string,
) {
  const [last] = await tx
    .select({ n: max(strategyVersions.versionNo) })
    .from(strategyVersions)
    .where(eq(strategyVersions.strategyId, strategyId));
  const [version] = await tx
    .insert(strategyVersions)
    .values({
      userId,
      strategyId,
      versionNo: (last?.n ?? 0) + 1,
      schemaVersion: def.schemaVersion,
      definition: def,
      definitionHash: hash,
      createdBy: userId,
    })
    .returning();
  if (!version) throw new Error('Failed to create version');
  return version;
}

/**
 * The immutable version holding the current draft, for a back test to pin
 * (§7.2). Reuses the current version, or any earlier one with the same rules,
 * before snapshotting a new one. Only the version pointer moves: the draft and
 * `rowVersion` stay as they are, so an editor open elsewhere isn't invalidated.
 */
export async function pinDraftVersion(tx: Transaction, userId: string, id: string) {
  const row = await loadStrategyRow(tx, id);
  const definition = parseOrThrow(row.draftDefinition);
  const [existing] = await tx
    .select({ id: strategyVersions.id, versionNo: strategyVersions.versionNo })
    .from(strategyVersions)
    .where(
      and(eq(strategyVersions.strategyId, id), eq(strategyVersions.definitionHash, row.draftHash)),
    )
    .orderBy(desc(strategyVersions.versionNo))
    .limit(1);
  const version = existing ?? (await insertVersion(tx, userId, id, definition, row.draftHash));
  if (row.currentVersionId !== version.id) {
    await tx.update(strategies).set({ currentVersionId: version.id }).where(eq(strategies.id, id));
  }
  return { row, definition, versionId: version.id, versionNo: version.versionNo };
}

/** Updates the row if its version still matches; tells "gone" apart from "changed". */
async function updateRow(
  tx: Transaction,
  id: string,
  expectedRowVersion: number,
  values: Partial<typeof strategies.$inferInsert>,
) {
  const [row] = await tx
    .update(strategies)
    .set({ ...values, rowVersion: sql`${strategies.rowVersion} + 1` })
    .where(
      and(
        eq(strategies.id, id),
        eq(strategies.rowVersion, expectedRowVersion),
        isNull(strategies.deletedAt),
      ),
    )
    .returning();
  if (row) return row;
  await loadStrategyRow(tx, id); // throws not_found
  throw new StrategyError(
    'conflict',
    'This strategy was changed somewhere else. Reload to see the latest version.',
  );
}

export interface CreateStrategyInput {
  name: string;
  description?: string | undefined;
  tags?: string[] | undefined;
  definition?: unknown;
  /** The Library entry to link, or a new record (the default). */
  library?: LibraryChoice | undefined;
  /** Set only when accepting a share (ADR 0056): the share this copy comes from. */
  receivedShareId?: string | undefined;
}

export async function createStrategy(
  tx: Transaction,
  userId: string,
  input: CreateStrategyInput,
): Promise<StrategyDetail> {
  const def = input.definition === undefined ? createDefinition() : parseOrThrow(input.definition);
  await assertWithinLimit(tx, userId, 'savedStrategies');
  const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
  // New strategies start on the Alpaca paper account when there is one.
  const accountId = await preferredLegAccountId(tx);
  const hash = definitionHash(def);
  const [row] = await tx
    .insert(strategies)
    .values({
      userId,
      name: input.name,
      description: input.description ?? '',
      tags: input.tags ?? [],
      draftDefinition: def,
      draftSchemaVersion: STRATEGY_SCHEMA_VERSION,
      draftHash: hash,
      baseCurrency: profile?.baseCurrency ?? 'USD',
      timezone: profile?.timezone ?? 'America/New_York',
      defaultAccountId: accountId,
      receivedShareId: input.receivedShareId ?? null,
    })
    .returning({ id: strategies.id });
  if (!row) throw new Error('Failed to create strategy');
  await rebuildInstrumentIndex(tx, userId, row.id, def);
  // Its Library record and number, in this transaction (ADR 0054).
  await applyLibraryChoice(tx, userId, row.id, input.library);
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'strategy.created',
    resourceType: 'strategy',
    resourceId: row.id,
    afterRef: hash,
  });
  return getStrategy(tx, row.id);
}

export interface UpdateStrategyInput {
  rowVersion: number;
  name?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  definition?: unknown;
  archived?: boolean | undefined;
  /** Moves between Created and Under testing. Start and stop have their own calls. */
  status?: 'created' | 'under_testing' | undefined;
  /** The builder's Library entry picker: link an entry or start a new record (ADR 0054). */
  library?: LibraryChoice | undefined;
}

export async function updateStrategy(
  tx: Transaction,
  userId: string,
  id: string,
  input: UpdateStrategyInput,
): Promise<StrategyDetail> {
  const before = await loadStrategyRow(tx, id);
  const values: Partial<typeof strategies.$inferInsert> = {};
  const changed: string[] = [];

  if (input.name !== undefined && input.name !== before.name) {
    values.name = input.name;
    changed.push('name');
  }
  if (input.description !== undefined && input.description !== before.description) {
    values.description = input.description;
    changed.push('description');
  }
  if (input.tags !== undefined && input.tags.join('\u0000') !== before.tags.join('\u0000')) {
    values.tags = input.tags;
    changed.push('tags');
  }

  let def: StrategyDefinition | undefined;
  let hash = before.draftHash;
  if (input.definition !== undefined) {
    def = parseOrThrow(input.definition);
    hash = definitionHash(def);
    if (hash !== before.draftHash) {
      if (before.status === 'actively_executing') {
        throw new StrategyError('invalid_state', 'Stop this strategy before changing its rules');
      }
      values.draftDefinition = def;
      values.draftSchemaVersion = def.schemaVersion;
      values.draftHash = hash;
      changed.push('definition');
    }
  }

  if (input.archived !== undefined && input.archived !== (before.archivedAt !== null)) {
    if (input.archived && before.status === 'actively_executing') {
      throw new StrategyError('invalid_state', 'Stop this strategy before archiving it');
    }
    values.archivedAt = input.archived ? new Date() : null;
    changed.push(input.archived ? 'archived' : 'unarchived');
  }

  let statusChange: { from: StrategyStatus; to: StrategyStatus } | undefined;
  if (input.status !== undefined && input.status !== before.status) {
    const plan = planTransition({ from: before.status, to: input.status });
    if (!plan.ok) throw new StrategyError('transition_blocked', plan.message, plan);
    values.status = input.status;
    statusChange = { from: before.status, to: input.status };
  }

  if (changed.length === 0 && !statusChange) {
    if (before.rowVersion !== input.rowVersion) {
      throw new StrategyError(
        'conflict',
        'This strategy was changed somewhere else. Reload to see the latest version.',
      );
    }
    if (input.library) await applyLibraryChoice(tx, userId, id, input.library);
    return getStrategy(tx, id);
  }

  // After a strategy has run, changed rules become a new immutable version (§6.2).
  let versionId: string | undefined;
  if (def && changed.includes('definition') && before.hasBeenActive) {
    const version = await insertVersion(tx, userId, id, def, hash);
    values.currentVersionId = version.id;
    versionId = version.id;
  }

  await updateRow(tx, id, input.rowVersion, values);
  if (def && changed.includes('definition')) await rebuildInstrumentIndex(tx, userId, id, def);
  // A save of the strategy itself (not only a status or archive change) gets it
  // its Library record if it has none yet (ADR 0054, brief D3 and D9).
  const saved = changed.some((c) => c !== 'archived' && c !== 'unarchived');
  if (input.library || saved) await applyLibraryChoice(tx, userId, id, input.library);
  if (statusChange) {
    await tx.insert(strategyStatusChanges).values({
      userId,
      strategyId: id,
      fromStatus: statusChange.from,
      toStatus: statusChange.to,
    });
  }
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: statusChange && changed.length === 0 ? 'strategy.status_changed' : 'strategy.updated',
    resourceType: 'strategy',
    resourceId: id,
    beforeRef: before.draftHash,
    afterRef: hash,
    context: {
      changed,
      ...(statusChange ? { fromStatus: statusChange.from, toStatus: statusChange.to } : {}),
      ...(versionId ? { versionId } : {}),
    },
  });
  return getStrategy(tx, id);
}

/** Snapshots the draft as a new immutable version, unless it equals the current one. */
export async function publishVersion(
  tx: Transaction,
  userId: string,
  id: string,
  input: { rowVersion: number },
): Promise<{ strategy: StrategyDetail; created: boolean }> {
  const row = await loadStrategyRow(tx, id);
  const current = row.currentVersionId
    ? (
        await tx
          .select({ hash: strategyVersions.definitionHash })
          .from(strategyVersions)
          .where(eq(strategyVersions.id, row.currentVersionId))
      )[0]
    : undefined;
  if (current?.hash === row.draftHash) {
    if (row.rowVersion !== input.rowVersion) {
      throw new StrategyError(
        'conflict',
        'This strategy was changed somewhere else. Reload to see the latest version.',
      );
    }
    return { strategy: await getStrategy(tx, id), created: false };
  }
  const def = parseOrThrow(row.draftDefinition);
  const version = await insertVersion(tx, userId, id, def, row.draftHash);
  await updateRow(tx, id, input.rowVersion, { currentVersionId: version.id });
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'strategy.version_published',
    resourceType: 'strategy',
    resourceId: id,
    afterRef: row.draftHash,
    context: { versionId: version.id, versionNo: version.versionNo },
  });
  return { strategy: await getStrategy(tx, id), created: true };
}

export async function duplicateStrategy(
  tx: Transaction,
  userId: string,
  id: string,
  input: { name?: string | undefined; description?: string | undefined } = {},
): Promise<StrategyDetail> {
  const source = await loadStrategyRow(tx, id);
  const name = input.name ?? `Copy of ${source.name}`.slice(0, 120);
  const copy = await createStrategy(tx, userId, {
    name,
    description: input.description ?? source.description,
    tags: source.tags,
    definition: source.draftDefinition,
  });
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'strategy.duplicated',
    resourceType: 'strategy',
    resourceId: copy.id,
    beforeRef: source.draftHash,
    context: { sourceId: id },
  });
  return copy;
}

export async function deleteStrategy(
  tx: Transaction,
  userId: string,
  id: string,
  input: { rowVersion: number },
): Promise<void> {
  const row = await loadStrategyRow(tx, id);
  if (row.status === 'actively_executing') {
    throw new StrategyError('invalid_state', 'Stop this strategy before deleting it');
  }
  await updateRow(tx, id, input.rowVersion, { deletedAt: new Date() });
  await tx.delete(strategyInstruments).where(eq(strategyInstruments.strategyId, id));
  await unlinkDeletedStrategy(tx, userId, row);
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'strategy.deleted',
    resourceType: 'strategy',
    resourceId: id,
    beforeRef: row.draftHash,
  });
}

export interface StartStrategyInput {
  rowVersion: number;
  acknowledgedWarnings?: readonly string[] | undefined;
  confirmed?: boolean | undefined;
}

/**
 * Moves a strategy to Actively executing on paper. Requires a clean
 * validation, every warning acknowledged and explicit confirmation, and pins
 * an immutable version (§6.3, §6.10). Order generation arrives in Phase 3.
 */
export async function startStrategy(
  tx: Transaction,
  userId: string,
  id: string,
  input: StartStrategyInput,
): Promise<StrategyDetail> {
  const row = await loadStrategyRow(tx, id);
  if (row.archivedAt)
    throw new StrategyError('invalid_state', 'Restore this strategy before starting it');
  const { validation, backtest } = await validateStoredStrategy(tx, id);
  const plan = planTransition({
    from: row.status,
    to: 'actively_executing',
    validation,
    acknowledgedWarnings: input.acknowledgedWarnings ?? [],
    confirmed: input.confirmed ?? false,
  });
  if (!plan.ok) {
    throw new StrategyError('transition_blocked', plan.message, {
      reason: plan.reason,
      details: plan.details ?? [],
      validation,
    });
  }
  // Back test only for now (decision of 2026-11-06, Design v1.2).
  const blocker = paperRunBlocker(parseOrThrow(row.draftDefinition));
  if (blocker) {
    throw new StrategyError('transition_blocked', blocker, {
      reason: 'backtest_only',
      details: [blocker],
      validation,
    });
  }
  await assertWithinLimit(tx, userId, 'activeStrategies');

  let versionId = row.currentVersionId;
  const current = versionId
    ? (
        await tx
          .select({ hash: strategyVersions.definitionHash })
          .from(strategyVersions)
          .where(eq(strategyVersions.id, versionId))
      )[0]
    : undefined;
  if (current?.hash !== row.draftHash) {
    const version = await insertVersion(
      tx,
      userId,
      id,
      parseOrThrow(row.draftDefinition),
      row.draftHash,
    );
    versionId = version.id;
  }
  const acknowledged = [...new Set(validation.warnings.map((w) => w.code))];

  await updateRow(tx, id, input.rowVersion, {
    status: 'actively_executing',
    hasBeenActive: true,
    currentVersionId: versionId,
  });
  if (!versionId) throw new StrategyError('invalid_state', 'The strategy has no version to run');
  // The worker picks the runtime up on its next poll (§8.1).
  const runtimeId = await createRuntime(tx, userId, id, versionId);
  await tx.insert(strategyStatusChanges).values({
    userId,
    strategyId: id,
    fromStatus: row.status,
    toStatus: 'actively_executing',
    versionId,
    acknowledgedWarnings: acknowledged,
  });
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'strategy.started',
    resourceType: 'strategy',
    resourceId: id,
    afterRef: row.draftHash,
    context: {
      mode: 'paper',
      versionId,
      fromStatus: row.status,
      acknowledgedWarnings: acknowledged,
      latestBacktestId: backtest?.runId ?? null,
      runtimeId,
    },
  });
  await notify(tx, {
    userId,
    kind: 'strategy_started',
    title: `${row.name} started on paper`,
    body: 'New orders appear in Orders as its rules trigger.',
    link: `/orders?started=${id}`,
    resourceType: 'strategy_runtime',
    resourceId: runtimeId,
    dedupeKey: `started:${runtimeId}`,
  });
  return getStrategy(tx, id);
}

export async function stopStrategy(
  tx: Transaction,
  userId: string,
  id: string,
  input: {
    rowVersion: number;
    reason?: string | undefined;
    /** Separate, explicit choices (§8.1); neither happens by default. */
    cancelOpenOrders?: boolean | undefined;
    closePositions?: boolean | undefined;
  },
): Promise<StrategyDetail> {
  const row = await loadStrategyRow(tx, id);
  const plan = planTransition({ from: row.status, to: 'off' });
  if (!plan.ok) {
    throw new StrategyError(
      'transition_blocked',
      `Only an actively executing strategy can be stopped; this one is ${STATUS_LABELS[row.status]}`,
    );
  }
  await updateRow(tx, id, input.rowVersion, { status: 'off' });
  // No new orders from here on. Working orders and positions are left alone
  // unless the person chose otherwise (§8.1).
  const runtimeId = await stopRuntime(tx, userId, id);
  let canceledOrders = 0;
  let closeOrders = 0;
  if (runtimeId && input.cancelOpenOrders) {
    canceledOrders = await cancelWorkingOrders(tx, userId, {
      runtimeId,
      reason: 'Canceled when the strategy was stopped',
    });
  }
  if (runtimeId && input.closePositions && (await listPositions(tx, { runtimeId })).length > 0) {
    closeOrders = (await closePositions(tx, userId, { runtimeId })).orders;
  }
  await tx.insert(strategyStatusChanges).values({
    userId,
    strategyId: id,
    fromStatus: row.status,
    toStatus: 'off',
    versionId: row.currentVersionId,
    reason: input.reason ?? null,
  });
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'strategy.stopped',
    resourceType: 'strategy',
    resourceId: id,
    context: {
      versionId: row.currentVersionId,
      runtimeId: runtimeId ?? null,
      canceledOrders,
      closeOrders,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  if (runtimeId) {
    const choices = [
      ...(canceledOrders > 0 ? [`${canceledOrders} working orders canceled`] : []),
      ...(closeOrders > 0 ? [`${closeOrders} close orders sent`] : []),
    ];
    await notify(tx, {
      userId,
      kind: 'strategy_stopped',
      title: `${row.name} stopped`,
      body: choices.length
        ? `No new orders. ${choices.join('; ')}.`
        : 'No new orders. Working orders and positions were left as they are.',
      link: `/orders?strategy=${id}`,
      resourceType: 'strategy_runtime',
      resourceId: runtimeId,
      dedupeKey: `stopped:${runtimeId}`,
    });
  }
  return getStrategy(tx, id);
}
