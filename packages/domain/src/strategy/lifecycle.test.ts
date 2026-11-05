import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  canTransition,
  editsCreateNewVersion,
  planTransition,
  STRATEGY_STATUSES,
  type StrategyStatus,
} from './lifecycle';
import type { ValidationIssue, ValidationResult } from './validate';

const issue = (severity: 'error' | 'warning', code: string): ValidationIssue => ({
  severity,
  code,
  message: code,
  path: [],
});
const clean: ValidationResult = { errors: [], warnings: [] };

describe('status transitions (§6.3)', () => {
  it.each<[StrategyStatus, StrategyStatus[]]>([
    ['created', ['under_testing']],
    ['under_testing', ['created', 'actively_executing']],
    ['actively_executing', ['off']],
    ['off', ['under_testing', 'actively_executing']],
  ])('from %s', (from, to) => {
    expect([...allowedTransitions(from)]).toEqual(to);
    for (const s of STRATEGY_STATUSES) expect(canTransition(from, s)).toBe(to.includes(s));
  });

  it('cannot activate straight from Created', () => {
    expect(
      planTransition({
        from: 'created',
        to: 'actively_executing',
        validation: clean,
        confirmed: true,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'not_allowed',
    });
  });

  it('turns off without checks or a new version', () => {
    expect(planTransition({ from: 'actively_executing', to: 'off' })).toEqual({
      ok: true,
      to: 'off',
      snapshotVersion: false,
    });
  });
});

describe('activation', () => {
  const activate = (
    validation: ValidationResult,
    extra: { acknowledgedWarnings?: string[]; confirmed?: boolean } = {},
  ) => planTransition({ from: 'under_testing', to: 'actively_executing', validation, ...extra });

  it('is blocked by validation errors', () => {
    expect(
      activate({ errors: [issue('error', 'no_orders')], warnings: [] }, { confirmed: true }),
    ).toMatchObject({
      ok: false,
      reason: 'validation_errors',
      details: ['no_orders'],
    });
  });

  it('needs every warning acknowledged', () => {
    const v = {
      errors: [],
      warnings: [issue('warning', 'extended_hours'), issue('warning', 'non_atomic_multi_leg')],
    };
    expect(
      activate(v, { confirmed: true, acknowledgedWarnings: ['extended_hours'] }),
    ).toMatchObject({
      ok: false,
      reason: 'unacknowledged_warnings',
      details: ['non_atomic_multi_leg'],
    });
    expect(
      activate(v, {
        confirmed: true,
        acknowledgedWarnings: ['extended_hours', 'non_atomic_multi_leg'],
      }),
    ).toMatchObject({ ok: true });
  });

  it('needs explicit confirmation', () => {
    expect(activate(clean)).toMatchObject({ ok: false, reason: 'not_confirmed' });
  });

  it('pins an immutable version when it starts', () => {
    expect(activate(clean, { confirmed: true })).toEqual({
      ok: true,
      to: 'actively_executing',
      snapshotVersion: true,
    });
  });

  it('refuses to plan an activation without a validation result', () => {
    expect(() =>
      planTransition({ from: 'off', to: 'actively_executing', confirmed: true }),
    ).toThrow();
  });
});

describe('versioning', () => {
  it('versions edits only after a strategy has run', () => {
    expect(editsCreateNewVersion(false)).toBe(false);
    expect(editsCreateNewVersion(true)).toBe(true);
  });
});
