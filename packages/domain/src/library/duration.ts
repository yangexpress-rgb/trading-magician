import { z } from 'zod';

/**
 * Frequency and turnaround time on a Strategy Library entry are structured
 * durations, never free text, so entries can be filtered and compared by
 * timescale (ADR 0051).
 *
 * - `every`: once per `value` units, e.g. "1 month" or "5 days (range 2–10 days)".
 *   Used for frequency (signal cadence) and turnaround (typical holding period).
 * - `per`: `value` times per unit, e.g. "2–4 per year". Frequency only.
 * - `unknown`: turnaround only, when the holding period is genuinely not known.
 */
export const DURATION_UNITS = [
  'seconds',
  'minutes',
  'hours',
  'days',
  'weeks',
  'months',
  'quarters',
  'years',
] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

const SINGULAR: Record<DurationUnit, string> = {
  seconds: 'second',
  minutes: 'minute',
  hours: 'hour',
  days: 'day',
  weeks: 'week',
  months: 'month',
  quarters: 'quarter',
  years: 'year',
};

const amount = z.number().positive('Use a number above 0').max(1_000_000);

const measured = z
  .object({
    kind: z.enum(['every', 'per']),
    value: amount,
    unit: z.enum(DURATION_UNITS, { error: 'Choose a unit' }),
    low: amount.optional(),
    high: amount.optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if ((d.low === undefined) !== (d.high === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [d.low === undefined ? 'low' : 'high'],
        message: 'A range needs both a low and a high value',
      });
      return;
    }
    if (d.low !== undefined && d.high !== undefined) {
      if (d.low > d.high) {
        ctx.addIssue({ code: 'custom', path: ['low'], message: 'Low must not be above high' });
      } else if (d.value < d.low || d.value > d.high) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'The typical value must be inside the range',
        });
      }
    }
  });

const unknown = z.object({ kind: z.literal('unknown') }).strict();

/** Frequency: a value with a unit; never Unknown. */
export const frequencySchema = measured;
/** Turnaround time: a value with a unit, or explicitly Unknown; never "per". */
export const turnaroundSchema = z.union([
  unknown,
  measured.refine((d) => d.kind === 'every', {
    message: 'Turnaround is a holding period: use a duration, not a count per period',
    path: ['kind'],
  }),
]);

export type MeasuredDuration = z.infer<typeof measured>;
export type LibraryDuration = MeasuredDuration | { kind: 'unknown' };

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

function withUnit(n: number, unit: DurationUnit): string {
  return `${num(n)} ${n === 1 ? SINGULAR[unit] : unit}`;
}

/**
 * Human text for a duration, always with its unit and range:
 * "1 month", "5 days (range 2–10 days)", "2–4 per year (typically 3)", "Unknown".
 */
export function formatDuration(d: LibraryDuration): string {
  if (d.kind === 'unknown') return 'Unknown';
  const { low, high } = d;
  const ranged = low !== undefined && high !== undefined;
  if (d.kind === 'per') {
    const unit = SINGULAR[d.unit];
    if (!ranged) return `${num(d.value)} per ${unit}`;
    return `${num(low)}–${num(high)} per ${unit} (typically ${num(d.value)})`;
  }
  const typical = withUnit(d.value, d.unit);
  if (!ranged) return typical;
  return `${typical} (range ${num(low)}–${withUnit(high, d.unit)})`;
}
