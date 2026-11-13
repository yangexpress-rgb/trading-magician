/**
 * Agent profiles (Bring your own AI agent brief §2a, ADR 0092): which AI
 * agents the app knows how to connect, and what each one's connect panel
 * shows. Profiles are data: a new agent is a new entry here, not new
 * plumbing. Settings › AI agents and the consent screen render from this list.
 */

export type AgentAuth = 'oauth' | 'token';

/**
 * How the Connect button starts a connection (N271, layered layout):
 * - `deeplink`: opens the agent's own connect page, built from this app's origin (Muse);
 * - `paste`: copies this app's address and opens the agent's settings (Claude, ChatGPT);
 * - `key`: makes a key here and shows what to paste or run (Claude Code, other agents).
 */
export type AgentConnect =
  | { kind: 'deeplink' }
  | { kind: 'paste'; openUrl: string; steps: readonly string[] }
  | { kind: 'key'; pasteLabel: string };

export interface AgentProfile {
  id: string;
  displayName: string;
  /**
   * Layer 1: one plain-language line under the name. No technical words
   * (MCP, OAuth, token, endpoint, scope, redirect): those belong in Advanced.
   */
  plainLine: string;
  /** Layer 1: words under the Connect button, when it needs any. */
  connectNote?: string;
  connect: AgentConnect;
  authMethod: AgentAuth;
  /** Layer 3 (Advanced): the technical steps. `{endpoint}` stands for the MCP endpoint URL. */
  helpSteps: readonly string[];
  /**
   * Token profiles: what to paste or run, with `{endpoint}`, `{token}` and
   * `{name}` filled in when a token is minted.
   */
  snippetTemplate?: string;
  /** What the snippet is in Advanced, e.g. "Run in a terminal". */
  snippetLabel?: string;
  /** Words in an OAuth client's registered name that point to this profile. */
  clientNameHints?: readonly string[];
  /**
   * Hosts of an OAuth client's redirect URIs that point to this profile (N271).
   * Checked before the name hints: a callback host is harder to fake by accident.
   */
  redirectHosts?: readonly string[];
  /** OAuth profiles that also offer an agent token, in Advanced (N271). */
  tokenFallback?: boolean;
  /**
   * Ask AI panel (N272): the agent's own page that opens with a prompt filled
   * in, the URL-encoded prompt appended. Agents without one get Copy prompt.
   */
  askUrl?: string;
}

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'muse',
    displayName: 'Muse',
    plainLine: "Meta's personal AI agent (muse.ai)",
    connectNote: "You'll confirm in Muse, then approve access here.",
    connect: { kind: 'deeplink' },
    authMethod: 'oauth',
    tokenFallback: true,
    helpSteps: [
      "Connect Muse opens Muse's connect page with a custom OAuth connector spec for this server (authorize, token, register and revoke endpoints; scope read operate; public client, PKCE; Muse's callback https://agent.meta.ai/api/hatch/oauth/callback).",
      'Muse registers itself by dynamic client registration, so no app registration or client secret is needed. Its connection is recognised by the agent.meta.ai callback.',
      'If Muse asks for a key instead, make a token below and give it as an Authorization: Bearer header for {endpoint}.',
    ],
    snippetLabel: 'What to give Muse',
    snippetTemplate:
      'MCP server: {endpoint}\nTransport: Streamable HTTP\nHeader: Authorization: Bearer {token}',
    redirectHosts: ['agent.meta.ai'],
    clientNameHints: ['muse'],
    // Fills Muse's message box without sending (checked 2026-11-13).
    askUrl: 'https://muse.ai/?prompt=',
  },
  {
    id: 'claude',
    displayName: 'Claude',
    plainLine: 'claude.ai and the Claude desktop app',
    connect: {
      kind: 'paste',
      openUrl: 'https://claude.ai/settings/connectors',
      steps: [
        "We copied Trading Magician's address and opened Claude's connector settings.",
        'In Claude, choose "Add custom connector", name it Trading Magician, paste the address and choose Add, then Connect.',
        'Approve access on the Trading Magician page that opens.',
      ],
    },
    authMethod: 'oauth',
    helpSteps: [
      'In Claude, open Settings › Connectors and choose "Add custom connector".',
      'Name it Trading Magician and paste this URL: {endpoint}',
      'Choose Add, then Connect. Claude opens Trading Magician: sign in if asked, check what Claude may do, and approve.',
      'Back in Claude, turn the connector on in a chat from the tools menu.',
    ],
    clientNameHints: ['claude', 'anthropic'],
    askUrl: 'https://claude.ai/new?q=',
  },
  {
    id: 'chatgpt',
    displayName: 'ChatGPT',
    plainLine: 'ChatGPT on the web and in its apps',
    connect: {
      kind: 'paste',
      openUrl: 'https://chatgpt.com/#settings/Connectors',
      steps: [
        "We copied Trading Magician's address and opened ChatGPT's settings.",
        'In ChatGPT, turn on Developer mode under Apps & Connectors › Advanced settings, then choose Create, name it Trading Magician and paste the address.',
        'Approve access on the Trading Magician page that opens.',
      ],
    },
    authMethod: 'oauth',
    helpSteps: [
      'In ChatGPT, open Settings › Apps & Connectors › Advanced settings and turn on Developer mode.',
      'Back in Apps & Connectors, choose Create. Name it Trading Magician and paste this URL: {endpoint}',
      'Pick OAuth for authentication, then create it. ChatGPT opens Trading Magician: sign in if asked, check what ChatGPT may do, and approve.',
      'In a chat, add Trading Magician from the tools menu.',
    ],
    clientNameHints: ['chatgpt', 'openai'],
    askUrl: 'https://chatgpt.com/?q=',
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    plainLine: 'Claude in your terminal',
    connect: { kind: 'key', pasteLabel: 'Run this once in your terminal' },
    authMethod: 'token',
    helpSteps: [
      'Make a token below and choose its scope.',
      'Run the command it gives you in a terminal, in the project where you use Claude Code.',
      'Start Claude Code and run /mcp: trading-magician should show as connected.',
    ],
    snippetLabel: 'Run in a terminal',
    snippetTemplate:
      'claude mcp add --transport http trading-magician {endpoint} --header "Authorization: Bearer {token}"',
  },
  {
    id: 'other-mcp',
    displayName: 'Another AI agent',
    plainLine: 'Any other AI agent that can connect to apps',
    connect: { kind: 'key', pasteLabel: "Paste this into your agent's settings" },
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

const hostOf = (uri: string) => {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/**
 * The profile an OAuth client points to: first by the host of its redirect
 * URIs (Muse calls back to agent.meta.ai, N271), then by words in its
 * registered name (Claude, ChatGPT); "Another AI agent" when nothing
 * matches, since any MCP agent may sign in.
 */
export function profileForClient(client: {
  clientName: string;
  redirectUris: readonly string[];
}): AgentProfile {
  const hosts = client.redirectUris.map(hostOf);
  const byHost = AGENT_PROFILES.find((p) => p.redirectHosts?.some((h) => hosts.includes(h)));
  if (byHost) return byHost;
  const name = client.clientName.toLowerCase();
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
    label: 'Can view',
    detail:
      'Looks up your theories, strategies, back tests, the stock screener and paper account balances.',
  },
  operate: {
    label: 'Can view and make changes',
    detail:
      'Everything Can view allows, plus creating and changing strategies and theories and running back tests. Never starts or stops strategies, places or cancels orders, shares, deletes, or changes billing, keys or data feeds.',
  },
} as const;

/** The MCP endpoint for this app's origin. */
export const mcpEndpoint = (appUrl: string) => `${new URL(appUrl).origin}/api/mcp`;

/** Muse's OAuth callback; Muse connections are recognised by it (N271). */
export const MUSE_CALLBACK = 'https://agent.meta.ai/api/hatch/oauth/callback';

const base64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * Muse's hosted connect page for this app (N271). The spec names this
 * server's OAuth endpoints for Muse's custom connector: version 1, a
 * credential named `custom.<slug>` (Muse requires the prefix), the hosts
 * Muse may call, and the OAuth bootstrap (public client, dynamic
 * registration, Muse's callback). Built from the app's own origin.
 */
export function museConnectUrl(appUrl: string): string {
  const origin = new URL(appUrl).origin;
  const host = new URL(appUrl).hostname;
  const spec = {
    version: 1,
    credential: {
      name: 'custom.trading-magician',
      domains: [host],
      oauth: {
        issuer_domain: host,
        authorization_url: `${origin}/oauth/authorize`,
        token_url: `${origin}/api/oauth/token`,
        revoke_url: `${origin}/api/oauth/revoke`,
        registration_url: `${origin}/api/oauth/register`,
        redirect_uri: MUSE_CALLBACK,
        scope: 'read operate',
        token_endpoint_auth_method: 'none',
      },
    },
  };
  const url = new URL('https://agent.meta.ai/connect/oauth');
  url.searchParams.set('service', 'trading-magician');
  url.searchParams.set('spec', base64url(JSON.stringify(spec)));
  return url.toString();
}
