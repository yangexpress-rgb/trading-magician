import { metadataResponse, notEnabled, protectedResourceMetadata } from '@/lib/server/agents/oauth';
import { oauthDeps, preflight } from '@/lib/server/agents/oauth-routes';

export const dynamic = 'force-dynamic';

/** Protected-resource metadata for the MCP endpoint (RFC 9728, ADR 0092). */
export function GET() {
  const deps = oauthDeps();
  if (!deps.enabled) return notEnabled();
  return metadataResponse(protectedResourceMetadata(deps.appUrl));
}

export const OPTIONS = preflight;
