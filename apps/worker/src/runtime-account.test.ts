import { describe, expect, it } from 'vitest';
import { crossAccountRefusal } from './runtime';

describe('cross-account safety (A6, N310)', () => {
  it("sends an order only to its own run's account", () => {
    expect(crossAccountRefusal('acct-1', 'acct-1')).toBeNull();
    expect(crossAccountRefusal('acct-1', 'acct-2')).toMatch(/Refused before sending/);
  });
});
