import { describe, expect, it } from 'vitest';
import { headerText, summarizeArgs } from './mcp';
import { AGENT_TOOLS, toolListing } from './tools';

/**
 * The tool list is the security boundary (Bring your own AI agent brief §4,
 * ADR 0092). This test pins it to the design doc: adding, removing or
 * re-scoping a tool fails here until N264 and this list say so.
 */
const CATALOGUE: Record<string, 'read' | 'operate'> = {
  search_theories: 'read',
  get_theory: 'read',
  list_strategies: 'read',
  get_strategy: 'read',
  list_backtests: 'read',
  get_backtest: 'read',
  screen_stocks: 'read',
  get_paper_accounts: 'read',
  create_strategy: 'operate',
  update_strategy: 'operate',
  run_backtest: 'operate',
  create_theory: 'operate',
};

/** What no agent tool may ever do, at any scope (brief §4). */
const FORBIDDEN =
  /order|execut|start|stop|pause|resume|cancel|flatten|close_position|share|accept|bill|plan|subscri|checkout|credential|secret|key|feed|route|invite|admin|user|member|delete|remove|archive|purge|kill|revoke|password/i;

describe('agent tool catalogue', () => {
  it('lists exactly the tools in the design doc, each at its scope', () => {
    const listed = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t.scope]));
    expect(listed).toEqual(CATALOGUE);
    expect(AGENT_TOOLS.map((t) => toolListing(t).name)).toEqual(Object.keys(CATALOGUE));
  });

  it('has no execution, order, sharing, billing, credential, admin or delete tools', () => {
    for (const t of AGENT_TOOLS) {
      expect(t.name, t.name).not.toMatch(FORBIDDEN);
    }
  });

  it('describes every tool with an object input schema and honest hints', () => {
    for (const t of AGENT_TOOLS) {
      const listing = toolListing(t);
      expect(listing.inputSchema.type, t.name).toBe('object');
      expect(listing.description.length, t.name).toBeGreaterThan(40);
      expect(listing.annotations.readOnlyHint).toBe(t.scope === 'read');
      expect(listing.annotations.destructiveHint).toBe(false);
    }
  });

  it('keeps tools/list small enough for an agent to read', () => {
    const size = JSON.stringify(AGENT_TOOLS.map(toolListing)).length;
    expect(size).toBeLessThan(60_000);
  });
});

describe('activity argument summaries', () => {
  it('keeps short values, sizes big ones and drops secret-looking fields', () => {
    expect(
      summarizeArgs({
        name: 'Test',
        limit: 5,
        definition: { a: 1, b: 2 },
        symbols: ['SPY', 'QQQ'],
        many: Array.from({ length: 9 }, (_, i) => String(i)),
        apiKey: 'x',
        accessToken: 'y',
        note: 'z'.repeat(200),
      }),
    ).toEqual({
      name: 'Test',
      limit: 5,
      definition: '{2 fields}',
      symbols: ['SPY', 'QQQ'],
      many: '[9 items]',
      note: `${'z'.repeat(77)}…`,
    });
    expect(summarizeArgs(null)).toEqual({});
  });
});

describe('headerText', () => {
  it('keeps WWW-Authenticate descriptions ASCII and readable', () => {
    expect(headerText('Connect again in Trading Magician › Settings › AI agents.')).toBe(
      'Connect again in Trading Magician > Settings > AI agents.',
    );
    expect(headerText('say "hi" — ok')).toBe('say hi  ok');
  });
});
