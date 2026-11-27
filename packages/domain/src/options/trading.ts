import Decimal from 'decimal.js';
import type { OptionRight } from './pricing';

/**
 * Options trading foundations (options trading brief v0.2, Phase O0; ADR 0123).
 *
 * Options arrive as an extension at existing seams behind one switch,
 * `OPTIONS_TRADING_ENABLED`, off by default. With it off nothing here changes
 * what the app does: options legs fail validation with a plain reason, no
 * options order can be placed and no options job runs.
 */

type Env = Record<string, string | undefined>;
const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/** Whether this server may trade options (paper only): only the exact value "true" turns it on. */
export function optionsTradingEnabled(env: Env = processEnv()): boolean {
  return env.OPTIONS_TRADING_ENABLED === 'true';
}

/** The brief's defaults (§§7, 8, 11, 12), each adjustable by its setting where one is named. */
export const OPTIONS_DEFAULTS = {
  /** §8.2: the widest quote spread an order may be sent on, as % of mid (`OPTIONS_MAX_SPREAD_PCT`). */
  maxSpreadPct: '30',
  /** §8.2: the oldest a contract quote may be at send time in market hours. */
  quoteMaxAgeSec: 60,
  /** §8.2: how often options quotes are asked for, at most. */
  quoteEveryMs: 15_000,
  /** §7.4: options legs' own timeout (equity legs keep 60 s). */
  legTimeoutSec: 120,
  /** §8.3: expiry-day close-out starts (New York time), and moves to the touch after. */
  closeOutStart: '15:00',
  closeOutTouch: '15:20',
  /** §11.1: back-test fill slippage, % of premium (`OPTIONS_FILL_SLIPPAGE_PCT`). */
  fillSlippagePct: '5',
  /** §5.3: the only contract multiplier the resolver accepts. */
  standardMultiplier: 100,
} as const;

/** Settings read from the server's environment, falling back to the brief's defaults. */
export function optionsSettings(env: Env = processEnv()) {
  const pct = (v: string | undefined, d: string) =>
    v !== undefined && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 && Number(v) <= 100 ? v : d;
  return {
    enabled: optionsTradingEnabled(env),
    maxSpreadPct: pct(env.OPTIONS_MAX_SPREAD_PCT, OPTIONS_DEFAULTS.maxSpreadPct),
    fillSlippagePct: pct(env.OPTIONS_FILL_SLIPPAGE_PCT, OPTIONS_DEFAULTS.fillSlippagePct),
  };
}

// ---------------------------------------------------------------------------
// §5.4 Options approval levels (Alpaca 0–3), read from the broker, never assumed
// ---------------------------------------------------------------------------

export const OPTIONS_LEVELS = [0, 1, 2, 3] as const;
export type OptionsLevel = (typeof OPTIONS_LEVELS)[number];

/** What a strategy does with options, for the level it needs. */
export type OptionsUse = 'long' | 'combo' | 'covered';

/** §5.4: long options need 2, any combo 3, covered/cash-secured structures 1. */
export const LEVEL_NEEDED: Record<OptionsUse, OptionsLevel> = { covered: 1, long: 2, combo: 3 };

export const OPTIONS_LEVEL_TEXT: Record<OptionsLevel, string> = {
  0: 'no options trading',
  1: 'covered calls and cash-secured puts',
  2: 'buying calls and puts',
  3: 'spreads',
};

/** An Alpaca account's reported level as one of 0–3, or undefined when it didn't say. */
export function parseOptionsLevel(value: unknown): OptionsLevel | undefined {
  const n = typeof value === 'string' && /^\d$/.test(value) ? Number(value) : value;
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : undefined;
}

// ---------------------------------------------------------------------------
// §5.7 The multiplier pass-through
// ---------------------------------------------------------------------------

/**
 * A price as the money it stands for: price × multiplier. For every stock and
 * ETF the multiplier is 1 and the price comes back as the very same value, so
 * equity sizing and risk are identical by construction (A1).
 */
export function effectivePrice(price: Decimal, multiplier: Decimal.Value | undefined): Decimal {
  if (multiplier === undefined) return price;
  const m = new Decimal(multiplier);
  return m.eq(1) ? price : price.times(m);
}

// ---------------------------------------------------------------------------
// OCC symbols (contracts are instrument rows keyed by these, §5.3)
// ---------------------------------------------------------------------------

/** OCC symbol: root (1–6), YYMMDD, C/P, strike × 1000 in 8 digits. `AAPL251226C00105000`. Parsed by `parseOccSymbol` (cboe.ts). */
export const OCC_SYMBOL = /^([A-Z][A-Z0-9]{0,5})(\d{6})([CP])(\d{8})$/;

export function occSymbol(root: string, expiry: string, right: OptionRight, strike: Decimal.Value) {
  const [y, m, d] = expiry.split('-');
  const k = new Decimal(strike).times(1000);
  if (!y || !m || !d || !k.isInteger() || k.lte(0)) throw new Error('invalid contract');
  return `${root}${y.slice(2)}${m}${d}${right === 'call' ? 'C' : 'P'}${k.toFixed(0).padStart(8, '0')}`;
}

const DATE_WORDS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** A contract in plain words (§9): "AAPL 105 call, expiring Fri Dec 26". */
export function contractInWords(c: {
  underlying: string;
  strike: Decimal.Value;
  right: OptionRight;
  expiry: string;
}): string {
  const day = DATE_WORDS.format(new Date(`${c.expiry}T12:00:00Z`)).replace(',', '');
  return `${c.underlying} ${new Decimal(c.strike).toString()} ${c.right}, expiring ${day}`;
}

// ---------------------------------------------------------------------------
// §5.6 Isolation by account, and the other Start gates (§5.4, §5.5, §13)
// ---------------------------------------------------------------------------

/** An account as the options Start gates see it. */
export interface OptionsAccountView {
  nickname: string;
  mode: string;
  /** The simulator reports no options asset class (§5.5). */
  simulator: boolean;
  /** As the broker last reported it; undefined while it hasn't said. */
  optionsLevel: OptionsLevel | undefined;
  /** Whether a non-stopped run on the account trades options / only equities. */
  hasOptionsRuns: boolean;
  hasEquityRuns: boolean;
}

export type OptionsStartRefusal =
  | 'options_off'
  | 'options_live'
  | 'options_simulator'
  | 'options_level'
  | 'options_account_has_equity_runs'
  | 'equity_account_has_options_runs';

/**
 * Why a run may not start on an account under the options rules, or null when
 * it may (A10). `uses` is empty for an equity strategy, which only the
 * isolation rule can stop: an equity run may not start where options runs
 * live. Each reason is one plain sentence naming the rule.
 */
export function optionsStartProblem(input: {
  uses: readonly OptionsUse[];
  account: OptionsAccountView;
  enabled: boolean;
}): { reason: OptionsStartRefusal; message: string } | null {
  const { uses, account } = input;
  if (uses.length === 0) {
    return account.hasOptionsRuns
      ? {
          reason: 'equity_account_has_options_runs',
          message: `${account.nickname} trades options, so stock and ETF strategies can't run on it. Choose another account.`,
        }
      : null;
  }
  if (!input.enabled)
    return {
      reason: 'options_off',
      message:
        'Options trading is turned off on this server, so a strategy with options legs can’t start.',
    };
  if (account.mode !== 'paper')
    return {
      reason: 'options_live',
      message: `${account.nickname} is a live account: options trade on paper accounts only.`,
    };
  if (account.simulator)
    return {
      reason: 'options_simulator',
      message: `${account.nickname} is the built-in simulator, which doesn't trade options. Choose an Alpaca paper account.`,
    };
  const needed = Math.max(...uses.map((u) => LEVEL_NEEDED[u])) as OptionsLevel;
  const level = account.optionsLevel ?? 0;
  if (level < needed) {
    const has =
      account.optionsLevel === undefined
        ? 'hasn’t reported an options level yet'
        : `is at options level ${level} (${OPTIONS_LEVEL_TEXT[level]})`;
    return {
      reason: 'options_level',
      message: `${account.nickname} ${has}; this strategy needs level ${needed} (${OPTIONS_LEVEL_TEXT[needed]}).`,
    };
  }
  if (account.hasEquityRuns)
    return {
      reason: 'options_account_has_equity_runs',
      message: `${account.nickname} runs stock and ETF strategies, so options strategies can't run on it. Use an account kept for options.`,
    };
  return null;
}
