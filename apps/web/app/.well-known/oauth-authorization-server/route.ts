import {
  authorizationServerMetadata,
  metadataResponse,
  notEnabled,
} from '@/lib/server/agents/oauth';
import { oauthDeps, preflight } from '@/lib/server/agents/oauth-routes';

export const dynamic = 'force-dynamic';

/** Authorization-server metadata (RFC 8414, ADR 0092). */
export function GET() {
  const deps = oauthDeps();
  if (!deps.enabled) return notEnabled();
  return metadataResponse(authorizationServerMetadata(deps.appUrl));
}

export const OPTIONS = preflight;
