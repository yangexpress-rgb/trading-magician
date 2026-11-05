# ADR 0035: Credential key in AWS KMS

- **Status:** accepted (Yong approved AWS KMS 2026-11-05; the keys are created per environment as in docs/deploy.md)
- **Date:** 2026-11-05
- **Design refs:** §9.2, §16.1, Phase 4 decision 2, ADR 0015, design v1.1 deviation D9

## Context

ADR 0015 seals each provider credential with a fresh AES-256-GCM data key wrapped by an RSA-OAEP
(SHA-256) public key, and gives the private key to the worker in `CREDENTIALS_PRIVATE_KEY`. Phase 4
decision 2 and ADR 0015 planned to move that private key into a cloud key service with Phase 6
hosting. Railway has no key service of its own, so it has to be an outside one that a Railway
service can call over HTTPS.

## Decision

- **AWS KMS, one asymmetric key per environment.** Key spec `RSA_3072`, key usage
  `ENCRYPT_DECRYPT`. KMS's `RSAES_OAEP_SHA_256` decrypt is exactly the unwrap ADR 0015 already
  does, so the stored credential format does not change at all: same columns, same wrapped data
  key, same additional data, and `key_id` is still the SHA-256 fingerprint of the public key.
  Chosen over Google Cloud KMS (equivalent, but nothing else here uses Google Cloud) and over
  secret managers such as Doppler or Infisical (they inject the same private key as an
  environment variable, which is what this replaces). Cost: about $1 a month per key plus
  per-request charges that the cache below keeps small.
- **The private key never leaves KMS.** The web app keeps only `CREDENTIALS_PUBLIC_KEY`, now the
  KMS key's public half (`pnpm --filter @tm/worker credentials:kms-public-key` prints it). The
  worker gets `CREDENTIALS_KMS_KEY_ID` (the key ARN), `AWS_REGION` and an IAM user's access key
  whose only permissions are `kms:Decrypt` and `kms:GetPublicKey` on that one key. Those AWS
  credentials are still environment variables, but they are not the master key: they can be
  revoked at once, every use is logged in CloudTrail, and they are useless without the AWS account.
- **Start-up checks.** The worker reads the key's public half once at start, refuses a key that is
  not RSA 3072/4096 with `ENCRYPT_DECRYPT` and `RSAES_OAEP_SHA_256`, and logs the fingerprint. A
  value sealed under any other key is refused before KMS is called.
- **Cache.** Unwrapped data keys are kept in the worker's memory for 5 minutes (at most 1,000),
  keyed by a hash of the wrapped key, so a strategy polling quotes is not one KMS call per quote.
- **Development stays simple.** Without `CREDENTIALS_KMS_KEY_ID`, the worker still accepts a PEM
  `CREDENTIALS_PRIVATE_KEY` (now marked development only). It refuses to start with that variable
  on Railway (`RAILWAY_ENVIRONMENT_NAME` set) or with both variables at once.

## Consequences

- **Existing values.** Staging and production have never run, so they start with no stored
  credentials and nothing needs re-sealing. A local database (Yong's Mac) keeps its development
  key. Moving local credentials into a KMS-backed environment is not supported; people enter their
  provider keys again, as after any key change (`docs/runbooks/key-rotation.md`).
- **Rotation.** KMS keys are not rotated automatically for asymmetric keys. Rotating means a new
  KMS key and new public key on web, and people entering their provider keys again, as before.
- **A KMS outage** stops stored credentials from opening once cached data keys expire; demo
  connections keep working, and Alpaca strategies pause through the existing stale-price and
  broker-silence rules.
