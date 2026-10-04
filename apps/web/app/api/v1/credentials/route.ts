import { createCredentialRequest, type CredentialListDto } from '@tm/contracts';
import { createCredential, listCredentials } from '@tm/db';
import { api, readJson } from '@/lib/server/api';
import { serverEnv } from '@/lib/server/env';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const body: CredentialListDto = {
    credentials: await tx((t) => listCredentials(t)),
    storageReady: Boolean(serverEnv().CREDENTIALS_PUBLIC_KEY),
  };
  return Response.json(body);
});

export const POST = api(async (request, { userId, tx }) => {
  const input = await readJson(request, createCredentialRequest);
  const created = await tx((t) =>
    createCredential(t, { userId, ...input, publicKey: serverEnv().CREDENTIALS_PUBLIC_KEY }),
  );
  return Response.json(created, { status: 201 });
});
