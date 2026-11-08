import { listLibraryQuery, registerLibraryEntryRequest } from '@tm/contracts';
import { listLibraryEntries, registerLibraryEntry } from '@tm/db';
import { api, readJson, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (request, { tx, userId }) => {
  const q = readQuery(request, listLibraryQuery);
  const result = await tx((t) =>
    listLibraryEntries(t, {
      search: q.q,
      assetClassCode: q.asset,
      timeframeCode: q.timeframe,
      category: q.category,
      built: q.built,
      side: q.side,
      maturity: q.maturity,
      dataNeed: q.data,
      status: q.status,
      mine: q.mine,
      viewerId: userId,
      sort: q.sort,
      direction: q.direction,
    }),
  );
  return Response.json(result);
});

/** Registers an entry; the number is issued in the same transaction. */
export const POST = api(async (request, { tx, userId }) => {
  const body = await readJson(request, registerLibraryEntryRequest);
  const entry = await tx((t) => registerLibraryEntry(t, userId, body));
  return Response.json(entry, {
    status: 201,
    headers: { location: `/api/v1/library/${entry.registrationNumber}` },
  });
});
