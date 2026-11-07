import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import type { BacktestResult } from './results';

/**
 * JSON encoding for the regression corpus (corpus.test.ts): Decimals, Maps
 * and Sets survive a round trip, so a recorded back-test input replays
 * exactly. Test-only.
 */
export function encode(value: unknown): unknown {
  if (Decimal.isDecimal(value)) return { $d: (value as Decimal).toString() };
  if (value instanceof Map) return { $m: [...value].map(([k, v]) => [encode(k), encode(v)]) };
  if (value instanceof Set) return { $s: [...value].map(encode) };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, encode(v)]),
    );
  return value;
}

export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('$d' in o) return new Decimal(o.$d as string);
    if ('$m' in o)
      return new Map((o.$m as [unknown, unknown][]).map(([k, v]) => [decode(k), decode(v)]));
    if ('$s' in o) return new Set((o.$s as unknown[]).map(decode));
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

/**
 * A result's behaviour: everything a back test decided and produced, leaving
 * out the copies of the definition the condition reports carry (the condition
 * tree and trigger settings), whose representation the schema migrations change.
 */
export function behaviour(r: BacktestResult): string {
  const strip = (p: { condition?: unknown; trigger?: unknown }) => {
    const { condition: _c, trigger: _t, ...rest } = p;
    void _c;
    void _t;
    return rest;
  };
  const picked = {
    ...r,
    conditions: { entry: strip(r.conditions.entry), exit: strip(r.conditions.exit) },
    groupConditions: r.groupConditions?.map((g) => ({
      ...g,
      entry: strip(g.entry),
      exit: strip(g.exit),
    })),
  };
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 16);
}
