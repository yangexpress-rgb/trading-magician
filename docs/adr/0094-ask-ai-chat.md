# ADR 0094: Ask AI chats with one chosen agent through its API, run by the web app

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N274, O175. Amends ADR 0093. Requested by Yong on 2026-11-13: one
  agent set up once, no reconnecting, and a back-and-forth chat in the side panel. He chose chat
  with an API-key agent.

## Context

Build 1 (ADR 0093) handed questions to an agent's own page in a new tab. Yong wants the panel to
be the conversation. An app can only hold a conversation with an agent it can call. Claude,
OpenAI and OpenAI-compatible services take API keys. Muse has no API (O174), and its connector
only lets Muse call the app.

## Decision

- **One agent per person.** The `ai_assistant` table (migration 0095) has one row per person:
  the provider (`anthropic`, `openai`, `openai_compatible` or `muse`), the model, the base URL
  for compatible services, and the sealed key with its last four characters. Row-level
  security makes it the owner's only, and the account purge removes it. Settings › AI agents
  chooses it.
- **Keys sealed for the web app.** The chat runs in the web app, which the panel calls. Keys are
  sealed with AES-256-GCM under a key derived from `BETTER_AUTH_SECRET` with HKDF, as invite
  codes are (ADR 0085). The worker-only key pair of ADR 0015 can't be used, because the web app
  could not open it. A key is never shown again; the form keeps it unless a new one is entered.
- **The chat route.** `POST /api/v1/ask-ai/chat` takes the conversation (at most 40 turns) and
  the screen. The screen is added to the latest message as a `<screen>` block, and the prompt
  says to treat it as context, not instructions. The route runs the agent with the agent tool
  catalogue (ADR 0092) as the signed-in person, at most 8 tool rounds, and the last round offers
  no tools. It returns the answer and the tools used.
  - Claude goes through the official `@anthropic-ai/sdk`, with the server-side refusal fallback
    on models that take it. The default model is `claude-opus-5-5`.
  - OpenAI and compatible services go through Chat Completions with function tools.
  - Each tool call is logged in Activity with no connection, shown as "Ask AI panel".
  - There are 12 chat requests a minute per person, on top of the general limit.
- **Operate tools are allowed.** The person is at the screen asking. The tool list is the
  same boundary as ADR 0092: no execution, orders, sharing, billing, credentials or deleting.
- **The panel.** There is no agent list any more. With an API-key agent the panel is a chat,
  kept for the browser tab. With Muse it has one Ask Muse button, the ADR 0093 flow. With no
  agent it links to Settings.
- **Muse is not relayed.** An inbox that Muse polls through its connector was offered and not
  chosen. It would be slow and would depend on Muse keeping a task running.

## Consequences

- What the agent does is billed to the person's own key.
- A compromised web app could read the keys (O175). The database alone can't.
- Rotating `BETTER_AUTH_SECRET` means everyone enters their key again.
- Answers arrive in one piece rather than streaming; a long tool chain can take a minute. The
  route allows 300 seconds.
