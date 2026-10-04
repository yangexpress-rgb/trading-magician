import { describe, expect, it } from 'vitest';
import { getIndicator, resolveIndicatorParams, checkIndicatorParams, INDICATORS } from './catalog';
import {
  canonicalJson,
  parseDefinition,
  safeParseDefinition,
  UnsupportedSchemaVersionError,
} from './serialize';
import { validDefinition } from './test-fixtures';

describe('canonical JSON', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('serialises equal definitions identically regardless of key order', () => {
    const def = validDefinition();
    const reordered = Object.fromEntries(Object.entries(def).reverse());
    expect(canonicalJson(reordered)).toBe(canonicalJson(def));
  });
});

describe('parsing stored definitions', () => {
  it('round-trips through JSON', () => {
    const def = validDefinition();
    expect(parseDefinition(JSON.parse(JSON.stringify(def)))).toEqual(def);
  });

  it('rejects versions it does not know', () => {
    expect(() => parseDefinition({ ...validDefinition(), schemaVersion: 99 })).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(() => parseDefinition({ ...validDefinition(), schemaVersion: 0 })).toThrow(
      UnsupportedSchemaVersionError,
    );
    expect(() => parseDefinition({})).toThrow(UnsupportedSchemaVersionError);
    expect(() => parseDefinition(null)).toThrow(TypeError);
  });

  it('reports failures without throwing from the safe variant', () => {
    expect(safeParseDefinition({ schemaVersion: 1 }).success).toBe(false);
    expect(safeParseDefinition(validDefinition()).success).toBe(true);
  });
});

describe('indicator catalog', () => {
  it('has unique names and valid defaults', () => {
    expect(new Set(INDICATORS.map((i) => i.name)).size).toBe(INDICATORS.length);
    for (const spec of INDICATORS) {
      const params = resolveIndicatorParams(spec, {});
      expect(checkIndicatorParams(spec, params), spec.name).toEqual([]);
      expect(spec.lookback(params)).toBeGreaterThan(0);
    }
  });

  it('reports bad and unknown parameters', () => {
    const rsi = getIndicator('RSI')!;
    expect(checkIndicatorParams(rsi, { period: 2.5 })).toEqual(['Period must be a whole number']);
    expect(checkIndicatorParams(rsi, { period: 14, extra: 1 })).toEqual([
      'RSI has no parameter "extra"',
    ]);
    expect(checkIndicatorParams(rsi, {})).toEqual(['Period is required for RSI']);
  });
});
