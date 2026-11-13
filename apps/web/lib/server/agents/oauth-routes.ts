import 'server-only';
import { CORS, type OAuthDeps } from './oauth';
import { appDb } from '../db';
import { serverEnv } from '../env';

/** The live wiring for the OAuth route handlers (ADR 0092). */
export function oauthDeps(): OAuthDeps {
  const env = serverEnv();
  return { db: appDb(), appUrl: env.APP_URL, enabled: env.AGENT_API_ENABLED };
}

/** CORS preflight for browser-based MCP clients. */
export const preflight = () => new Response(null, { status: 204, headers: CORS });
