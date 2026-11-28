import { describe, expect, it } from 'vitest';
import { stateTotals } from './machine-report';

describe('stateTotals (state-machine brief v1.4 §2.6)', () => {
  it('sums sessions and compounds returns per state', () => {
    const rows = stateTotals([
      {
        stateId: 'A',
        from: '2025-01-02',
        to: '2025-01-10',
        sessions: 6,
        returnPct: '10',
        ongoing: false,
      },
      {
        stateId: 'B',
        from: '2025-01-13',
        to: '2025-01-14',
        sessions: 2,
        returnPct: '-5',
        ongoing: false,
      },
      {
        stateId: 'A',
        from: '2025-01-15',
        to: '2025-01-16',
        sessions: 2,
        returnPct: '10',
        ongoing: true,
      },
    ]);
    expect(rows).toEqual([
      { stateId: 'A', stays: 2, sessions: 8, sharePct: 80, returnPct: '21.00', pnl: null },
      { stateId: 'B', stays: 1, sessions: 2, sharePct: 20, returnPct: '-5.00', pnl: null },
    ]);
  });

  it('adds paper P/L in dollars when a stay has no return (O269)', () => {
    const rows = stateTotals([
      {
        stateId: 'A',
        from: '2026-11-02',
        to: '2026-11-03',
        sessions: 2,
        returnPct: null,
        pnl: '12.50',
        ongoing: false,
      },
      {
        stateId: 'A',
        from: '2026-11-05',
        to: '2026-11-06',
        sessions: 2,
        returnPct: null,
        pnl: '-2.25',
        ongoing: true,
      },
    ]);
    expect(rows[0]).toMatchObject({ returnPct: null, pnl: '10.25', sessions: 4 });
  });
});
