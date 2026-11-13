# ADR 0092: AI agents connect over MCP, with OAuth or agent tokens, and the tool list is the boundary

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N262–N265, O164–O169. Bring your own AI agent brief (agent
  connections, MCP, 2026-11-13), requested by Yong.

## Context

People already work with AI agents (Claude, ChatGPT, Claude Code and other MCP agents) outside
the app. Their work reached the app only by copy and paste, or by an agent driving the browser
like a person. The brief asks for no agent inside the product: instead the person says which
agent they use, and the app provides the connection that agent needs to act in the app as that
person, under the same rules as the screens.

## Decision

- **MCP as the protocol.** The app serves the Model Context Protocol at `/api/mcp` over the
  Streamable HTTP transport, stateless: each POST carries a JSON-RPC message (or a batch) and
  gets a JSON reply; there is no server-sent stream, so GET answers 405 as the transport
  allows. `initialize`, `ping`, `tools/list` and `tools/call` are served
  (`apps/web/lib/server/agents/mcp.ts`). The protocol is small enough that the endpoint is
  written directly rather than through an SDK, which keeps it inside the app's own error,
  logging and tenant plumbing.
- **Tools call the service layer.** Every tool (`apps/web/lib/server/agents/tools.ts`) calls
  the same `@tm/db` functions as the `/api/v1` routes, in the person's tenant transaction
  (`withTenant`), and checks requests with the same `@tm/contracts` schemas. Validation, plan
  limits, row-level security and the paper-only rules therefore apply to agents exactly as to
  clicks. Known errors become the same codes, messages and field issues the screens show
  (`knownError` in `api-errors.ts`, shared with `/api/v1`). The Back test panel's date checks
  moved into `queueBacktest`, used by both.
- **Dual auth.** Connector-style agents (Claude, ChatGPT) sign in with OAuth 2.1; CLI-style
  agents (Claude Code, other MCP agents) send a personal agent token (`tma_` + 256 random
  bits) as a bearer header. Both resolve, through the SECURITY DEFINER function
  `agent_resolve_credential` (which takes only a SHA-256 hash), to one connection: person,
  scope, profile. Secrets are shown once and stored only as hashes (`agent_credential`).
  Unknown, revoked and expired credentials, and those of deleted or locked accounts, get a 401
  with a JSON-RPC error and a `WWW-Authenticate` header naming the protected-resource
  metadata. Each connection may make 60 calls a minute. `AGENT_API_ENABLED` (default off)
  turns the endpoint, the OAuth endpoints and token minting on.
- **OAuth: purpose-built, not Better Auth's MCP plugin.** The app is its own authorization
  server, following the MCP authorization specification: protected-resource metadata
  (RFC 9728) at `/.well-known/oauth-protected-resource[/api/mcp]`, authorization-server
  metadata (RFC 8414), open dynamic client registration (RFC 7591, rate limited), an
  authorize page behind the normal sign-in with a consent screen, the authorization code grant
  with PKCE S256 only and exact redirect URI matching, one-hour access tokens, refresh tokens
  that rotate on every use (30 days unused), a replayed code revoking what it made, and
  revocation (RFC 7009) that revokes the connection. The plugin was set aside because its
  tables and tokens live in the auth database role outside row-level security and would not
  give one connection row per approval; the purpose-built flow keeps every secret hashed,
  tenant-scoped and revocable from Settings, in about 400 lines (`oauth.ts`, migration 0092).
- **Agent profiles are data.** `apps/web/lib/agents/profiles.ts` lists the agents (Claude,
  ChatGPT, Claude Code, another MCP agent) with `{id, displayName, authMethod, helpSteps,
snippetTemplate}`. Settings › AI agents and the consent screen render from it, so a new
  agent is a new entry, not new plumbing.
- **The tool list is the security boundary.** There is no tool, at any scope, to start or stop
  execution, place, change or cancel orders, send or accept shares, change billing or plans,
  change credentials or data feeds, manage invites or users, or delete anything. Scopes:
  `read` (the eight read tools) and `operate` (read plus `create_strategy`,
  `update_strategy`, `run_backtest`, `create_theory`), default `read`. A snapshot test pins
  the list to N264 and refuses names that look like execution, orders, sharing, billing,
  credentials, administration or deletion. No in-app confirmation gates an operate call: the
  person confirms in their agent; the mitigations are the read default, the activity log and
  revocation.
- **Audit.** Every tool call, refused ones included, is a row of `agent_call_log` (person,
  connection, tool, a summary of the arguments with secret-looking fields left out, outcome,
  error class, duration), shown at Settings › AI agents › Activity and kept 90 days (the
  worker's hourly prune). Creating and revoking a connection are also `audit_event` rows. The
  account purge removes all agent rows.

## Consequences

- An agent sees real data and the app's own wording (the strategy summary, validation issues,
  back test Why lines) instead of paraphrased screens.
- Adding a tool is a design decision: the snapshot test fails until N264 is updated.
- Refused calls made with a secret that matches nothing cannot be attributed to anyone and are
  not logged (O167).
- The endpoint is off until `AGENT_API_ENABLED=true` is set on the web service.
