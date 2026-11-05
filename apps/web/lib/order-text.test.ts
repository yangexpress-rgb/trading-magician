import { describe, expect, it } from 'vitest';
import { describeEvent, describeHolding, formatPrice } from './order-text';

const event = (kind: string, detail: Record<string, unknown>, toState: 'filled' | null = null) => ({
  seq: 1,
  source: 'broker',
  fromState: null,
  toState,
  kind,
  detail,
  providerAt: null,
  receivedAt: '2026-10-06T14:31:00Z',
});

describe('order timeline text', () => {
  it('describes risk checks, broker updates and manual cancels', () => {
    expect(describeEvent(event('risk_check', { risk: { ok: true } }))).toBe('Risk check passed');
    expect(
      describeEvent({
        ...event('risk_check', { risk: { ok: false, code: 'risk_collar' } }),
        toState: 'rejected',
      }),
    ).toBe('Risk check failed: Price collar');
    expect(
      describeEvent(
        event('broker_update', {
          update: { kind: 'fill', fill: { quantity: '10', price: '101.5' } },
        }),
      ),
    ).toBe('Filled 10 at 101.50');
    expect(describeEvent(event('cancel_requested', { reason: 'Canceled by you' }))).toBe(
      'Cancel requested (Canceled by you)',
    );
    expect(describeEvent(event('something_new', {}, 'filled'))).toBe('Now filled');
  });

  it('names holdings and prices without relying on colour or sign alone', () => {
    expect(describeHolding('10')).toBe('Long 10');
    expect(describeHolding('-5')).toBe('Short 5');
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice('99.12345')).toBe('99.1235');
  });
});
