import {
  rateLimitHit,
  recordAgentCall,
  resolveAgentCredential,
  touchAgentConnection,
  withTenant,
  type AgentCallOutcome,
  type Database,
  type ResolvedAgentCredential,
} from '@tm/db';
import { knownError, toIssues } from '../api-errors';
import { CORS } from './oauth';
import { AGENT_TOOLS, toolByName, toolListing, type ToolContext } from './tools';

/**
 * The MCP endpoint (Bring your own AI agent brief §3, ADR 0092): Model
 * Context Protocol over the Streamable HTTP transport, stateless. Each POST
 * carries one JSON-RPC message (or a batch) and gets a JSON answer; there is
 * no server-sent stream, so GET is refused as the transport allows.
 *
 * Every request names its connection with `Authorization: Bearer <secret>`:
 * an agent token (`tma_…`) or an OAuth access token (`tmo_at_…`). Unknown,
 * revoked and expired secrets get a 401 with a JSON-RPC error and the
 * WWW-Authenticate header OAuth clients use to find the sign-in.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
/** Calls per connection per minute (brief §3d). */
export const AGENT_CALLS_PER_MINUTE = 60;
const MAX_BODY_BYTES = 1_000_000;

export interface McpDeps {
  /** The tm_app pool. */
  db: Database;
  appUrl: string;
  /** AGENT_API_ENABLED (brief §3d). */
  enabled: boolean;
  version?: string | undefined;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onError?: (error: unknown, tool: string) => void;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const SECRET_KEY = /token|secret|password|passwd|authorization|api[-_]?key|credential/i;

/**
 * What the activity log keeps of a call's arguments (brief §5): short values
 * as given, long text cut, objects and lists by size, anything named like a
 * secret left out.
 */
export function summarizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>).slice(0, 20)) {
    if (SECRET_KEY.test(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string')
      out[key] = value.length > 80 ? `${value.slice(0, 77)}…` : value;
    else if (Array.isArray(value))
      out[key] =
        value.length <= 5 && value.every((v) => typeof v === 'string' && v.length <= 20)
          ? value
          : `[${value.length} items]`;
    else if (typeof value === 'object') out[key] = `{${Object.keys(value).length} fields}`;
  }
  return out;
}

const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0' as const, id, result });

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...CORS,
      'access-control-expose-headers': 'www-authenticate',
      ...headers,
    },
  });
}

export const resourceMetadataUrl = (appUrl: string) =>
  `${new URL(appUrl).origin}/.well-known/oauth-protected-resource/api/mcp`;

function unauthorized(appUrl: string, id: JsonRpcId, message: string, invalid: boolean) {
  const challenge = [
    'Bearer realm="trading-magician"',
    `resource_metadata="${resourceMetadataUrl(appUrl)}"`,
    // Header values are ASCII: the full message is in the body.
    ...(invalid ? ['error="invalid_token"', `error_description="${headerText(message)}"`] : []),
  ].join(', ');
  return json(rpcError(id, -32001, message), 401, { 'www-authenticate': challenge });
}

/** "Settings › AI agents" → "Settings > AI agents": headers carry ASCII only, no quotes. */
export function headerText(message: string): string {
  return message.replace(/›/g, '>').replace(/[^\x20-\x7e]|"/g, '');
}

const REFUSALS: Record<Exclude<ResolvedAgentCredential['state'], 'ok'>, string> = {
  revoked:
    'This agent connection was revoked. Connect again in Trading Magician › Settings › AI agents.',
  expired:
    'This agent connection has expired. Connect again in Trading Magician › Settings › AI agents.',
  closed: 'This Trading Magician account is closed or locked.',
};

function isRequest(m: unknown): m is JsonRpcRequest {
  return (
    !!m &&
    typeof m === 'object' &&
    (m as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (m as { method?: unknown }).method === 'string'
  );
}

/** The tool a message calls, for logging refused requests; empty when it calls none. */
function calledTool(m: unknown): string {
  if (!isRequest(m) || m.method !== 'tools/call') return '';
  const name = m.params?.name;
  return typeof name === 'string' ? name.slice(0, 80) : '';
}

export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  if (!deps.enabled) {
    return json(
      rpcError(null, -32000, 'Agent connections are turned off on this Trading Magician server.'),
      503,
    );
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST', ...CORS } });
  }

  // The body first, so a refused call can still be logged under the tool it named.
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return json(rpcError(null, -32600, 'The request is too large'), 413);
    }
    body = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, 'The request body must be JSON'), 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const firstId = isRequest(messages[0]) ? (messages[0].id ?? null) : null;

  const header = request.headers.get('authorization') ?? '';
  const secret = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!secret) {
    return unauthorized(
      deps.appUrl,
      firstId,
      'Sign in or send an agent token as a Bearer token',
      false,
    );
  }
  const cred = await resolveAgentCredential(deps.db, secret);
  if (!cred || cred.kind === 'refresh') {
    return unauthorized(deps.appUrl, firstId, 'The token is not valid', true);
  }
  const asUser = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(deps.db, { userId: cred.userId }, fn);
  if (cred.state !== 'ok') {
    for (const m of messages) {
      const tool = calledTool(m);
      if (!tool) continue;
      await asUser((tx) =>
        recordAgentCall(tx, {
          userId: cred.userId,
          connectionId: cred.connectionId,
          tool,
          args: summarizeArgs((m as JsonRpcRequest).params?.arguments),
          outcome: 'refused',
          errorClass: `connection_${cred.state}`,
          durationMs: 0,
        }),
      ).catch(() => undefined);
    }
    return unauthorized(deps.appUrl, firstId, REFUSALS[cred.state], true);
  }
  await asUser((tx) => touchAgentConnection(tx, cred.connectionId));

  const ctx: ToolContext = {
    userId: cred.userId,
    tx: asUser,
    appUrl: new URL(deps.appUrl).origin,
    now,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    rateLimit: (key, perMinute) => rateLimitHit(deps.db, key, perMinute, 60),
  };

  const replies = [];
  for (const m of messages) {
    const reply = await handleMessage(m, cred, ctx, deps);
    if (reply) replies.push(reply);
  }
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? replies : replies[0]);
}

async function handleMessage(
  m: unknown,
  cred: ResolvedAgentCredential,
  ctx: ToolContext,
  deps: McpDeps,
) {
  if (!isRequest(m)) {
    // A response or something unreadable; a JSON-RPC response from the client needs no answer.
    if (m && typeof m === 'object' && 'result' in m) return null;
    return rpcError(null, -32600, 'Not a JSON-RPC 2.0 request');
  }
  const id = m.id ?? null;
  // Notifications (no id) get no answer.
  if (m.id === undefined) return null;
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      const protocolVersion =
        typeof asked === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
          ? asked
          : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: 'trading-magician',
          title: 'Trading Magician',
          version: deps.version ?? '1',
        },
        instructions:
          "Trading Magician is a paper-trading planning app. These tools act in one person's account. " +
          `This connection's scope is "${cred.scope}". Read tools look up theories, strategies, back tests, ` +
          'the stock screener and paper accounts. Operate tools create and change strategies and theories ' +
          'and run back tests. Nothing here starts strategies, places orders, shares or deletes.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: AGENT_TOOLS.map(toolListing) });
    case 'tools/call':
      return callTool(id, m.params ?? {}, cred, ctx, deps);
    default:
      return rpcError(id, -32601, `Method not found: ${m.method}`);
  }
}

function toolText(value: unknown, isError: boolean) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(
  id: JsonRpcId,
  params: Record<string, unknown>,
  cred: ResolvedAgentCredential,
  ctx: ToolContext,
  deps: McpDeps,
) {
  const started = Date.now();
  const name = typeof params.name === 'string' ? params.name.slice(0, 80) : '';
  const rawArgs = params.arguments ?? {};
  const log = (outcome: AgentCallOutcome, errorClass: string | null) =>
    ctx
      .tx((tx) =>
        recordAgentCall(tx, {
          userId: cred.userId,
          connectionId: cred.connectionId,
          tool: name || 'unknown',
          args: summarizeArgs(rawArgs),
          outcome,
          errorClass,
          durationMs: Date.now() - started,
        }),
      )
      .catch((error: unknown) => deps.onError?.(error, name));

  const tool = toolByName(name);
  if (!tool) {
    await log('refused', 'unknown_tool');
    return rpcError(id, -32602, `Unknown tool: ${name || '(none)'}`);
  }
  if (tool.scope === 'operate' && cred.scope !== 'operate') {
    await log('refused', 'insufficient_scope');
    return rpcResult(
      id,
      toolText(
        {
          error: {
            code: 'insufficient_scope',
            message:
              'This connection is read only. To let this agent create and change strategies and run back tests, connect it again with "Read and operate" in Trading Magician › Settings › AI agents.',
          },
        },
        true,
      ),
    );
  }
  const wait = await ctx.rateLimit(`agent:${cred.connectionId}`, AGENT_CALLS_PER_MINUTE);
  if (wait > 0) {
    await log('refused', 'rate_limited');
    return rpcResult(
      id,
      toolText(
        {
          error: {
            code: 'rate_limited',
            message: `Too many calls: at most ${AGENT_CALLS_PER_MINUTE} a minute. Wait ${wait} seconds.`,
          },
        },
        true,
      ),
    );
  }
  const parsed = tool.input.safeParse(rawArgs);
  if (!parsed.success) {
    await log('error', 'bad_request');
    return rpcResult(
      id,
      toolText(
        {
          error: {
            code: 'bad_request',
            message: 'Some fields need attention',
            issues: toIssues(parsed.error.issues),
          },
        },
        true,
      ),
    );
  }
  try {
    const result = await tool.run(ctx, parsed.data as never);
    await log('ok', null);
    return rpcResult(id, toolText(result, false));
  } catch (error) {
    const known = knownError(error);
    if (known) {
      await log('error', known.code);
      return rpcResult(id, toolText({ error: known }, true));
    }
    deps.onError?.(error, name);
    await log('error', 'internal');
    return rpcResult(
      id,
      toolText({ error: { code: 'internal', message: 'Something went wrong. Try again.' } }, true),
    );
  }
}
