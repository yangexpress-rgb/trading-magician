# ADR 0093: The Ask AI panel hands the screen to any agent through a snapshot and the agent's own page

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N272, O174. Requested by Yong on 2026-11-13: direct access to Muse
  inside the app, with the screen as context, as "a side panel which is universal to any AI
  agent".

## Context

ADR 0092 lets an agent act in the app as the person, over MCP. The person still has to tell
the agent what they are looking at. Yong asked for a side panel in the app that sends the
current screen to the agent he uses, starting with Muse, and open to any agent.

What the agents allow (checked 2026-11-13):

- No agent offers an API for another app to post into the person's own chat. Muse's
  integrations only run the other way: Muse calls apps through connectors.
- muse.ai refuses to be shown inside another site (`X-Frame-Options: SAMEORIGIN`,
  `frame-ancestors 'self'`), so it cannot be embedded in a panel.
- Muse opens with a prompt filled in, not sent, at `https://muse.ai/?prompt=…`. Claude
  (`claude.ai/new?q=`) and ChatGPT (`chatgpt.com/?q=`) have the same kind of link.
- An unofficial paid Muse API exists, but it signs in with the person's muse.ai password. It
  was ruled out.

## Decision

- **One panel, many agents.** The panel (`components/ask-ai/ask-ai-panel.tsx`) belongs to the
  app shell. It does not belong to any one agent. Its choices are the profiles with an `askUrl`
  (`lib/agents/profiles.ts`), connected ones first, then Copy prompt for any other agent. A new
  agent with a prefill page is one new profile field.
- **What the screen is.** The panel reads the page in the browser: the title, the main heading,
  the address and the text of `<main>`. It reads focus items from the address
  (`focusFromUrl`): the strategy, theory, pattern or scan in the path, and symbol or back test
  values in the query. The other query values become filters. Pages need no changes. The person
  sees what will go, and can leave the text out or trim it.
- **Snapshots for connected agents.** For an agent connected under ADR 0092, the panel saves a
  `screen_snapshot` row (migration 0094). The row is the owner's only under row-level security,
  is kept 24 hours, is cleared on the owner's next save, and is removed by the account purge.
  The prompt carries only the question, one line about the page and an 8-character code. The
  agent reads the full snapshot with `get_screen_context`, a read tool, and can then look items
  up with the other tools. This keeps the link short and leaves the page text out of the URL.
- **Inline context for the rest.** An agent that is not connected gets the screen written into
  the prompt. Page text is capped at 2,500 characters in a link and 20,000 in Copy prompt.
- **Nothing is sent for the person.** The agent opens in a new tab with the prompt filled in,
  and the person sends it there. The tab is opened during the click, so pop-up blockers allow
  it, and its opener is cut.

## Consequences

- The agent answers in its own tab, not in the panel. Answers inside the panel need an agent
  that can be called with the person's own API key (Claude, OpenAI or an OpenAI-compatible
  service, using the same tools). That is build 2 and will extend this ADR. Muse can join it
  only if Meta opens an API.
- A prefill parameter is the agent's own and is not a contract (O174). If an agent drops it,
  that agent opens an empty chat, and Copy prompt still works.
- The tool catalogue grows by one read tool. The ADR 0092 boundary is unchanged.
