/**
 * Agent profiles (Bring your own AI agent brief §2a, ADR 0092): which AI
 * agents the app knows how to connect, and what each one's connect panel
 * shows. Profiles are data: a new agent is a new entry here, not new
 * plumbing. Settings › AI agents and the consent screen render from this list.
 */

export type AgentAuth = 'oauth' | 'token';

export interface AgentProfile {
  id: string;
  displayName: string;
  /** One line under the name in the agent list. */
  tagline: string;
  authMethod: AgentAuth;
  /** The connect panel's steps, in order. `{endpoint}` stands for the MCP endpoint URL. */
  helpSteps: readonly string[];
  /**
   * Token profiles: what to paste or run, with `{endpoint}`, `{token}` and
   * `{name}` filled in when a token is minted.
   */
  snippetTemplate?: string;
  /** What the snippet is, e.g. "Run in a terminal". */
  snippetLabel?: string;
  /** Words in an OAuth client's registered name that point to this profile. */
  clientNameHints?: readonly string[];
}

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'claude',
    displayName: 'Claude',
    tagline: 'claude.ai and the Claude desktop app, as a custom connector',
    authMethod: 'oauth',
    helpSteps: [
      'In Claude, open Settings › Connectors and choose "Add custom connector".',
      'Name it Trading Magician and paste this URL: {endpoint}',
      'Choose Add, then Connect. Claude opens Trading Magician: sign in if asked, check what Claude may do, and approve.',
      'Back in Claude, turn the connector on in a chat from the tools menu.',
    ],
    clientNameHints: ['claude', 'anthropic'],
  },
  {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    tagline: 'As an app (connector) in developer mode',
    authMethod: 'oauth',
    helpSteps: [
      'In ChatGPT, open Settings › Apps & Connectors › Advanced settings and turn on Developer mode.',
      'Back in Apps & Connectors, choose Create. Name it Trading Magician and paste this URL: {endpoint}',
      'Pick OAuth for authentication, then create it. ChatGPT opens Trading Magician: sign in if asked, check what ChatGPT may do, and approve.',
      'In a chat, add Trading Magician from the tools menu.',
    ],
    clientNameHints: ['chatgpt', 'openai'],
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    tagline: 'The command-line agent, with an agent token',
    authMethod: 'token',
    helpSteps: [
      'Make a token below. Choose a scope: Read only, or Read and operate to let Claude Code create strategies and run back tests.',
      'Run the command it gives you in a terminal, in the project where you use Claude Code.',
      'Start Claude Code and run /mcp: trading-magician should show as connected.',
    ],
    snippetLabel: 'Run in a terminal',
    snippetTemplate:
      'claude mcp add --transport http trading-magician {endpoint} --header "Authorization: Bearer {token}"',
  },
  {
    id: 'other-mcp',
    displayName: 'Another MCP agent',
    tagline: 'Any agent that speaks MCP over Streamable HTTP with a bearer token',
    authMethod: 'token',
    helpSteps: [
      'Make a token below and choose its scope.',
      "Add this server to your agent's MCP configuration. The endpoint uses the Streamable HTTP transport and takes the token as an Authorization: Bearer header.",
      'Restart or reload the agent so it reads the new configuration.',
    ],
    snippetLabel: 'MCP configuration (JSON)',
    snippetTemplate: JSON.stringify(
      {
        mcpServers: {
          'trading-magician': {
            type: 'http',
            url: '{endpoint}',
            headers: { Authorization: 'Bearer {token}' },
          },
        },
      },
      null,
      2,
    ),
  },
];

export const AGENT_PROFILE_IDS = AGENT_PROFILES.map((p) => p.id);

export function agentProfile(id: string): AgentProfile | undefined {
  return AGENT_PROFILES.find((p) => p.id === id);
}

/** A profile's display name, or the id itself for a profile this version no longer lists. */
export const profileName = (id: string) => agentProfile(id)?.displayName ?? id;

/**
 * The profile an OAuth client's registered name points to (Claude, ChatGPT);
 * "Another MCP agent" when nothing matches, since any MCP agent may sign in.
 */
export function profileForClientName(clientName: string): AgentProfile {
  const name = clientName.toLowerCase();
  return (
    AGENT_PROFILES.find((p) => p.clientNameHints?.some((h) => name.includes(h))) ??
    (agentProfile('other-mcp') as AgentProfile)
  );
}

/** Fills a profile's snippet or step text. */
export function fillTemplate(
  template: string,
  values: { endpoint: string; token?: string; name?: string },
): string {
  return template
    .replaceAll('{endpoint}', values.endpoint)
    .replaceAll('{token}', values.token ?? '<token>')
    .replaceAll('{name}', values.name ?? 'trading-magician');
}

/** What each scope lets an agent do, in the words Settings and the consent screen use. */
export const SCOPE_TEXT = {
  read: {
    label: 'Read only',
    detail:
      'Look up theories, strategies, back tests, the stock screener and paper account balances.',
  },
  operate: {
    label: 'Read and operate',
    detail:
      'Everything Read only allows, plus create and change strategies and theories and run back tests. Never starts or stops strategies, places or cancels orders, shares, deletes, or changes billing, keys or data feeds.',
  },
} as const;

/** The MCP endpoint for this app's origin. */
export const mcpEndpoint = (appUrl: string) => `${new URL(appUrl).origin}/api/mcp`;
