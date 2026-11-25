import { UnsupportedBarRequestError } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decodeBars, encodeBars, FETCH_REQUESTS } from './companion-fetch';

describe('companion data answers (ADR 0118)', () => {
  it('carries bars exactly, and says which failures are unsupported requests', () => {
    const bar = {
      start: '2026-01-02T14:30:00.000Z',
      end: '2026-01-02T21:00:00.000Z',
      open: new Decimal('101.2345'),
      high: new Decimal('0.1').plus('0.2'),
      low: new Decimal('99'),
      close: new Decimal('100.00001'),
      volume: new Decimal('123456789'),
    };
    const wire = JSON.parse(
      JSON.stringify(
        encodeBars([
          { bars: [bar], dataVersion: 'v1', warnings: ['w'] },
          new UnsupportedBarRequestError('no 4h bars'),
          new Error('feed down'),
        ]),
      ),
    );
    const [series, unsupported, failed] = decodeBars(wire);
    expect(series).toEqual({ bars: [bar], dataVersion: 'v1', warnings: ['w'] });
    expect(unsupported).toBeInstanceOf(UnsupportedBarRequestError);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(UnsupportedBarRequestError);
    expect((failed as Error).message).toBe('feed down');
  });

  it('refuses oversized or malformed requests', () => {
    const r = {
      instrumentId: '00000000-0000-4000-8000-000000000001',
      symbol: 'AAPL',
      assetClass: 'stock',
      interval: '1d',
      from: '2020-01-01',
      to: '2020-12-31',
      adjustment: 'split_and_dividend',
      session: 'regular',
    };
    expect(FETCH_REQUESTS.bars.safeParse({ requests: [r] }).success).toBe(true);
    expect(FETCH_REQUESTS.bars.safeParse({ requests: Array(201).fill(r) }).success).toBe(false);
    expect(FETCH_REQUESTS.bars.safeParse({ requests: [{ ...r, interval: '2d' }] }).success).toBe(
      false,
    );
    expect(FETCH_REQUESTS.events.safeParse({ ids: ['not-a-uuid'] }).success).toBe(false);
  });
});
