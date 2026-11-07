import { retireLibraryEntryRequest } from '@tm/contracts';
import { retireLibraryEntry } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Retires an entry: it stays visible, badged Retired, and keeps its number. */
export const POST = api<{ number: string }>(async (request, { tx, userId }, { number }) => {
  const body = await readJson(request, retireLibraryEntryRequest);
  return Response.json(await tx((t) => retireLibraryEntry(t, userId, number, body)));
});
