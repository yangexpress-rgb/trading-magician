import { describe, expect, it } from 'vitest';
import type { WorkingOrder } from '@tm/db';
import { pendingEntryGross } from './runtime';

const order = (phase: string, quantity: string, filled: string, ref: string) =>
  ({
    intent: { phase, quantity, referencePrice: ref },
    filledQuantity: filled,
  }) as unknown as WorkingOrder;

describe('pendingEntryGross (N278)', () => {
  it('counts the unfilled part of working Entry orders at their reference prices', () => {
    const total = pendingEntryGross([
      order('entry', '26', '0', '191.92'),
      order('entry', '15', '10', '300'),
      order('exit', '50', '0', '100'),
    ]);
    expect(total.toFixed(2)).toBe((26 * 191.92 + 5 * 300).toFixed(2));
  });
});
