/**
 * Units live in the column header, not in every cell (data text role, O102).
 * `bare` takes a value already formatted by the page's own formatter and
 * removes its currency symbol or trailing percent sign, so digits, decimals and
 * the sign stay exactly as the formatter wrote them: "+$1,234.56" reads
 * "+1,234.56", "−24.93%" reads "−24.93", "$1.2B" reads "1.2B". A dash for a
 * missing value and any text that is not a number pass through unchanged.
 */
export function bare(formatted: string): string {
  const m = /^([+−-]?)\$?([\d.,]+[KMBT]?)%?$/.exec(formatted);
  return m ? `${m[1]}${m[2]}` : formatted;
}

/** A column header naming its unit: "Net P/L $", "Return %". */
export function withUnit(label: string, unit: '$' | '%'): string {
  return `${label} ${unit}`;
}
