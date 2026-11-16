/**
 * The colour of a figure that can gain or lose (N289): `text-ok` (green) above
 * zero, `text-danger` (red) below, none at zero or when missing. Colour is never
 * the only cue: the figure keeps its "+" or "−" sign.
 */
export function signTone(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n > 0 ? 'text-ok' : n < 0 ? 'text-danger' : undefined;
}
