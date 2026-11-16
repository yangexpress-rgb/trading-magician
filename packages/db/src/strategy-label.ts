import { sql } from 'drizzle-orm';
import { strategies } from './schema';

/**
 * A strategy as plain text names it (N284): its own S number (ADR 0066) before
 * its name, "S00039-SD Earnings breakout", or the name alone when it has no
 * number. Null only when the strategy row is missing (a left join).
 */
export const strategyLabelSql = sql<
  string | null
>`nullif(concat_ws(' ', ${strategies.labNumber}, ${strategies.name}), '')`;

/** The same label from values already loaded. */
export function strategyLabelOf(row: { name: string; labNumber: string | null }): string {
  return row.labNumber ? `${row.labNumber} ${row.name}` : row.name;
}
