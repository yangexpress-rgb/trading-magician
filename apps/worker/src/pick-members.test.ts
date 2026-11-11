import { describe, expect, it } from 'vitest';
import { pickMembers } from './backtests';

const symbols: Record<string, string> = { a: 'AAPL', m: 'MSFT', n: 'NVDA' };
const symbolOf = (id: string) => symbols[id];

describe('pickMembers (N235)', () => {
  it("keeps the picked members in the group's order", () => {
    expect(pickMembers(['a', 'm', 'n'], ['nvda', 'AAPL'], symbolOf)).toEqual({
      members: ['a', 'n'],
    });
  });

  it('names picks that left the group since', () => {
    expect(pickMembers(['a', 'm'], ['AAPL', 'TSLA'], symbolOf)).toEqual({
      members: ['a'],
      warning: 'This pick is no longer in the group and was left out: TSLA',
    });
  });

  it('says so when no pick is left', () => {
    expect(pickMembers(['a'], ['TSLA', 'F'], symbolOf)).toEqual({
      members: [],
      warning: 'None of the instruments picked for this back test are in the group now: TSLA, F',
    });
  });
});
