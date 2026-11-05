import { renameCredentialRequest } from '@tm/contracts';
import { deleteCredential, renameCredential } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const PATCH = api<{ credentialId: string }>(async (request, { tx }, { credentialId }) => {
  const { label } = await readJson(request, renameCredentialRequest);
  return Response.json(await tx((t) => renameCredential(t, { id: credentialId, label })));
});

export const DELETE = api<{ credentialId: string }>(
  async (_request, { userId, tx }, { credentialId }) => {
    await tx((t) => deleteCredential(t, { userId, id: credentialId }));
    return new Response(null, { status: 204 });
  },
);
