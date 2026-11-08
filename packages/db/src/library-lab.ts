import {
  AUTO_CREATED_NOTE,
  AUTO_CREATED_TAG,
  autoCreatedRecord,
  collectInstrumentUses,
  isFixtureName,
  parseDefinition,
  parseRegistrationNumber,
  type LabAssetClass,
} from '@tm/domain';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Transaction } from './client';
import {
  builtElsewhereMessage,
  LibraryError,
  registerLibraryEntry,
  setEntryBuilt,
  setStrategyEntry,
  strategyLinkRow,
} from './library';
import { matchSeedLinks } from './library-seed';
import {
  instruments,
  strategies,
  strategyLibraryEntries as entries,
  strategyLibraryRevisions as revisions,
} from './schema';

/**
 * Strategy Lab numbering (ADR 0054). Every Lab strategy is associated with
 * exactly one Strategy Library record and shows that record's number: linking
 * to an entry uses its number; a strategy saved with no link gets a record
 * created for it, and the next number from the shared counter, in the same
 * transaction as the save. Built status follows the association both ways.
 */

/** What the builder's "Library entry" picker sends with a save (brief D2, D5). */
export type LibraryChoice = { kind: 'entry'; registrationNumber: string } | { kind: 'new' };

export interface StrategyLibraryRecord {
  entryId: string;
  registrationNumber: string;
  name: string;
  status: 'registered' | 'retired';
  autoCreated: boolean;
}

/** The record a strategy shows, or null while it has none (a draft without instruments). */
export async function strategyLibraryRecord(
  tx: Transaction,
  entryId: string | null,
): Promise<StrategyLibraryRecord | null> {
  if (!entryId) return null;
  const [row] = await tx
    .select({
      entryId: entries.id,
      registrationNumber: entries.registrationNumber,
      name: entries.name,
      status: entries.status,
      tags: entries.tags,
    })
    .from(entries)
    .where(eq(entries.id, entryId));
  if (!row) return null;
  return {
    entryId: row.entryId,
    registrationNumber: row.registrationNumber,
    name: row.name,
    status: row.status as 'registered' | 'retired',
    autoCreated: row.tags.includes(AUTO_CREATED_TAG),
  };
}

/** Numbers for many strategies at once (the Strategy Lab list). */
export async function libraryNumbers(
  tx: Transaction,
  entryIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(entryIds)];
  if (!ids.length) return new Map();
  const rows = await tx
    .select({ id: entries.id, n: entries.registrationNumber })
    .from(entries)
    .where(inArray(entries.id, ids));
  return new Map(rows.map((r) => [r.id, r.n]));
}

type StrategyRow = NonNullable<Awaited<ReturnType<typeof strategyLinkRow>>>;

/**
 * Links the strategy to entry `registrationNumber` (D2): the strategy takes
 * its number and the entry shows Built. Its previous record goes back to Not
 * built and keeps its number. No number is consumed. Refused (D6) for a
 * retired entry and for one another strategy builds.
 */
export async function linkStrategyToEntry(
  tx: Transaction,
  actorId: string,
  strategyId: string,
  registrationNumber: string,
): Promise<void> {
  const strategy = await requireStrategy(tx, strategyId);
  const number = registrationNumber.trim().toUpperCase();
  const [entry] = parseRegistrationNumber(number)
    ? await tx.select().from(entries).where(eq(entries.registrationNumber, number))
    : [];
  if (!entry) throw new LibraryError('not_found', `No Library entry is registered as ${number}`);
  if (entry.id === strategy.libraryEntryId) return;
  if (entry.status === 'retired') {
    throw new LibraryError(
      'invalid_state',
      `${entry.registrationNumber} is retired — pick another entry or a new Library record`,
    );
  }
  const elsewhere = await builtElsewhereMessage(tx, actorId, entry, strategy.id);
  if (elsewhere) throw new LibraryError('invalid_state', elsewhere);

  if (strategy.libraryEntryId) {
    await setEntryBuilt(
      tx,
      actorId,
      strategy.libraryEntryId,
      null,
      `Unlinked: the Strategy Lab strategy “${strategy.name}” now uses ${entry.registrationNumber}`,
    );
  }
  await setEntryBuilt(
    tx,
    actorId,
    entry.id,
    strategy.id,
    `Linked to the Strategy Lab strategy “${strategy.name}”`,
  );
  await setStrategyEntry(tx, strategy.id, entry.id);
}

async function requireStrategy(tx: Transaction, strategyId: string): Promise<StrategyRow> {
  const s = await strategyLinkRow(tx, strategyId);
  if (!s) throw new LibraryError('not_found', 'Strategy not found');
  return s;
}

/**
 * Creates the strategy's own record (D3, D4) and links it, in this
 * transaction. Null, and nothing issued, while the draft has no Entry leg
 * with an instrument.
 */
export async function autoCreateLibraryRecord(
  tx: Transaction,
  actorId: string,
  strategyId: string,
): Promise<{ registrationNumber: string } | null> {
  const [row] = await tx
    .select({
      id: strategies.id,
      name: strategies.name,
      description: strategies.description,
      draft: strategies.draftDefinition,
    })
    .from(strategies)
    .where(and(eq(strategies.id, strategyId), isNull(strategies.deletedAt)));
  if (!row) return null;
  const definition = parseDefinition(row.draft);
  const ids = [
    ...new Set([
      ...collectInstrumentUses(definition).map((u) => u.instrumentId),
      ...(definition.entry.selection?.universe.type === 'list'
        ? definition.entry.selection.universe.instrumentIds
        : []),
    ]),
  ];
  const known = ids.length
    ? await tx
        .select({
          id: instruments.id,
          symbol: instruments.symbol,
          assetClass: instruments.assetClass,
        })
        .from(instruments)
        .where(inArray(instruments.id, ids))
    : [];
  const byId = new Map(known.map((i) => [i.id, i]));
  const record = autoCreatedRecord({
    strategyId: row.id,
    name: row.name,
    description: row.description,
    definition,
    symbol: (id) => byId.get(id)?.symbol,
    classOf: (id) => byId.get(id)?.assetClass as LabAssetClass | undefined,
  });
  if (!record) return null;
  // Registering with the strategy as its built link also points the strategy at it.
  const issued = await registerLibraryEntry(tx, actorId, record);
  await tx.insert(revisions).values({
    entryId: issued.id,
    action: 'create',
    note: `${AUTO_CREATED_NOTE} for “${row.name}” — complete the record in the Library`.slice(
      0,
      500,
    ),
    changedFields: [],
    editedBy: actorId,
  });
  return { registrationNumber: issued.registrationNumber };
}

/**
 * Runs after every save of a strategy (create, edit, copy). With a choice
 * from the picker it links or starts a new record; with none, a strategy
 * that has no record yet gets one (D3), unless it is a test fixture (O74).
 */
export async function applyLibraryChoice(
  tx: Transaction,
  actorId: string,
  strategyId: string,
  choice: LibraryChoice | undefined,
): Promise<void> {
  if (choice?.kind === 'entry') {
    await linkStrategyToEntry(tx, actorId, strategyId, choice.registrationNumber);
    return;
  }
  const strategy = await requireStrategy(tx, strategyId);
  if (choice?.kind === 'new') {
    if (strategy.libraryEntryId) {
      await setEntryBuilt(
        tx,
        actorId,
        strategy.libraryEntryId,
        null,
        `Unlinked: the Strategy Lab strategy “${strategy.name}” moved to a new Library record`,
      );
      await setStrategyEntry(tx, strategy.id, null);
    }
    await autoCreateLibraryRecord(tx, actorId, strategy.id);
    return;
  }
  if (strategy.libraryEntryId || isFixtureName(strategy.name)) return;
  await autoCreateLibraryRecord(tx, actorId, strategy.id);
}

/** Deleting a Lab strategy unlinks it (D8): the record stays, Not built, with its number. */
export async function unlinkDeletedStrategy(
  tx: Transaction,
  actorId: string,
  strategy: { id: string; name: string; libraryEntryId: string | null },
): Promise<void> {
  if (!strategy.libraryEntryId) return;
  await setEntryBuiltIfStrategy(
    tx,
    actorId,
    strategy.libraryEntryId,
    strategy.id,
    `Unlinked: the Strategy Lab strategy “${strategy.name}” was deleted`,
  );
}

async function setEntryBuiltIfStrategy(
  tx: Transaction,
  actorId: string,
  entryId: string,
  strategyId: string,
  note: string,
) {
  const [row] = await tx
    .select({ built: entries.builtStrategyId })
    .from(entries)
    .where(eq(entries.id, entryId));
  if (row?.built === strategyId) await setEntryBuilt(tx, actorId, entryId, null, note);
}

/** An account deletion unlinks every record its strategies built (they read Not built). */
export async function unlinkAccountStrategies(tx: Transaction, actorId: string): Promise<number> {
  const linked = await tx
    .select({ id: entries.id, strategyId: entries.builtStrategyId })
    .from(entries)
    .where(eq(entries.builtStrategyOwner, actorId));
  for (const e of linked) {
    await setEntryBuilt(tx, actorId, e.id, null, 'Unlinked: the account that built it was deleted');
  }
  return linked.length;
}

export interface SeedBackfillRow {
  registrationNumber: string;
  name: string;
  outcome:
    | { kind: 'linked' | 'would_link'; strategyId: string; strategyName: string }
    | { kind: 'already_linked'; strategyName: string | null }
    | { kind: 'retired' }
    | { kind: 'ambiguous'; candidates: string[] }
    | { kind: 'none' };
}

/**
 * The backfill (brief D9): links the built seed entries to the actor's
 * strategies by name with `matchSeedLinks` (clear one-to-one matches only;
 * ambiguous ones are listed for linking by hand). Test fixtures are left out
 * (O74). Each strategy then shows its seed number; a record it was given
 * before goes back to Not built and keeps its number. Nothing else is
 * backfilled: every other strategy gets its record on its next save.
 */
export async function backfillSeedLinks(
  tx: Transaction,
  actorId: string,
  options: { apply: boolean },
): Promise<SeedBackfillRow[]> {
  const workspace = (
    await tx
      .select({ id: strategies.id, name: strategies.name })
      .from(strategies)
      // Explicit as well as RLS: the operator script runs on the owner connection.
      .where(and(eq(strategies.userId, actorId), isNull(strategies.deletedAt)))
  ).filter((s) => !isFixtureName(s.name));
  const out: SeedBackfillRow[] = [];
  for (const m of matchSeedLinks(workspace)) {
    const [entry] = await tx
      .select({
        built: entries.builtStrategyId,
        owner: entries.builtStrategyOwner,
        status: entries.status,
      })
      .from(entries)
      .where(eq(entries.registrationNumber, m.registrationNumber));
    const base = { registrationNumber: m.registrationNumber, name: m.name };
    if (entry?.status === 'retired') {
      out.push({ ...base, outcome: { kind: 'retired' } });
      continue;
    }
    if (entry?.built) {
      const mine = entry.owner === actorId ? await strategyLinkRow(tx, entry.built) : null;
      out.push({ ...base, outcome: { kind: 'already_linked', strategyName: mine?.name ?? null } });
      continue;
    }
    if (m.result.kind !== 'match') {
      out.push({ ...base, outcome: m.result });
      continue;
    }
    if (options.apply) {
      await linkStrategyToEntry(tx, actorId, m.result.strategyId, m.registrationNumber);
    }
    out.push({
      ...base,
      outcome: {
        kind: options.apply ? 'linked' : 'would_link',
        strategyId: m.result.strategyId,
        strategyName: m.result.strategyName,
      },
    });
  }
  return out;
}
