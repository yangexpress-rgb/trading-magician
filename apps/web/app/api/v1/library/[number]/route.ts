import { editLibraryEntryRequest } from '@tm/contracts';
import { getLibraryEntry, updateLibraryEntry } from '@tm/db';
import { api, HttpError, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

type Params = { number: string };

export const GET = api<Params>(async (_request, { tx, userId }, { number }) => {
  const entry = await tx((t) => getLibraryEntry(t, userId, number));
  if (!entry) throw new HttpError('not_found', 'No entry has that registration number');
  return Response.json(entry);
});

/** Edits every field except the number and convention version; a change note is required. */
export const PATCH = api<Params>(async (request, { tx, userId }, { number }) => {
  const body = await readJson(request, editLibraryEntryRequest);
  return Response.json(await tx((t) => updateLibraryEntry(t, userId, number, body)));
});
