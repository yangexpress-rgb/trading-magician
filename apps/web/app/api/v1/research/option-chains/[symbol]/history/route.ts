import type { OptionHistoryDto } from '@tm/contracts';
import { normaliseOptionSymbol, optionsHistory } from '@tm/db';
import { addDays, nyDate } from '@tm/domain';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** A symbol's recorded daily IV30 over the last year and its latest signal row (ADR 0047). */
export const GET = api<{ symbol: string }>(async (_request, { tx }, { symbol }) => {
  const s = normaliseOptionSymbol(symbol);
  const found = await tx((t) => optionsHistory(t, s, addDays(nyDate(new Date()), -366)));
  const body: OptionHistoryDto = found
    ? { symbol: s, recorded: true, points: found.points, latest: found.latest }
    : { symbol: s, recorded: false, points: [], latest: null };
  return Response.json(body);
});
