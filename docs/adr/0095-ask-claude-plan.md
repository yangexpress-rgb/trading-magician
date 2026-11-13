# ADR 0095: Ask AI can use Claude through the person's claude.ai plan

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N275, O176. Amends ADR 0094. Requested by Yong on 2026-11-13: he
  pays for a Claude plan and does not want to pay again for API use.

## Context

ADR 0094 chats in the panel through the person's own API key. A claude.ai Pro or Max plan does
not cover API use, so a person on a plan would pay twice. The app cannot call claude.ai, but
claude.ai can call the app: a person who added Trading Magician as a custom connector (ADR 0092)
lets Claude read their screen with `get_screen_context` (ADR 0093).

## Decision

- **A new Ask AI choice, "Claude (my claude.ai plan)".** Provider `claude_ai` in `ai_assistant`
  (migration 0096). Like Muse it stores no key or model; `LINK_PROVIDERS` names both.
- **The panel opens claude.ai.** With this choice the panel has one Ask Claude button. It saves
  the screen as a snapshot when the person has an active Claude connection, and opens
  `https://claude.ai/new?q=` with the question and either the snapshot code or the screen
  summary inline (the ADR 0093 flow, now shared with Muse). Checked in Chrome on 2026-11-13:
  claude.ai fills the question in and waits for the person to send it.
- **The chat route refuses it**, as it refuses Muse.
- It is listed first in Settings and is the form's default; the API-key choice is now
  "Claude (API key)" and says API use is billed separately from a plan.

## Consequences

- No extra cost: claude.ai counts the question against the person's plan.
- The answer appears in the claude.ai tab, not in the panel.
- claude.ai shows a caution note on prefilled prompts; the person reads it and sends.
- Claude reads the screen only if the Trading Magician connector is on in that chat.
