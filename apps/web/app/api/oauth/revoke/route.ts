import { handleRevoke } from '@/lib/server/agents/oauth';
import { oauthDeps, preflight } from '@/lib/server/agents/oauth-routes';

export const dynamic = 'force-dynamic';

/** Token revocation (RFC 7009), for AI agents (ADR 0092). */
export function POST(request: Request) {
  return handleRevoke(request, oauthDeps());
}

export const OPTIONS = preflight;
