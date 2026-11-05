import { rotateCredentialRequest } from '@tm/contracts';
import { rotateCredential } from '@tm/db';
import { api, readJson } from '@/lib/server/api';
import { serverEnv } from '@/lib/server/env';

export const dynamic = 'force-dynamic';

export const POST = api<{ credentialId: string }>(
  async (request, { userId, tx }, { credentialId }) => {
    const { fields } = await readJson(request, rotateCredentialRequest);
    const rotated = await tx((t) =>
      rotateCredential(t, {
        userId,
        id: credentialId,
        fields,
        publicKey: serverEnv().CREDENTIALS_PUBLIC_KEY,
      }),
    );
    return Response.json(rotated);
  },
);
