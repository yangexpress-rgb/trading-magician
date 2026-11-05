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
const MIGRATIONS: Record<number, Migration> = {};

/** Parses a stored or submitted definition, migrating older schema versions first. */
export function parseDefinition(input: unknown): StrategyDefinition {
  if (!input || typeof input !== 'object')
    throw new TypeError('A strategy definition must be an object');
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
