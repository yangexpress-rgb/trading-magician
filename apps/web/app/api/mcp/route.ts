import { handleMcpRequest } from '@/lib/server/agents/mcp';
import { preflight } from '@/lib/server/agents/oauth-routes';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';
import { logger } from '@/lib/server/log';

export const dynamic = 'force-dynamic';

/**
 * The MCP endpoint for AI agents (Bring your own AI agent brief §3, ADR 0092).
 * It authenticates with agent tokens and OAuth access tokens, never the
 * session cookie, so it sits outside the /api/v1 session plumbing.
 */
async function handle(request: Request): Promise<Response> {
  const env = serverEnv();
  try {
    return await handleMcpRequest(request, {
      db: appDb(),
      appUrl: env.APP_URL,
      enabled: env.AGENT_API_ENABLED,
      version: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7),
      onError: (err, tool) => logger().error({ err, tool }, 'Agent tool failed'),
    });
  } catch (err) {
    logger().error({ err }, 'MCP request failed');
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Something went wrong. Try again.' },
      },
      { status: 500 },
    );
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = preflight;
