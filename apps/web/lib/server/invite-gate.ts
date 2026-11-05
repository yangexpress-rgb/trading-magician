import 'server-only';
import {
  attachInvite,
  claimInvite,
  normalizeInviteCode,
  recordAudit,
  releaseInvite,
  withTenant,
} from '@tm/db';
import { appDb } from './db';
import { serverEnv } from './env';
import { logger } from './log';

/**
 * Invite-only sign-up (§16.4, ADR 0026). The code is claimed before the account
 * is created, so two people cannot use one code; it is named once the account
 * exists, and given back when the sign-up did not go through.
 */
const SIGN_UP = '/sign-up/email';

function codeOf(body: unknown): string {
  const raw =
    body && typeof body === 'object' && 'inviteCode' in body
      ? (body as { inviteCode?: unknown }).inviteCode
      : undefined;
  return typeof raw === 'string' ? normalizeInviteCode(raw) : '';
}

function refused() {
  return Response.json(
    {
      code: 'INVALID_INVITE_CODE',
      message: 'That invite code is not valid or has already been used.',
    },
    { status: 403 },
  );
}

/**
 * Runs `handle` for a sign-up only when its invite code is good. Returns the
 * refusal itself when it is not, and the request is never passed on.
 */
export async function withInvite(
  request: Request,
  handle: (request: Request) => Promise<Response>,
): Promise<Response> {
  const env = serverEnv();
  const path = new URL(request.url).pathname;
  if (env.SIGNUP_MODE !== 'invite' || !path.endsWith(SIGN_UP)) return handle(request);

  const text = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  const code = codeOf(body);
  if (!code || (await claimInvite(appDb(), code)) === null) return refused();

  // The body was read, so pass a copy on with the same headers.
  const response = await handle(
    new Request(request.url, { method: request.method, headers: request.headers, body: text }),
  );
  if (!response.ok) {
    await releaseInvite(appDb(), code);
    return response;
  }
  try {
    const clone = (await response.clone().json()) as { user?: { id?: unknown } };
    const userId = typeof clone.user?.id === 'string' ? clone.user.id : undefined;
    if (userId) {
      await attachInvite(appDb(), code, userId);
      await withTenant(appDb(), { userId }, (tx) =>
        recordAudit(tx, {
          userId,
          actorType: 'system',
          action: 'account.invited',
          resourceType: 'user',
          resourceId: userId,
        }),
      );
    }
  } catch (error) {
    // The account exists either way; the code stays claimed, just unnamed.
    logger().warn({ err: error }, 'Could not record who used an invite code');
  }
  return response;
}
