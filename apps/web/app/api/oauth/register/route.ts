import { handleRegister } from '@/lib/server/agents/oauth';
import { oauthDeps, preflight } from '@/lib/server/agents/oauth-routes';

export const dynamic = 'force-dynamic';

/** Dynamic client registration (RFC 7591), for AI agents (ADR 0092). */
export function POST(request: Request) {
  return handleRegister(request, oauthDeps());
}

export const OPTIONS = preflight;
