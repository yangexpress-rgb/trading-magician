import type { BacktestRunSummary, BacktestTradeRow } from '@tm/db';
import { describe, expect, it } from 'vitest';
import { csvCell, tradesCsv } from './backtest-csv';

describe('back-test CSV', () => {
  it('quotes and defuses cells', () => {
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 Buy')).toBe("'+1 Buy");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });

  it('writes one row per leg with the run provenance', () => {
    const run = {
      versionNo: 3,
      engineVersion: 'engine@1',
      dataVersions: ['demo-history@1'],
    } as BacktestRunSummary;
    const trades: BacktestTradeRow[] = [
      {
        cycle: 1,
        status: 'closed',
        entryTime: new Date('2024-01-03T14:30:00Z'),
        exitTime: new Date('2024-01-05T14:30:00Z'),
        grossPnl: '10',
        costs: '1',
        netPnl: '9',
        returnPct: '0.9',
        legs: [
          {
            legId: 'b',
            legLabel: 'Buy A',
            phase: 'entry',
            instrumentId: 'i',
            symbol: 'DEMO-A',
            side: 'buy',
            quantity: '10',
            averagePrice: '100',
          },
          {
            legId: 's',
            legLabel: 'Sell A',
            phase: 'exit',
            instrumentId: 'i',
            symbol: 'DEMO-A',
            side: 'sell',
            quantity: '10',
            averagePrice: '101',
          },
        ],
      },
      {
        cycle: 2,
        status: 'aborted',
        entryTime: null,
        exitTime: null,
        grossPnl: '0',
        costs: '0',
        netPnl: '0',
        returnPct: null,
        legs: [],
      },
    ];
    const lines = tradesCsv(run, trades).trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      '1,closed,2024-01-03T14:30:00.000Z,2024-01-05T14:30:00.000Z,Buy A,entry,DEMO-A,buy,10,100,10,1,9,0.9,3,engine@1,demo-history@1,',
    );
    expect(lines[3]).toBe('2,aborted,,,,,,,,,0,0,0,,3,engine@1,demo-history@1,');
  });
});
