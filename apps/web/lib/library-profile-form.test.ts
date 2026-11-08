import { describe, expect, it } from 'vitest';
import {
  clearedProfileFields,
  loadProfileDraft,
  profileToRecord,
  unloadedProfileFields,
} from './library-profile-form';

/** S00005-SD as stored, with every other profile field set too. */
const stored = {
  direction: 'long_only' as const,
  parameters: [
    { name: 'Entry channel', value: '20', unit: 'days' },
    { name: 'Exit channel', value: '10', unit: 'days' },
  ],
  positionSizing: { method: 'pct_equity' as const, detail: '100% of equity' },
  stopLoss: { method: 'condition_based' as const },
  rebalanceSchedule: { schedule: 'daily_close' as const, detail: 'At the close' },
  maturity: 'backtested' as const,
  keyRisks: 'Whipsaw in ranges.',
  dataNeeds: ['daily_bars' as const],
  universe: { kind: 'single_instrument' as const, detail: 'SPY' },
};

describe('Library edit form: loading the stored profile', () => {
  it('opens with exactly the stored parameters, in stored order', () => {
    const d = loadProfileDraft(stored as never);
    expect(d.parameters).toEqual([
      { name: 'Entry channel', value: '20', unit: 'days' },
      { name: 'Exit channel', value: '10', unit: 'days' },
    ]);
  });

  it('loads every other profile field from the stored entry', () => {
    const d = loadProfileDraft(stored as never);
    expect(d).toMatchObject({
      direction: 'long_only',
      sizing: { choice: 'pct_equity', detail: '100% of equity' },
      stop: { choice: 'condition_based', detail: '' },
      schedule: { choice: 'daily_close', detail: 'At the close' },
      universe: { choice: 'single_instrument', detail: 'SPY' },
      maturity: 'backtested',
      keyRisks: 'Whipsaw in ranges.',
      dataNeeds: ['daily_bars'],
    });
    expect(unloadedProfileFields(stored as never, d)).toEqual([]);
  });

  it('leaves genuinely empty fields empty', () => {
    const d = loadProfileDraft({
      direction: null,
      parameters: [],
      positionSizing: null,
      stopLoss: null,
      rebalanceSchedule: null,
      maturity: 'researched',
      keyRisks: null,
      dataNeeds: [],
      universe: null,
    });
    expect(d.parameters).toEqual([]);
    expect(d.direction).toBe('');
    expect(d.sizing).toEqual({ choice: 'unspecified', detail: '' });
  });

  it('loads a parameter stored with a number value or no unit', () => {
    const d = loadProfileDraft({ parameters: [{ name: 'Lookback', value: 20 }] } as never);
    expect(d.parameters).toEqual([{ name: 'Lookback', value: '20', unit: '' }]);
  });

  it('an untouched form sends back exactly what is stored', () => {
    const d = loadProfileDraft(stored as never);
    expect(profileToRecord(d, stored as never)).toEqual(stored);
  });
});

describe('Library edit form: saving never wipes what did not load', () => {
  it('names parameters as unloaded when the form opened with none but the entry has two', () => {
    const empty = { ...loadProfileDraft(stored as never), parameters: [] };
    expect(unloadedProfileFields(stored as never, empty)).toEqual(['parameters']);
    // And they do not count as cleared on purpose, so the server refuses too.
    expect(clearedProfileFields(stored as never, empty, empty)).toEqual([]);
  });

  it('marks parameters as cleared only when the editor removed loaded ones', () => {
    const loaded = loadProfileDraft(stored as never);
    const now = { ...loaded, parameters: [] };
    expect(clearedProfileFields(stored as never, loaded, now)).toEqual(['parameters']);
    expect(clearedProfileFields(stored as never, loaded, loaded)).toEqual([]);
  });
});
