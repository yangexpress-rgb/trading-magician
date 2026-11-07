import {
  getMetric,
  optionMetricId,
  type OptionSignalField,
  type OptionSignalValues,
} from '@tm/domain';

/**
 * Wording and number formats for options figures (options data brief v2 §7,
 * ADR 0047–0048): Research › Options and the screener's options columns.
 * Labels and help come from the metric registry, so a figure on screen means
 * exactly what the same metric means in a condition.
 */

export type OptionFigureKind =
  'vol' | 'pct' | 'usd' | 'rank' | 'ratio' | 'gex' | 'strike' | 'points';

const KIND: Record<OptionSignalField, OptionFigureKind> = {
  iv30: 'vol',
  atm_iv: 'vol',
  expected_move_1d_pct: 'pct',
  expected_move_1d_usd: 'usd',
  expected_move_5d_pct: 'pct',
  expected_move_5d_usd: 'usd',
  straddle_move_pct: 'pct',
  iv_rank_252d: 'rank',
  iv_percentile_252d: 'rank',
  iv_rv_ratio: 'ratio',
  skew_30d: 'points',
  term_structure: 'ratio',
  put_call_volume: 'ratio',
  put_call_oi: 'ratio',
  net_gex: 'gex',
  call_gex: 'gex',
  put_gex: 'gex',
  call_wall: 'strike',
  put_wall: 'strike',
  max_pain: 'strike',
};

/** Open-interest levels aren't condition metrics, so their wording lives here. */
const LEVELS: Partial<Record<OptionSignalField, { label: string; help: string }>> = {
  call_wall: {
    label: 'Call wall',
    help: 'The strike above the price with the most call open interest, at the nearest monthly expiry.',
  },
  put_wall: {
    label: 'Put wall',
    help: 'The strike below the price with the most put open interest, at the nearest monthly expiry.',
  },
  max_pain: {
    label: 'Max pain',
    help: 'The expiry price at which option holders, all together, would collect the least, at the nearest monthly expiry.',
  },
};

export function optionFigureLabel(field: OptionSignalField): string {
  return LEVELS[field]?.label ?? getMetric(optionMetricId(field))?.label ?? field;
}

export function optionFigureHelp(field: OptionSignalField): string {
  return LEVELS[field]?.help ?? getMetric(optionMetricId(field))?.help ?? '';
}

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** A percentage from a fraction: 0.2134 → "21.3%". */
export function formatPct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`;
}

export function formatOptionFigure(field: OptionSignalField, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (KIND[field]) {
    case 'vol':
    case 'pct':
      return formatPct(v, field.startsWith('expected') || field === 'straddle_move_pct' ? 2 : 1);
    case 'usd':
      return usd.format(v);
    case 'rank':
      return v.toFixed(0);
    case 'ratio':
      return `${v.toFixed(2)}×`;
    case 'points':
      return `${(v * 100).toFixed(1)} pts`;
    case 'gex':
      return `${compactUsd.format(v)} per 1%`;
    case 'strike':
      return usd.format(v);
  }
}

/** The figures row of Research › Options, in reading order. */
export const FIGURE_ROW: readonly OptionSignalField[] = [
  'iv30',
  'iv_rank_252d',
  'iv_percentile_252d',
  'expected_move_1d_pct',
  'expected_move_5d_pct',
  'straddle_move_pct',
  'iv_rv_ratio',
  'skew_30d',
  'term_structure',
  'put_call_volume',
  'put_call_oi',
  'net_gex',
  'call_wall',
  'put_wall',
  'max_pain',
];

/** A figure's value with its dollar companion where it has one. */
export function figureDetail(field: OptionSignalField, values: OptionSignalValues): string | null {
  if (field === 'expected_move_1d_pct')
    return formatOptionFigure('expected_move_1d_usd', values.expected_move_1d_usd);
  if (field === 'expected_move_5d_pct')
    return formatOptionFigure('expected_move_5d_usd', values.expected_move_5d_usd);
  return null;
}

/** "Chain at 4:14 pm ET, 6 Nov" for the feed line under the section. */
export function formatChainTime(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
  const day = d.toLocaleDateString('en-GB', {
    timeZone: 'America/New_York',
    day: 'numeric',
    month: 'short',
  });
  return `${time.toLowerCase()} ET, ${day}`;
}

/** "Fri 18 Dec (20 days)" for the expiry picker. */
export function formatExpiry(expiry: string, days: number): string {
  const d = new Date(`${expiry}T12:00:00Z`);
  const text = d.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: d.getUTCFullYear() !== new Date().getUTCFullYear() ? 'numeric' : undefined,
  });
  return `${text} (${days} day${days === 1 ? '' : 's'})`;
}

export function formatGreek(v: number | null | undefined, digits = 3): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}

export function formatCount(v: number | null | undefined): string {
  return v == null ? '—' : v.toLocaleString('en-US');
}
