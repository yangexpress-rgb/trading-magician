import {
  composeRegistrationNumber,
  ConventionCodeError,
  currentConvention,
  editLibraryEntrySchema,
  interpretRegistrationNumber,
  parseRegistrationNumber,
  registerLibraryEntrySchema,
  retireLibraryEntrySchema,
  type BuiltStatus,
  type ConventionCode,
  type ConventionPosition,
  type ConventionTables,
  type ConventionVersion,
  type EditLibraryEntryInput,
  type LibraryCategory,
  type LibraryDuration,
  type LibrarySource,
  type LibraryStatus,
  type MeasuredDuration,
  type RegisterLibraryEntry,
  type RegisterLibraryEntryInput,
  type RegistrationCodes,
  type UsedBy,
} from '@tm/domain';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Transaction } from './client';
import {
  conventionVersions,
  strategies,
  strategyLibraryEntries as entries,
  strategyLibraryRevisions as revisions,
  strategyLibrarySequence,
} from './schema';

/**
 * The Strategy Library (ADR 0051): a shared registry of strategy records, each
 * with one permanent registration number. The database issues numbers (insert
 * trigger, migration 0067); this module validates, previews and reads them.
 * Every function runs inside `withTenant`, whose user is the actor.
 */

export type LibraryErrorCode = 'not_found' | 'bad_request' | 'conflict' | 'invalid_state';

export class LibraryError extends Error {
  constructor(
    public readonly code: LibraryErrorCode,
    message: string,
    public readonly issues?: { path: (string | number)[]; message: string }[],
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

export interface LibraryEntrySummary {
  id: string;
  registrationNumber: string;
  sequenceNo: number;
  conventionVersion: string;
  recordTypeCode: string;
  timeframeCode: string;
  assetClassCode: string;
  name: string;
  category: LibraryCategory;
  tags: string[];
  status: LibraryStatus;
  builtStatus: BuiltStatus;
  shortDescription: string;
  assets: string;
  registeredAt: Date;
}

export interface LibraryRevision {
  /** `create` is an auto-created record's first entry (ADR 0054). */
  action: 'create' | 'edit' | 'retire';
  note: string;
  changedFields: string[];
  editedAt: Date;
  /** "you", "another member" or "a former member": no names are shared across workspaces. */
  editedBy: ActorLabel;
}

export type ActorLabel = 'seed' | 'you' | 'member' | 'former_member';

export interface LibraryEntry extends LibraryEntrySummary {
  longDescription: string;
  dataRequirements: string | null;
  entry: string;
  exit: string;
  frequency: MeasuredDuration;
  turnaround: LibraryDuration;
  usedBy: UsedBy[];
  trackRecord: string | null;
  backtestSummary: string | null;
  sources: LibrarySource[];
  relatedEntries: {
    registrationNumber: string;
    name: string | null;
    status: LibraryStatus | null;
  }[];
  builtStrategyId: string | null;
  /** The linked strategy as the viewer sees it: theirs (with its name) or someone else's. */
  builtStrategy:
    | { visibility: 'yours'; id: string; name: string; archived: boolean }
    | { visibility: 'yours_deleted'; id: string }
    | { visibility: 'elsewhere' }
    | null;
  retiredReason: string | null;
  retiredAt: Date | null;
  registeredBy: ActorLabel;
  updatedBy: ActorLabel;
  updatedAt: Date;
  rowVersion: number;
  /** What each letter means under the version that issued the number. */
  letters: Record<ConventionPosition, ConventionCode | null>;
  revisions: LibraryRevision[];
}

export interface LibraryListOptions {
  search?: string | undefined;
  assetClassCode?: string | undefined;
  timeframeCode?: string | undefined;
  category?: LibraryCategory | undefined;
  built?: BuiltStatus | undefined;
  status?: LibraryStatus | 'all' | undefined;
  sort?: 'number' | 'name' | 'registered' | undefined;
  direction?: 'asc' | 'desc' | undefined;
}

// ---------------------------------------------------------------------------
// Conventions and the number preview
// ---------------------------------------------------------------------------

export async function listConventionVersions(tx: Transaction): Promise<ConventionVersion[]> {
  const rows = await tx
    .select()
    .from(conventionVersions)
    .orderBy(asc(conventionVersions.effectiveFrom), asc(conventionVersions.createdAt));
  return rows.map((r) => ({
    label: r.label,
    effectiveFrom: r.effectiveFrom,
    tables: r.tables as ConventionTables,
  }));
}

export async function getCurrentConvention(tx: Transaction): Promise<ConventionVersion> {
  const version = currentConvention(await listConventionVersions(tx));
  if (!version) throw new LibraryError('invalid_state', 'No convention version is in effect yet');
  return version;
}

/** The sequence the next registration will take. Reserves nothing. */
export async function nextLibrarySequence(tx: Transaction): Promise<number> {
  const [row] = await tx
    .select({ last: strategyLibrarySequence.lastIssued })
    .from(strategyLibrarySequence)
    .where(eq(strategyLibrarySequence.id, 1));
  return (row?.last ?? 0) + 1;
}

/**
 * The number a registration with these codes would get if it were saved now.
 * Someone else may register first, so the saved number can be later.
 */
export async function previewRegistrationNumber(
  tx: Transaction,
  codes: RegistrationCodes,
): Promise<{ registrationNumber: string; conventionVersion: string }> {
  const version = await getCurrentConvention(tx);
  try {
    return {
      registrationNumber: composeRegistrationNumber(version, codes, await nextLibrarySequence(tx)),
      conventionVersion: version.label,
    };
  } catch (error) {
    throw codeError(error);
  }
}

function codeError(error: unknown): unknown {
  if (!(error instanceof ConventionCodeError)) return error;
  const field = `${error.position}Code`;
  return new LibraryError('bad_request', error.message, [
    { path: [field], message: error.message },
  ]);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const builtStatusSql = sql<BuiltStatus>`case when ${entries.builtStrategyId} is null then 'not_built' else 'built' end`;

const summaryColumns = {
  id: entries.id,
  registrationNumber: entries.registrationNumber,
  sequenceNo: entries.sequenceNo,
  conventionVersion: entries.conventionVersion,
  recordTypeCode: entries.recordTypeCode,
  timeframeCode: entries.timeframeCode,
  assetClassCode: entries.assetClassCode,
  name: entries.name,
  category: entries.category,
  tags: entries.tags,
  status: entries.status,
  builtStatus: builtStatusSql,
  shortDescription: entries.shortDescription,
  assets: entries.assets,
  registeredAt: entries.registeredAt,
};

export async function listLibraryEntries(
  tx: Transaction,
  options: LibraryListOptions = {},
): Promise<{ items: LibraryEntrySummary[]; total: number }> {
  const where: SQL[] = [];
  const search = options.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(
      ${entries.registrationNumber} ilike ${like}
      or ${entries.name} ilike ${like}
      or ${entries.shortDescription} ilike ${like}
      or ${entries.longDescription} ilike ${like}
      or ${entries.assets} ilike ${like}
      or array_to_string(${entries.tags}, ' ') ilike ${like}
    )`);
  }
  if (options.assetClassCode) where.push(eq(entries.assetClassCode, options.assetClassCode));
  if (options.timeframeCode) where.push(eq(entries.timeframeCode, options.timeframeCode));
  if (options.category) where.push(eq(entries.category, options.category));
  if (options.built === 'built') where.push(sql`${entries.builtStrategyId} is not null`);
  if (options.built === 'not_built') where.push(isNull(entries.builtStrategyId));
  const status = options.status ?? 'all';
  if (status !== 'all') where.push(eq(entries.status, status));

  const dir = options.direction === 'desc' ? desc : asc;
  const order =
    options.sort === 'name'
      ? [dir(sql`lower(${entries.name})`), asc(entries.sequenceNo)]
      : options.sort === 'registered'
        ? [dir(entries.registeredAt), dir(entries.sequenceNo)]
        : [dir(entries.sequenceNo)];

  const rows = await tx
    .select(summaryColumns)
    .from(entries)
    .where(where.length ? and(...where) : undefined)
    .orderBy(...order);
  return { items: rows.map(toSummary), total: rows.length };
}

type SummaryRow = {
  [K in keyof typeof summaryColumns]: unknown;
};

function toSummary(r: SummaryRow): LibraryEntrySummary {
  return {
    id: r.id as string,
    registrationNumber: r.registrationNumber as string,
    sequenceNo: r.sequenceNo as number,
    conventionVersion: r.conventionVersion as string,
    recordTypeCode: r.recordTypeCode as string,
    timeframeCode: r.timeframeCode as string,
    assetClassCode: r.assetClassCode as string,
    name: r.name as string,
    category: r.category as LibraryCategory,
    tags: r.tags as string[],
    status: r.status as LibraryStatus,
    builtStatus: r.builtStatus as BuiltStatus,
    shortDescription: r.shortDescription as string,
    assets: r.assets as string,
    registeredAt: r.registeredAt as Date,
  };
}

/** Names of every entry, for the register form's duplicate-name warning. */
export async function listLibraryNames(
  tx: Transaction,
): Promise<{ registrationNumber: string; name: string }[]> {
  return tx
    .select({ registrationNumber: entries.registrationNumber, name: entries.name })
    .from(entries)
    .orderBy(asc(entries.sequenceNo));
}

/** Null is the seed catalogue where `seedFallback`, otherwise a deleted account. */
function actor(id: string | null, viewerId: string, seedFallback: boolean): ActorLabel {
  if (id === null) return seedFallback ? 'seed' : 'former_member';
  return id === viewerId ? 'you' : 'member';
}

function normalise(number: string): string {
  return number.trim().toUpperCase();
}

async function loadRow(tx: Transaction, number: string) {
  const [row] = await tx
    .select()
    .from(entries)
    .where(eq(entries.registrationNumber, normalise(number)));
  return row;
}

export async function getLibraryEntry(
  tx: Transaction,
  viewerId: string,
  number: string,
): Promise<LibraryEntry | null> {
  if (!parseRegistrationNumber(number)) return null;
  const row = await loadRow(tx, number);
  if (!row) return null;
  const isSeed = row.seedKey !== null;

  const [versions, history, related] = await Promise.all([
    listConventionVersions(tx),
    tx
      .select()
      .from(revisions)
      .where(eq(revisions.entryId, row.id))
      .orderBy(desc(revisions.editedAt), desc(revisions.id)),
    row.relatedEntries.length
      ? tx
          .select({
            registrationNumber: entries.registrationNumber,
            name: entries.name,
            status: entries.status,
          })
          .from(entries)
          .where(inArray(entries.registrationNumber, row.relatedEntries))
      : Promise.resolve([]),
  ]);

  let builtStrategy: LibraryEntry['builtStrategy'] = null;
  if (row.builtStrategyId) {
    if (row.builtStrategyOwner === viewerId) {
      // Row-level security limits this to the viewer's own workspace.
      const [s] = await tx
        .select({ id: strategies.id, name: strategies.name, archivedAt: strategies.archivedAt })
        .from(strategies)
        .where(and(eq(strategies.id, row.builtStrategyId), isNull(strategies.deletedAt)));
      builtStrategy = s
        ? { visibility: 'yours', id: s.id, name: s.name, archived: s.archivedAt !== null }
        : { visibility: 'yours_deleted', id: row.builtStrategyId };
    } else builtStrategy = { visibility: 'elsewhere' };
  }

  const issuedUnder = versions.find((v) => v.label === row.conventionVersion);
  const meanings = issuedUnder
    ? interpretRegistrationNumber(row.registrationNumber, issuedUnder)
    : null;
  const relatedBy = new Map(related.map((r) => [r.registrationNumber, r]));

  return {
    ...toSummary({ ...row, builtStatus: row.builtStrategyId ? 'built' : 'not_built' }),
    longDescription: row.longDescription,
    dataRequirements: row.dataRequirements,
    entry: row.entry,
    exit: row.exit,
    frequency: row.frequency as MeasuredDuration,
    turnaround: row.turnaround as LibraryDuration,
    usedBy: row.usedBy as UsedBy[],
    trackRecord: row.trackRecord,
    backtestSummary: row.backtestSummary,
    sources: row.sources as LibrarySource[],
    relatedEntries: row.relatedEntries.map((n) => ({
      registrationNumber: n,
      name: relatedBy.get(n)?.name ?? null,
      status: (relatedBy.get(n)?.status as LibraryStatus | undefined) ?? null,
    })),
    builtStrategyId: row.builtStrategyId,
    builtStrategy,
    retiredReason: row.retiredReason,
    retiredAt: row.retiredAt,
    registeredBy: actor(row.registeredBy, viewerId, isSeed),
    updatedBy: actor(row.updatedBy, viewerId, isSeed && history.length === 0),
    updatedAt: row.updatedAt,
    rowVersion: row.rowVersion,
    letters: {
      recordType: meanings?.recordType ?? null,
      timeframe: meanings?.timeframe ?? null,
      assetClass: meanings?.assetClass ?? null,
    },
    revisions: history.map((h) => ({
      action: h.action as LibraryRevision['action'],
      note: h.note,
      changedFields: h.changedFields,
      editedAt: h.editedAt,
      editedBy: actor(h.editedBy, viewerId, false),
    })),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
      message: i.message,
    }));
    throw new LibraryError('bad_request', issues[0]?.message ?? 'Check the entry', issues);
  }
  return result.data;
}

async function checkRelated(tx: Transaction, numbers: string[], self?: string): Promise<void> {
  if (self && numbers.includes(self)) {
    throw new LibraryError('bad_request', 'An entry cannot be related to itself', [
      { path: ['relatedEntries'], message: 'An entry cannot be related to itself' },
    ]);
  }
  if (!numbers.length) return;
  const found = await tx
    .select({ n: entries.registrationNumber })
    .from(entries)
    .where(inArray(entries.registrationNumber, numbers));
  const missing = numbers.filter((n) => !found.some((f) => f.n === n));
  if (missing.length) {
    const message = `No entry is registered as ${missing.join(', ')}`;
    throw new LibraryError('bad_request', message, [{ path: ['relatedEntries'], message }]);
  }
}

/** A link must name a strategy in the actor's own workspace (RLS scopes the read). */
async function checkStrategy(tx: Transaction, strategyId: string): Promise<void> {
  const [s] = await tx
    .select({ id: strategies.id })
    .from(strategies)
    .where(and(eq(strategies.id, strategyId), isNull(strategies.deletedAt)));
  if (!s) {
    const message = 'Pick a strategy from your Strategy Lab';
    throw new LibraryError('bad_request', message, [{ path: ['builtStrategyId'], message }]);
  }
}

function recordValues(
  data: Omit<RegisterLibraryEntry, 'recordTypeCode' | 'timeframeCode' | 'assetClassCode'>,
) {
  return {
    name: data.name,
    category: data.category,
    tags: data.tags,
    shortDescription: data.shortDescription,
    longDescription: data.longDescription,
    assets: data.assets,
    dataRequirements: data.dataRequirements ?? null,
    entry: data.entry,
    exit: data.exit,
    frequency: data.frequency,
    turnaround: data.turnaround,
    usedBy: data.usedBy,
    trackRecord: data.trackRecord ?? null,
    backtestSummary: data.backtestSummary ?? null,
    sources: data.sources,
    relatedEntries: data.relatedEntries,
    builtStrategyId: data.builtStrategyId,
  };
}

/**
 * Registers an entry and returns it with its number. The number is issued by
 * the database in this transaction: if anything fails, nothing is issued.
 * `actorId` null is the seed catalogue (owner connection only).
 */
export async function registerLibraryEntry(
  tx: Transaction,
  actorId: string | null,
  input: RegisterLibraryEntryInput,
  options: { seedKey?: string } = {},
): Promise<{ id: string; registrationNumber: string; conventionVersion: string }> {
  const data = parseInput(registerLibraryEntrySchema, input);
  const codes = {
    recordType: data.recordTypeCode,
    timeframe: data.timeframeCode,
    assetClass: data.assetClassCode,
  };
  const version = await getCurrentConvention(tx);
  try {
    composeRegistrationNumber(version, codes, 1);
  } catch (error) {
    throw codeError(error);
  }
  await checkRelated(tx, data.relatedEntries);
  if (data.builtStrategyId) await checkStrategy(tx, data.builtStrategyId);
  const linkedStrategy = data.builtStrategyId
    ? await strategyLinkRow(tx, data.builtStrategyId)
    : null;

  const [row] = await tx
    .insert(entries)
    .values({
      ...recordValues(data),
      builtStrategyOwner: data.builtStrategyId ? actorId : null,
      recordTypeCode: codes.recordType,
      timeframeCode: codes.timeframe,
      assetClassCode: codes.assetClass,
      registeredBy: actorId,
      seedKey: options.seedKey ?? null,
      // Replaced by the insert trigger, which issues the number.
      registrationNumber: '',
      sequenceNo: 0,
      conventionVersion: version.label,
    })
    .returning({
      id: entries.id,
      registrationNumber: entries.registrationNumber,
      sequenceNo: entries.sequenceNo,
      conventionVersion: entries.conventionVersion,
    });
  if (!row) throw new Error('Registration returned no row');
  // The trigger and the domain rules must agree; a mismatch rolls the save back.
  const issuedUnder =
    row.conventionVersion === version.label ? version : await getCurrentConvention(tx);
  const expected = composeRegistrationNumber(issuedUnder, codes, row.sequenceNo);
  if (expected !== row.registrationNumber) {
    throw new Error(`Issued ${row.registrationNumber}, expected ${expected}`);
  }
  // The strategy now is this record (ADR 0054): its previous record goes back to Not built.
  if (linkedStrategy && actorId) {
    await adoptStrategy(tx, actorId, linkedStrategy, row.id, row.registrationNumber);
  }
  return {
    id: row.id,
    registrationNumber: row.registrationNumber,
    conventionVersion: row.conventionVersion,
  };
}

const EDITABLE = [
  'name',
  'category',
  'tags',
  'shortDescription',
  'longDescription',
  'assets',
  'dataRequirements',
  'entry',
  'exit',
  'frequency',
  'turnaround',
  'usedBy',
  'trackRecord',
  'backtestSummary',
  'sources',
  'relatedEntries',
  'builtStrategyId',
] as const;

/** Key order differs between jsonb and parsed input, so compare canonically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value ?? null;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Edits every person-written field. The number, convention version and code
 * letters never change; a change note is required and kept in the history.
 */
export async function updateLibraryEntry(
  tx: Transaction,
  actorId: string,
  number: string,
  input: EditLibraryEntryInput,
): Promise<{ registrationNumber: string; rowVersion: number; changedFields: string[] }> {
  const data = parseInput(editLibraryEntrySchema, input);
  const row = await loadRow(tx, number);
  if (!row) throw new LibraryError('not_found', 'No entry has that registration number');
  if (row.rowVersion !== data.rowVersion) {
    throw new LibraryError(
      'conflict',
      'Someone changed this entry since you opened it. Reload to see their change.',
    );
  }
  await checkRelated(tx, data.relatedEntries, row.registrationNumber);
  const values = recordValues(data);
  const before: Record<string, unknown> = row;
  const changed = EDITABLE.filter((f) => !same(before[f], values[f]));
  if (!changed.length) {
    throw new LibraryError('bad_request', 'Nothing changed. Edit a field before saving.');
  }
  const linkChanged = changed.includes('builtStrategyId');
  if (linkChanged) await checkLinkChange(tx, actorId, row, values.builtStrategyId);

  const [updated] = await tx
    .update(entries)
    .set({
      ...values,
      ...(linkChanged ? { builtStrategyOwner: values.builtStrategyId ? actorId : null } : {}),
      updatedBy: actorId,
      updatedAt: new Date(),
      rowVersion: row.rowVersion + 1,
    })
    .where(and(eq(entries.id, row.id), eq(entries.rowVersion, row.rowVersion)))
    .returning({ rowVersion: entries.rowVersion });
  if (!updated) {
    throw new LibraryError('conflict', 'Someone changed this entry since you opened it.');
  }
  await tx.insert(revisions).values({
    entryId: row.id,
    action: 'edit',
    note: data.changeNote,
    changedFields: [...changed],
    editedBy: actorId,
  });
  if (linkChanged) await syncStrategySide(tx, actorId, row, values.builtStrategyId);
  return {
    registrationNumber: row.registrationNumber,
    rowVersion: updated.rowVersion,
    changedFields: [...changed],
  };
}

/** Retires an entry: it stays listed, badged Retired, and keeps its number. */
export async function retireLibraryEntry(
  tx: Transaction,
  actorId: string,
  number: string,
  input: unknown,
): Promise<{ registrationNumber: string; rowVersion: number }> {
  const data = parseInput(retireLibraryEntrySchema, input);
  const row = await loadRow(tx, number);
  if (!row) throw new LibraryError('not_found', 'No entry has that registration number');
  if (row.status === 'retired') throw new LibraryError('invalid_state', 'Already retired');
  if (row.rowVersion !== data.rowVersion) {
    throw new LibraryError('conflict', 'Someone changed this entry since you opened it.');
  }
  const now = new Date();
  const [updated] = await tx
    .update(entries)
    .set({
      status: 'retired',
      retiredReason: data.reason,
      retiredAt: now,
      retiredBy: actorId,
      updatedBy: actorId,
      updatedAt: now,
      rowVersion: row.rowVersion + 1,
    })
    .where(and(eq(entries.id, row.id), eq(entries.rowVersion, row.rowVersion)))
    .returning({ rowVersion: entries.rowVersion });
  if (!updated)
    throw new LibraryError('conflict', 'Someone changed this entry since you opened it.');
  await tx.insert(revisions).values({
    entryId: row.id,
    action: 'retire',
    note: data.reason,
    changedFields: ['status'],
    editedBy: actorId,
  });
  return { registrationNumber: row.registrationNumber, rowVersion: updated.rowVersion };
}

/** The viewer's own strategies, for the link field. Reads names and ids only. */
export async function listLinkableStrategies(
  tx: Transaction,
): Promise<{ id: string; name: string; archived: boolean }[]> {
  const rows = await tx
    .select({ id: strategies.id, name: strategies.name, archivedAt: strategies.archivedAt })
    .from(strategies)
    .where(isNull(strategies.deletedAt))
    .orderBy(asc(sql`lower(${strategies.name})`))
    .limit(500);
  return rows.map((r) => ({ id: r.id, name: r.name, archived: r.archivedAt !== null }));
}

/**
 * Sets or clears only the Strategy Lab link, with a history note. Used by
 * `library:link-seed`; the edit form goes through `updateLibraryEntry`.
 */
export async function linkLibraryEntry(
  tx: Transaction,
  actorId: string,
  number: string,
  strategyId: string | null,
  note: string,
): Promise<void> {
  const row = await loadRow(tx, number);
  if (!row) throw new LibraryError('not_found', 'No entry has that registration number');
  if (row.builtStrategyId === strategyId) return;
  await checkLinkChange(tx, actorId, row, strategyId);
  await tx
    .update(entries)
    .set({
      builtStrategyId: strategyId,
      builtStrategyOwner: strategyId ? actorId : null,
      updatedBy: actorId,
      updatedAt: new Date(),
      rowVersion: row.rowVersion + 1,
    })
    .where(and(eq(entries.id, row.id), eq(entries.rowVersion, row.rowVersion)));
  await tx.insert(revisions).values({
    entryId: row.id,
    action: 'edit',
    note,
    changedFields: ['builtStrategyId'],
    editedBy: actorId,
  });
  await syncStrategySide(tx, actorId, row, strategyId);
}

// ---------------------------------------------------------------------------
// The Strategy Lab association (ADR 0054)
//
// A Lab strategy names its record in `strategy.library_entry_id`; the record's
// `built_strategy_id` mirrors it, so Built status follows the association in
// both directions. Every change below keeps the two sides equal in the same
// transaction and writes each record's change to its history.
// ---------------------------------------------------------------------------

type EntryRow = typeof entries.$inferSelect;

/** The strategy side of a link: the actor's own live strategy (RLS scopes the read). */
export async function strategyLinkRow(tx: Transaction, strategyId: string) {
  const [s] = await tx
    .select({ id: strategies.id, name: strategies.name, libraryEntryId: strategies.libraryEntryId })
    .from(strategies)
    .where(and(eq(strategies.id, strategyId), isNull(strategies.deletedAt)));
  return s ?? null;
}

/** Sets or clears a record's built link, with a history note. The record and number stay. */
export async function setEntryBuilt(
  tx: Transaction,
  actorId: string,
  entryId: string,
  strategyId: string | null,
  note: string,
): Promise<void> {
  const [row] = await tx.select().from(entries).where(eq(entries.id, entryId));
  if (!row || row.builtStrategyId === strategyId) return;
  await tx
    .update(entries)
    .set({
      builtStrategyId: strategyId,
      builtStrategyOwner: strategyId ? actorId : null,
      updatedBy: actorId,
      updatedAt: new Date(),
      rowVersion: row.rowVersion + 1,
    })
    .where(eq(entries.id, row.id));
  await tx.insert(revisions).values({
    entryId: row.id,
    action: 'edit',
    note: note.slice(0, 500),
    changedFields: ['builtStrategyId'],
    editedBy: actorId,
  });
}

/** Points the strategy at its record (only the link column: an open builder stays valid). */
export async function setStrategyEntry(
  tx: Transaction,
  strategyId: string,
  entryId: string | null,
): Promise<void> {
  await tx
    .update(strategies)
    .set({ libraryEntryId: entryId })
    .where(and(eq(strategies.id, strategyId), isNull(strategies.deletedAt)));
}

/** The named refusal for a record built by another strategy (brief D6), or null. */
export async function builtElsewhereMessage(
  tx: Transaction,
  actorId: string,
  row: Pick<EntryRow, 'registrationNumber' | 'builtStrategyId' | 'builtStrategyOwner'>,
  strategyId: string | null,
): Promise<string | null> {
  if (!row.builtStrategyId || row.builtStrategyId === strategyId) return null;
  if (row.builtStrategyOwner !== actorId) {
    return `${row.registrationNumber} is built in another member's Strategy Lab`;
  }
  const other = await strategyLinkRow(tx, row.builtStrategyId);
  // A link to a deleted strategy no longer holds the record.
  if (!other) return null;
  return `${row.registrationNumber} is already built by ${other.name} — unlink that strategy first`;
}

/**
 * A Library-side link change (edit form, link-seed): the new strategy must be
 * the actor's own, and a link held in another member's workspace can't be
 * taken over or cleared from here, since their strategy would keep naming it.
 */
async function checkLinkChange(
  tx: Transaction,
  actorId: string,
  row: EntryRow,
  strategyId: string | null,
): Promise<void> {
  if (strategyId) await checkStrategy(tx, strategyId);
  if (row.builtStrategyId && row.builtStrategyOwner !== actorId) {
    const message = `${row.registrationNumber} is built in another member's Strategy Lab`;
    throw new LibraryError('invalid_state', message, [{ path: ['builtStrategyId'], message }]);
  }
}

/** The strategy becomes this record: its previous record goes back to Not built. */
async function adoptStrategy(
  tx: Transaction,
  actorId: string,
  strategy: { id: string; name: string; libraryEntryId: string | null },
  entryId: string,
  registrationNumber: string,
): Promise<void> {
  if (strategy.libraryEntryId && strategy.libraryEntryId !== entryId) {
    await setEntryBuilt(
      tx,
      actorId,
      strategy.libraryEntryId,
      null,
      `Unlinked: the Strategy Lab strategy “${strategy.name}” now uses ${registrationNumber}`,
    );
  }
  await setStrategyEntry(tx, strategy.id, entryId);
}

/**
 * After a Library-side link change: the newly linked strategy adopts the
 * record, and the strategy it used to name has no record until its next save
 * (when one is created for it, ADR 0054).
 */
async function syncStrategySide(
  tx: Transaction,
  actorId: string,
  row: EntryRow,
  strategyId: string | null,
): Promise<void> {
  if (row.builtStrategyId && row.builtStrategyId !== strategyId) {
    await tx
      .update(strategies)
      .set({ libraryEntryId: null })
      .where(and(eq(strategies.id, row.builtStrategyId), eq(strategies.libraryEntryId, row.id)));
  }
  if (strategyId) {
    const s = await strategyLinkRow(tx, strategyId);
    if (s) await adoptStrategy(tx, actorId, s, row.id, row.registrationNumber);
  }
}
