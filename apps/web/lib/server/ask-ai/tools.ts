import 'server-only';
import { rateLimitHit, recordAgentCall, withTenant, type AgentCallOutcome } from '@tm/db';
import { knownError, toIssues } from '../api-errors';
import { appDb } from '../db';
import { summarizeArgs } from '../agents/mcp';
import { AGENT_TOOLS, toolByName, toolListing, type ToolContext } from '../agents/tools';
import type { ChatTools } from './chat';

/** Longest tool result handed back to the agent. */
const MAX_RESULT = 40_000;

/**
 * The agent tools (ADR 0092) for the Ask AI chat (N274), run as the signed-in
 * person with the same checks the MCP endpoint applies. The person is at the
 * screen and asked, so the chat may use operate tools; the catalogue's
 * boundary still holds (no execution, orders, sharing or deleting). Each call
 * is logged in the agent Activity list with no connection, shown as Ask AI.
 */
export function askAiTools(userId: string, appUrl: string): ChatTools {
  const asUser: ToolContext['tx'] = (fn) => withTenant(appDb(), { userId }, fn);
  const ctx: ToolContext = {
    userId,
    tx: asUser,
    appUrl: new URL(appUrl).origin,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    rateLimit: (key, perMinute) => rateLimitHit(appDb(), key, perMinute, 60),
  };
  const text = (value: unknown) => {
    const s = JSON.stringify(value);
    return s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}… (cut)` : s;
  };
  return {
    list: AGENT_TOOLS.map((t) => {
      const l = toolListing(t);
      return { name: l.name, description: l.description, inputSchema: l.inputSchema };
    }),
    run: async (name, args) => {
      const started = Date.now();
      const log = (outcome: AgentCallOutcome, errorClass: string | null) =>
        asUser((tx) =>
          recordAgentCall(tx, {
            userId,
            connectionId: null,
            tool: name || 'unknown',
            args: summarizeArgs(args),
            outcome,
            errorClass,
            durationMs: Date.now() - started,
          }),
        ).catch(() => undefined);
      const tool = toolByName(name);
      if (!tool) {
        await log('refused', 'unknown_tool');
        return { ok: false, text: text({ error: `Unknown tool: ${name}` }) };
      }
      const parsed = tool.input.safeParse(args ?? {});
      if (!parsed.success) {
        await log('error', 'bad_request');
        return {
          ok: false,
          text: text({
            error: { code: 'bad_request', issues: toIssues(parsed.error.issues) },
          }),
        };
      }
      try {
        const result = await tool.run(ctx, parsed.data as never);
        await log('ok', null);
        return { ok: true, text: text(result) };
      } catch (error) {
        const known = knownError(error);
        await log('error', known?.code ?? 'internal');
        return {
          ok: false,
          text: text({
            error: known ?? { code: 'internal', message: 'Something went wrong. Try again.' },
          }),
        };
      }
    },
  };
}
