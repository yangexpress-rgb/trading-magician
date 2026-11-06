import { describe, expect, it } from 'vitest';
import { pickLegAccount, type LegAccountCandidate } from './leg-accounts';

const builtIn: LegAccountCandidate = {
  id: 'builtin',
  nickname: 'Paper account',
  provider: 'demo',
  mode: 'paper',
  isDefault: true,
};
const alpaca: LegAccountCandidate = {
  id: 'alpaca',
  nickname: 'Alpaca paper ••••0042',
  provider: 'alpaca',
  mode: 'paper',
  isDefault: false,
};

describe('the account a new leg starts on', () => {
  it('is the Alpaca paper account when there is one, even if the built-in one is default', () => {
    expect(pickLegAccount([builtIn, alpaca])).toBe('alpaca');
  });

  it('prefers the real paper account marked default', () => {
    const other = { ...alpaca, id: 'alpaca-2', nickname: 'Alpaca 2', isDefault: true };
    expect(pickLegAccount([builtIn, alpaca, other])).toBe('alpaca-2');
  });

  it('falls back to the built-in paper account without a real one', () => {
    expect(pickLegAccount([builtIn])).toBe('builtin');
  });

  it('never picks a live account', () => {
    expect(pickLegAccount([builtIn, { ...alpaca, mode: 'live' }])).toBe('builtin');
    expect(pickLegAccount([{ ...alpaca, mode: 'live' }])).toBeNull();
  });
});
