# ADR 0005: Design system and Content Security Policy

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §5, §5.1, §12.1, §15, §16.1

## Decision

**Design system.** `packages/ui` holds design tokens (CSS variables with light and dark values) and a small set of hand-written, accessible primitives: `Button`, `Badge`, `ModeBadge`, `TextField`, `SelectField`, `Alert`, `Card`, `EmptyState`, `PageHeader`, `Table`. Styling uses Tailwind CSS v4 through the tokens, so colours are changed in one place. Every status uses text and an icon together, never colour alone. Radix primitives will be added for complex widgets (dialogs, menus, comboboxes) when the Strategy Lab needs them, rather than adopting a component generator now.

**Shell.** Primary navigation follows §5 in this order: Quantitative Research, Strategy Lab, Orders, Performance, Settings. On desktop it's a sidebar, and on narrow screens it scrolls horizontally. The account mode badge sits in the shell header so it's always visible. A skip link reaches the main content. Settings has the five subsections from §15.4 as separate routes.

**CSP.** `proxy.ts` issues a per-request nonce and a policy of `script-src 'self' 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'` and `form-action 'self'`, with no third-party origins. Inline style attributes are allowed because React and Next.js emit them. Pages render per request so every response carries a fresh nonce.

## Consequences

- Dynamic rendering everywhere costs some performance on otherwise static pages (sign-in, sign-up). The app is behind sign-in, so the cost is acceptable.
- Adding any third-party script, font or API origin requires a deliberate CSP change in `lib/csp.ts`.
- End-to-end tests run axe (WCAG 2 A/AA) on every page and fail on serious or critical violations.
