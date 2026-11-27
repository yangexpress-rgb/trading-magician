import { migrateV1 } from './migrate-v1';
import { migrateV2 } from './migrate-v2';
import { migrateV3 } from './migrate-v3';
import { migrateV4 } from './migrate-v4';
import { migrateV5 } from './migrate-v5';
import {
  MACHINE_FORM,
  MACHINE_SCHEMA_VERSION,
  machineDefinitionSchema,
  type MachineDefinition,
} from './machine-schema';
import {
  STRATEGY_SCHEMA_VERSION,
  strategyDefinitionSchema,
  type StrategyDefinition,
} from './schema';

/**
 * JSON with object keys sorted at every level, so equal definitions always
 * serialise identically. Used to hash versions and detect "changed since the
 * last back test".
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(public readonly version: unknown) {
    super(`Unsupported strategy schema version: ${String(version)}`);
    this.name = 'UnsupportedSchemaVersionError';
  }
}

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/** schemaVersion N → N+1. Stored versions are never rewritten; they are migrated on read. */
const MIGRATIONS: Record<number, Migration> = {
  // The Strategy Lab simplification (ADR 0049).
  1: (doc) => migrateV1(doc).doc,
  // What to trade, Entry, Exit (ADR 0073).
  2: (doc) => migrateV2(doc).doc,
  // The trailing stop moves into Exit when (ADR 0074).
  3: (doc) => migrateV3(doc).doc,
  // The holding-period, ATR and expected-move exits move into Exit when (ADR 0076).
  4: (doc) => migrateV4(doc).doc,
  // The strategy trailing stop risk limit, 1% on existing strategies (ADR 0099).
  5: (doc) => migrateV5(doc).doc,
};

/**
 * A state-machine document was given where a rules-form definition is read
 * (ADR 0124). Readers of Entry and Exit never see the other form.
 */
export class NotRulesDefinitionError extends Error {
  constructor() {
    super('This is a state-machine strategy, not a rules strategy');
    this.name = 'NotRulesDefinitionError';
  }
}

/** Which form a stored or submitted definition is (ADR 0124): only state machines say. */
export function definitionForm(input: unknown): 'rules' | typeof MACHINE_FORM {
  return input && typeof input === 'object' && (input as { form?: unknown }).form === MACHINE_FORM
    ? MACHINE_FORM
    : 'rules';
}

/** Parses a stored or submitted definition, migrating older schema versions first. */
export function parseDefinition(input: unknown): StrategyDefinition {
  if (!input || typeof input !== 'object')
    throw new TypeError('A strategy definition must be an object');
  if (definitionForm(input) === MACHINE_FORM) throw new NotRulesDefinitionError();
  let doc = input as Record<string, unknown>;
  let version = doc.schemaVersion;
  while (typeof version === 'number' && version < STRATEGY_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new UnsupportedSchemaVersionError(version);
    doc = migrate(doc);
    version = doc.schemaVersion;
  }
  if (version !== STRATEGY_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
  return strategyDefinitionSchema.parse(doc);
}

export function safeParseDefinition(input: unknown) {
  try {
    return { success: true as const, data: parseDefinition(input) };
  } catch (error) {
    return { success: false as const, error };
  }
}

/**
 * Parses a state-machine definition (ADR 0124). It never passes through the
 * rules form's migrations: a later rules-form schema change leaves it as it is.
 */
export function parseMachineDefinition(input: unknown): MachineDefinition {
  if (!input || typeof input !== 'object')
    throw new TypeError('A strategy definition must be an object');
  const version = (input as { machineVersion?: unknown }).machineVersion;
  if (version !== MACHINE_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
  return machineDefinitionSchema.parse(input);
}

export type AnyDefinition =
  | { form: 'rules'; definition: StrategyDefinition }
  | { form: typeof MACHINE_FORM; definition: MachineDefinition };

/** Either form, for the places that parse, store and list definitions (brief v1.3 §2.5). */
export function parseAnyDefinition(input: unknown): AnyDefinition {
  return definitionForm(input) === MACHINE_FORM
    ? { form: MACHINE_FORM, definition: parseMachineDefinition(input) }
    : { form: 'rules', definition: parseDefinition(input) };
}
