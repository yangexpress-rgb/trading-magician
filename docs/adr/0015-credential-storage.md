# ADR 0015: Sealed provider credentials

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §9.2, §9.3, §13.4, §16.1, §19.7

## Context

Phase 4 connects real providers, starting with Alpaca paper accounts, which sign in with an API
key and secret. The design asks that secrets be captured through a secure, write-only flow, never
returned to the browser, never written to logs or browser storage, and kept by a managed secrets
mechanism. Hosting is not chosen until Phase 6, so there is no cloud key service yet.

## Decision

- **Envelope encryption with an asymmetric key pair.** Each secret is encrypted with a fresh
  AES-256-GCM data key. The data key is wrapped with an RSA-OAEP (SHA-256, 3072-bit) public
  key. The additional authenticated data is the user, credential and provider, so ciphertext
  copied to another row does not open.
- **Only the worker can open a secret.** The web app is given `CREDENTIALS_PUBLIC_KEY` only: it
  can seal a value when a person saves one, and can never read one back. It refuses to start if
  `CREDENTIALS_PRIVATE_KEY` is in its environment. The worker, which makes the provider calls,
  holds the private key.
- **The database enforces the same split.** `credential` is tenant-isolated like every other
  table. `tm_app` may insert, delete, read metadata and update the sealed columns, but has no
  `SELECT` on them. A new `tm_secrets` role may read them, and only the worker's login
  (`tm_worker_login`, member of `tm_app` and `tm_secrets`, `DATABASE_WORKER_URL`) has it.
- **What people see.** A label, the provider, the masked last four characters of each field,
  when it was saved or replaced, and which connections use it. Values can be replaced in place,
  so connections keep working, or removed once nothing uses them. Forms use password inputs with
  autocomplete off and clear their state after sending.
- **Paper only.** A `CHECK` keeps every credential on the paper environment, and opening one for
  anything else is refused, alongside the ADR 0002 guard.
- **Logs and audit.** Audit records name the provider and the sealing key's fingerprint, never a
  value. The worker's logger redacts `fields`, `secretKey` and `privateKey`, and an opened
  credential serializes and inspects as `[redacted]`.

## Consequences

- The private key is the one secret that matters: deployments keep it in their secret manager,
  give it to the worker alone, and in Phase 6 can move the unwrap step into a cloud key service.
  Each row records its key fingerprint, so a new key pair can be introduced and old rows re-sealed.
- A worker started without `DATABASE_WORKER_URL` still runs the demo connections but cannot use
  stored credentials.
- Local development generates a pair with `pnpm --filter @tm/db credentials:keygen`; E2E
  generates a throwaway pair per run.
