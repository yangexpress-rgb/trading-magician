import { handleToken } from '@/lib/server/agents/oauth';
import { oauthDeps, preflight } from '@/lib/server/agents/oauth-routes';

export const dynamic = 'force-dynamic';

/** The token endpoint: authorization_code with PKCE and refresh_token grants, for AI agents (ADR 0092). */
export function POST(request: Request) {
  return handleToken(request, oauthDeps());
}

export const OPTIONS = preflight;
