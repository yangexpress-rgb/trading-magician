import { describe, expect, it } from 'vitest';
import type { StrategyDefinition } from './schema';
import {
  CAPS,
  comparison,
  constant,
  context,
  indicator,
  market,
  order,
  OTHER_ACCOUNT,
  PAPER_ACCOUNT,
  position,
  STOCK_A,
  STOCK_B,
  UNKNOWN_INSTRUMENT,
  validDefinition,
} from './test-fixtures';
import { CONTEXT_INSTRUMENT_ID } from './evaluate';
import { validateStrategy, type ValidationContext } from './validate';

function check(edit: (def: StrategyDefinition) => void, ctx: ValidationContext = context()) {
  const def = validDefinition();
  edit(def);
  const { errors, warnings } = validateStrategy(def, ctx);
  return {
    errors: errors.map((e) => e.code),
    warnings: warnings.map((w) => w.code),
    raw: { errors, warnings },
  };
}

describe('a complete strategy', () => {
  it('has no errors or warnings', () => {
    expect(check(() => undefined)).toMatchObject({ errors: [], warnings: [] });
  });
});

describe('per-leg conditions without a shared Entry condition (v1.2 item 2)', () => {
  const ret12 = (id: string, instrumentId: string) => ({
    kind: 'metric' as const,
    id,
    metric: 'return',
    params: { lookbackMonths: '12', skipMonths: '0' },
    instrumentId,
  });
  const legsOnly = (d: StrategyDefinition, withLegConditions: boolean) => {
    d.entry.condition.children = [];
    d.entry.orders = [STOCK_A, STOCK_B].map((id, i) => {
      const leg = order(`buy-${i}`, { instrumentId: id });
      if (!withLegConditions) return leg;
      return {
        ...leg,
        legCondition: {
          kind: 'group' as const,
          id: `lg-${i}`,
          op: 'and' as const,
          negate: false,
          children: [
            comparison(
              `beats-${i}`,
              ret12(`own-${i}`, CONTEXT_INSTRUMENT_ID),
              'gt',
              ret12(`other-${i}`, i ? STOCK_A : STOCK_B),
            ),
          ],
        },
      };
    });
    d.exit.orders = [STOCK_A, STOCK_B].map((id, i) =>
      order(`sell-${i}`, { instrumentId: id, side: 'close' }),
    );
  };

  it('needs no shared Entry condition when the legs carry their own', () => {
    for (const schedule of [undefined, 'monthEnd'] as const) {
      const { errors } = check((d) => {
        legsOnly(d, true);
        if (schedule) d.schedule = { frequency: schedule };
      });
      expect(errors).toEqual([]);
    }
  });

  it('still asks for an Entry condition when no leg has one', () => {
    expect(check((d) => legsOnly(d, false)).errors).toContain('empty_condition');
  });
});

describe('structure', () => {
  it('requires a condition and an order in each phase', () => {
    const { errors } = check((d) => {
      d.entry.condition.children = [];
      d.exit.orders = [];
    });
    expect(errors).toEqual(['empty_condition', 'no_orders']);
  });

  it('allows an empty condition when every leg is timing-only', () => {
    const { errors } = check((d) => {
      d.exit.condition.children = [];
      d.exit.orders[0]!.timingOnly = true;
      d.exit.orders[0]!.timing = {
        mode: 'relative',
        amount: 1,
        unit: 'd',
        reference: { kind: 'phase', event: 'position_opened' },
      };
    });
    expect(errors).toEqual([]);
  });

  it('flags empty sub-groups', () => {
    const { raw } = check((d) => {
      d.entry.condition.children.push({
        kind: 'group',
        id: 'empty',
        op: 'or',
        negate: false,
        children: [],
      });
    });
    expect(raw.errors).toMatchObject([
      { code: 'empty_group', nodeId: 'empty', path: ['entry', 'condition', 'children', 1] },
    ]);
  });

  it('rejects duplicate ids and leg names', () => {
    const { errors } = check((d) => {
      d.exit.orders.push(order('sell-a', { side: 'sell', legLabel: 'Buy-A ' }));
    });
    expect(errors).toEqual(['duplicate_id', 'duplicate_leg_label']);
  });

  it('limits nesting depth', () => {
    const { errors } = check((d) => {
      let g = d.entry.condition;
      for (let i = 0; i < 6; i++) {
        const child = {
          kind: 'group' as const,
          id: `deep${i}`,
          op: 'and' as const,
          negate: false,
          children: [] as never[],
        };
        g.children.push(child);
        g = child;
      }
      g.children.push(comparison('leaf', market('ml'), 'gt', constant('1')));
    });
    expect(errors).toEqual(['condition_too_deep']);
  });
});

describe('expressions', () => {
  it('requires a known instrument with a data feed', () => {
    expect(
      check((d) => {
        d.entry.condition.children = [
          comparison('c', market('m', { instrumentId: UNKNOWN_INSTRUMENT }), 'gt', constant('1')),
        ];
      }).errors,
    ).toEqual(['unknown_instrument']);

    const noQuotes = context({ hasFeed: (_cls, type) => type === 'bars' });
    expect(
      check((d) => {
        d.entry.condition.children = [
          comparison('c', market('m', { field: 'bid' }), 'gt', constant('1')),
        ];
      }, noQuotes).errors,
    ).toEqual(['missing_feed']);
  });

  it('checks indicators and their parameters', () => {
    const { errors } = check((d) => {
      d.entry.condition.children = [
        comparison('c', market('m'), 'gt', indicator('i', { name: 'MAGIC' })),
        comparison('d', market('m2'), 'gt', indicator('j', { params: { period: 0 } })),
        comparison(
          'e',
          market('m3'),
          'gt',
          indicator('k', { name: 'BBANDS', params: { period: 20, stdDev: 2, band: 'side' } }),
        ),
      ];
    });
    expect(errors).toEqual([
      'unknown_indicator',
      'invalid_indicator_params',
      'invalid_indicator_params',
    ]);
  });

  it('catches division by a zero constant', () => {
    const { errors } = check((d) => {
      d.exit.condition.children = [
        comparison(
          'c',
          { kind: 'calc', id: 'k', op: 'div', args: [market('m'), constant('0.0')] },
          'gt',
          constant('1'),
        ),
      ];
    });
    expect(errors).toEqual(['division_by_zero']);
  });

  it('warns about comparisons with no market data and rejects constant crossings', () => {
    const result = check((d) => {
      d.entry.condition.children = [
        comparison('c', constant('1'), 'lt', constant('2')),
        comparison('x', constant('1'), 'crosses_above', constant('2')),
        comparison('s', constant('1'), 'is_stale'),
      ];
    });
    expect(result.errors).toEqual(['cross_needs_market_data', 'state_needs_market_data']);
    expect(result.warnings).toEqual(['constant_comparison', 'constant_comparison']);
  });
});

describe('orders and accounts', () => {
  it('requires entry legs to open a position', () => {
    expect(check((d) => (d.entry.orders[0]!.side = 'sell')).errors).toContain(
      'entry_side_not_opening',
    );
  });

  it('requires a known paper account that is active', () => {
    expect(check((d) => (d.entry.orders[0]!.accountId = OTHER_ACCOUNT)).errors).toEqual([
      'missing_account',
    ]);

    const ctx = context();
    const accounts = new Map(ctx.accounts);
    accounts.set(OTHER_ACCOUNT, {
      nickname: 'Live',
      mode: 'live',
      isActive: false,
      capabilities: CAPS,
    });
    expect(
      check((d) => (d.entry.orders[0]!.accountId = OTHER_ACCOUNT), { ...ctx, accounts }).errors,
    ).toEqual(['live_account_not_allowed', 'account_inactive']);
  });

  it('checks account capabilities', () => {
    const ctx = context();
    const limited = {
      ...CAPS,
      orderTypes: ['market'],
      timeInForce: ['day'],
      shortSelling: false,
      extendedHours: false,
      assetClasses: ['etf'],
    };
    const accounts = new Map([
      [PAPER_ACCOUNT, { nickname: 'Basic', mode: 'paper', isActive: true, capabilities: limited }],
    ]);
    const { errors } = check(
      (d) => {
        Object.assign(d.entry.orders[0]!, {
          side: 'sell_short',
          orderType: 'limit',
          limitPrice: constant('100'),
          timeInForce: 'gtc',
          extendedHours: true,
        });
        d.exit.orders[0]!.side = 'buy_to_cover';
      },
      { ...ctx, accounts },
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'unsupported_asset_class',
        'unsupported_order_type',
        'unsupported_time_in_force',
        'short_selling_unsupported',
        'extended_hours_unsupported',
      ]),
    );
  });

  it('keeps demo instruments on demo accounts and real ones off them', () => {
    const base = context();
    const instruments = new Map([
      [STOCK_A, { symbol: 'DEMO-A', assetClass: 'stock', lotSize: '1', venue: 'DEMO' }],
      [STOCK_B, { symbol: 'REAL', assetClass: 'stock', lotSize: '1', venue: 'NASDAQ' }],
    ]);
    const account = (coverage: 'demo' | 'us') =>
      new Map([
        [
          PAPER_ACCOUNT,
          { nickname: 'Acct', mode: 'paper', isActive: true, capabilities: { ...CAPS, coverage } },
        ],
      ]);
    const onDemo = check(() => undefined, { ...base, instruments, accounts: account('demo') });
    expect(onDemo.errors).not.toContain('unsupported_venue');
    const onUs = check(() => undefined, { ...base, instruments, accounts: account('us') });
    expect(onUs.errors).toContain('unsupported_venue');
    const realOnDemo = check(
      (d) => {
        for (const o of [...d.entry.orders, ...d.exit.orders]) o.instrumentId = STOCK_B;
      },
      { ...base, instruments, accounts: account('demo') },
    );
    expect(realOnDemo.errors).toContain('unsupported_venue');
  });

  it('checks quantities', () => {
    expect(check((d) => (d.entry.orders[0]!.quantity.value = '2.5')).errors).toContain(
      'invalid_quantity',
    );
    expect(
      check(
        (d) =>
          (d.entry.orders[0]!.quantity = { type: 'pct_equity', value: '150', rounding: 'down' }),
      ).errors,
    ).toEqual(['invalid_quantity']);
    expect(
      check(
        (d) =>
          (d.entry.orders[0]!.quantity = { type: 'notional', value: '10000.01', rounding: 'down' }),
      ).errors,
    ).toEqual(['exceeds_max_order_notional']);
    expect(
      check(
        (d) =>
          (d.entry.orders[0]!.quantity = { type: 'risk_sized', value: '100', rounding: 'down' }),
      ).errors,
    ).toEqual(['risk_sizing_needs_stop']);
  });

  it('requires prices the order type needs', () => {
    expect(check((d) => (d.entry.orders[0]!.orderType = 'stop_limit')).errors).toEqual([
      'missing_limit_price',
      'missing_stop_price',
    ]);
    expect(check((d) => (d.entry.orders[0]!.limitPrice = constant('100'))).warnings).toEqual([
      'unused_limit_price',
    ]);
  });

  it('rejects an exact time that has passed', () => {
    const { errors } = check((d) => {
      d.entry.orders[0]!.timing = { mode: 'exact', at: '2026-10-05T13:59:00Z', zone: 'UTC' };
    });
    expect(errors).toEqual(['exact_time_in_past']);
  });

  it('warns about extended hours and non-atomic multi-leg orders', () => {
    const { warnings } = check((d) => {
      d.entry.orders[0]!.extendedHours = true;
      d.entry.orders.push(order('buy-b', { instrumentId: STOCK_B }));
    });
    expect(warnings).toEqual(['extended_hours', 'non_atomic_multi_leg']);
  });

  it('warns when "extended hours if supported" cannot send a leg early', () => {
    const market = check((d) => {
      d.execution.marketHoursPolicy = 'extended_if_supported';
    });
    // Both the Entry and the Exit leg are market orders.
    expect(market.warnings).toEqual(['extended_hours_policy_waits', 'extended_hours_policy_waits']);
    expect(market.raw.warnings[0]!.message).toMatch(/only day limit orders/);

    const dayLimit = check((d) => {
      d.execution.marketHoursPolicy = 'extended_if_supported';
      d.entry.orders[0]!.orderType = 'limit';
      d.entry.orders[0]!.limitPrice = constant('50');
      d.exit.orders[0]!.orderType = 'limit';
      d.exit.orders[0]!.limitPrice = constant('60');
    });
    expect(dayLimit.warnings).toEqual([]);

    const noExtended = context({
      accounts: new Map([
        [
          PAPER_ACCOUNT,
          {
            nickname: 'Paper',
            mode: 'paper',
            isActive: true,
            capabilities: { ...CAPS, extendedHours: false },
          },
        ],
      ]),
    });
    const demo = check((d) => {
      d.execution.marketHoursPolicy = 'extended_if_supported';
      d.entry.orders[0]!.orderType = 'limit';
      d.entry.orders[0]!.limitPrice = constant('50');
    }, noExtended);
    expect(demo.warnings).toContain('extended_hours_policy_waits');
    expect(demo.raw.warnings[0]!.message).toMatch(/doesn't trade extended hours/);
  });
});

describe('exit exposure', () => {
  it.each([
    ['buy', 'exit_opens_position'],
    ['sell_short', 'exit_opens_position'],
    ['buy_to_cover', 'exit_cover_without_short'],
  ] as const)('rejects an exit %s after a long entry', (side, code) => {
    expect(check((d) => (d.exit.orders[0]!.side = side)).errors).toEqual([code]);
  });

  it('rejects a sell after a short entry', () => {
    const { errors } = check((d) => (d.entry.orders[0]!.side = 'sell_short'));
    expect(errors).toEqual(['exit_sell_without_long']);
  });

  it('rejects closing an instrument Entry never opens', () => {
    expect(check((d) => (d.exit.orders[0]!.instrumentId = STOCK_B)).errors).toEqual([
      'exit_without_entry',
    ]);
  });

  it('rejects an exit larger than the entry', () => {
    expect(check((d) => (d.exit.orders[0]!.quantity.value = '11')).errors).toEqual([
      'exit_exceeds_position',
    ]);
    expect(check((d) => (d.exit.orders[0]!.side = 'close')).errors).toEqual([]);
  });
});

describe('execution and risk', () => {
  it('needs a leg order for sequential policies', () => {
    expect(check((d) => (d.execution.multiLegPolicy = 'sequential')).errors).toEqual([
      'invalid_leg_order',
    ]);
    expect(
      check((d) => {
        d.execution.multiLegPolicy = 'sequential';
        d.execution.legOrder = ['buy-a', 'sell-a'];
      }).errors,
    ).toEqual([]);
  });

  it('needs a cap for pyramiding', () => {
    expect(check((d) => (d.execution.reentry = { mode: 'pyramid' })).errors).toEqual([
      'pyramid_needs_cap',
    ]);
  });

  it('requires every confirmed risk limit', () => {
    const { raw } = check((d) => {
      delete d.risk.dailyLossLimit;
    });
    expect(raw.errors).toMatchObject([
      {
        code: 'missing_risk_limit',
        path: ['risk', 'dailyLossLimit'],
        message: 'Set the daily loss risk limit',
      },
    ]);
  });

  it('warns when one order may exceed the strategy exposure', () => {
    expect(check((d) => (d.risk.maxOrderNotional = '30000')).warnings).toEqual([
      'order_limit_above_exposure',
    ]);
  });
});

describe('back tests', () => {
  it('says nothing until back testing exists', () => {
    expect(check(() => undefined).warnings).toEqual([]);
  });

  it('warns when never tested or changed since', () => {
    expect(check(() => undefined, context({ backtest: null })).warnings).toEqual(['no_backtest']);
    expect(
      check(
        () => undefined,
        context({
          backtest: { definitionHash: 'old', completedAt: new Date() },
          definitionHash: 'new',
        }),
      ).warnings,
    ).toEqual(['stale_backtest']);
  });
});

describe('issue locations', () => {
  it('points at the leg and field', () => {
    const { raw } = check((d) => (d.exit.orders[0]!.instrumentId = STOCK_B));
    expect(raw.errors[0]).toMatchObject({
      nodeId: 'sell-a',
      path: ['exit', 'orders', 0, 'instrumentId'],
    });
    expect(STOCK_A).not.toBe(STOCK_B);
  });
});

describe('position values', () => {
  it('accepts a 5% take-profit in Exit on the instrument Entry buys', () => {
    expect(
      check((d) => {
        d.exit.condition.children = [comparison('tp', position('p1'), 'gte', constant('5'))];
      }),
    ).toMatchObject({ errors: [], warnings: [] });
  });

  it('accepts a limit Exit priced from the entry price', () => {
    const { errors } = check((d) => {
      d.exit.orders = [
        order('sell-a', {
          side: 'sell',
          orderType: 'limit',
          limitPrice: {
            kind: 'calc',
            id: 'lp',
            op: 'mul',
            args: [position('p1', { field: 'entry_price' }), constant('1.05')],
          },
        }),
      ];
    });
    expect(errors).toEqual([]);
  });

  it('rejects position values in Entry rules', () => {
    const { errors } = check((d) => {
      d.entry.condition.children = [comparison('e', position('p1'), 'gte', constant('5'))];
    });
    expect(errors).toContain('position_in_entry');
  });

  it('rejects a position in an instrument no Entry leg trades', () => {
    const { errors } = check((d) => {
      d.exit.condition.children = [
        comparison('tp', position('p1', { instrumentId: STOCK_B }), 'gte', constant('5')),
      ];
    });
    expect(errors).toContain('position_not_traded');
  });

  it('rejects a crossing on a position value', () => {
    const { errors } = check((d) => {
      d.exit.condition.children = [
        comparison('tp', position('p1'), 'crosses_above', constant('5')),
      ];
    });
    expect(errors).toContain('cross_on_position');
  });
});
