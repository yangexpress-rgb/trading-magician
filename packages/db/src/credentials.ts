import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { isProviderId, PROVIDERS } from '@tm/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { maskTail, openSecret, sealSecret, type SealedSecret } from './sealed';
import { brokerConnections, credentials, dataFeedConnections } from './schema';

/**
 * Stored provider credentials (§9.2–9.3, §16.1; ADR 0015). Values are sealed
 * with the worker's public key before they are written and are never returned:
 * callers get the provider, a label and masked tails. Only the worker, through
 * its tm_secrets login and private key, can open one.
 */

export class CredentialError extends Error {
  constructor(
    public readonly code: 'not_found' | 'bad_request' | 'conflict' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface CredentialSummary {
  id: string;
  provider: string;
  label: string;
  environment: 'paper';
  /** Field name to masked tail, e.g. { keyId: '••••7Q2A' }. */
  hint: Record<string, string>;
  createdAt: string;
  rotatedAt: string | null;
  /** Names of the feeds and broker connections signing in with it. */
  usedBy: { kind: 'data_feed' | 'broker'; id: string; name: string }[];
}

const aadOf = (userId: string, id: string, provider: string) => `${userId}:${id}:${provider}`;

/** Checks the fields against the provider and returns the JSON to seal. */
function payloadOf(provider: string, fields: Record<string, string>) {
  if (!isProviderId(provider) || PROVIDERS[provider].credentialFields.length === 0) {
    throw new CredentialError('bad_request', 'This provider does not take a credential');
  }
  const expected: string[] = PROVIDERS[provider].credentialFields.map((f) => f.name);
  const extra = Object.keys(fields).filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !fields[k]?.trim());
  if (extra.length > 0 || missing.length > 0) {
    throw new CredentialError(
      'bad_request',
      `Enter ${PROVIDERS[provider].credentialFields.map((f) => f.label).join(' and ')}`,
    );
  }
  const clean = Object.fromEntries(expected.map((k) => [k, (fields[k] ?? '').trim()]));
  const hint = Object.fromEntries(expected.map((k) => [k, maskTail(clean[k] ?? '')]));
  return { plaintext: JSON.stringify(clean), hint };
}

function sealedColumns(sealed: SealedSecret) {
  return {
    keyId: sealed.keyId,
    wrappedKey: sealed.wrappedKey,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    authTag: sealed.authTag,
  };
}

export async function createCredential(
  tx: Transaction,
  input: {
    userId: string;
    provider: string;
    label: string;
    fields: Record<string, string>;
    publicKey: string | undefined;
  },
): Promise<CredentialSummary> {
  if (!input.publicKey) {
    throw new CredentialError('unavailable', 'Secure credential storage is not set up yet');
  }
  const { plaintext, hint } = payloadOf(input.provider, input.fields);
  const id = randomUUID();
  const sealed = sealSecret(input.publicKey, plaintext, aadOf(input.userId, id, input.provider));
  await tx.insert(credentials).values({
    id,
    userId: input.userId,
    provider: input.provider,
    label: input.label.trim().slice(0, 100),
    environment: 'paper',
    hint,
    ...sealedColumns(sealed),
  });
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'credential.created',
    resourceType: 'credential',
    resourceId: id,
    context: { provider: input.provider, keyId: sealed.keyId },
  });
  return getCredential(tx, id);
}

/** Replaces the stored value with a new one, keeping every connection that uses it. */
export async function rotateCredential(
  tx: Transaction,
  input: {
    userId: string;
    id: string;
    fields: Record<string, string>;
    publicKey: string | undefined;
  },
): Promise<CredentialSummary> {
  if (!input.publicKey) {
    throw new CredentialError('unavailable', 'Secure credential storage is not set up yet');
  }
  const [row] = await tx
    .select({ provider: credentials.provider, rowVersion: credentials.rowVersion })
    .from(credentials)
    .where(eq(credentials.id, input.id));
  if (!row) throw new CredentialError('not_found', 'Credential not found');
  const { plaintext, hint } = payloadOf(row.provider, input.fields);
  const sealed = sealSecret(
    input.publicKey,
    plaintext,
    aadOf(input.userId, input.id, row.provider),
  );
  await tx
    .update(credentials)
    .set({ ...sealedColumns(sealed), hint, rotatedAt: new Date(), rowVersion: row.rowVersion + 1 })
    .where(eq(credentials.id, input.id));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'credential.rotated',
    resourceType: 'credential',
    resourceId: input.id,
    context: { provider: row.provider, keyId: sealed.keyId },
  });
  return getCredential(tx, input.id);
}

export async function renameCredential(
  tx: Transaction,
  input: { id: string; label: string },
): Promise<CredentialSummary> {
  const rows = await tx
    .update(credentials)
    .set({ label: input.label.trim().slice(0, 100) })
    .where(eq(credentials.id, input.id))
    .returning({ id: credentials.id });
  if (rows.length === 0) throw new CredentialError('not_found', 'Credential not found');
  return getCredential(tx, input.id);
}

/** Deletes a credential no connection uses any more. */
export async function deleteCredential(
  tx: Transaction,
  input: { userId: string; id: string },
): Promise<void> {
  const [summary] = await summaries(tx, [input.id]);
  if (!summary) throw new CredentialError('not_found', 'Credential not found');
  if (summary.usedBy.length > 0) {
    throw new CredentialError(
      'conflict',
      `Remove it from ${summary.usedBy.map((u) => u.name).join(', ')} first`,
    );
  }
  await tx.delete(credentials).where(eq(credentials.id, input.id));
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'user',
    action: 'credential.deleted',
    resourceType: 'credential',
    resourceId: input.id,
    context: { provider: summary.provider },
  });
}

export async function listCredentials(tx: Transaction): Promise<CredentialSummary[]> {
  return summaries(tx);
}

export async function getCredential(tx: Transaction, id: string): Promise<CredentialSummary> {
  const [summary] = await summaries(tx, [id]);
  if (!summary) throw new CredentialError('not_found', 'Credential not found');
  return summary;
}

async function summaries(tx: Transaction, ids?: string[]): Promise<CredentialSummary[]> {
  const rows = await tx
    .select({
      id: credentials.id,
      provider: credentials.provider,
      label: credentials.label,
      hint: credentials.hint,
      createdAt: credentials.createdAt,
      rotatedAt: credentials.rotatedAt,
    })
    .from(credentials)
    .where(ids ? inArray(credentials.id, ids) : undefined)
    .orderBy(asc(credentials.createdAt));
  if (rows.length === 0) return [];
  const found = rows.map((r) => r.id);
  const [feeds, brokers] = await Promise.all([
    tx
      .select({
        id: dataFeedConnections.id,
        name: dataFeedConnections.name,
        ref: dataFeedConnections.credentialRef,
      })
      .from(dataFeedConnections)
      .where(inArray(dataFeedConnections.credentialRef, found)),
    tx
      .select({
        id: brokerConnections.id,
        name: brokerConnections.name,
        ref: brokerConnections.credentialRef,
      })
      .from(brokerConnections)
      .where(inArray(brokerConnections.credentialRef, found)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    environment: 'paper',
    hint: r.hint as Record<string, string>,
    createdAt: r.createdAt.toISOString(),
    rotatedAt: r.rotatedAt?.toISOString() ?? null,
    usedBy: [
      ...feeds
        .filter((f) => f.ref === r.id)
        .map((f) => ({ kind: 'data_feed' as const, id: f.id, name: f.name })),
      ...brokers
        .filter((b) => b.ref === r.id)
        .map((b) => ({ kind: 'broker' as const, id: b.id, name: b.name })),
    ],
  }));
}

export interface OpenedCredential {
  provider: string;
  environment: 'paper';
  fields: Record<string, string>;
}

/**
 * Worker only: opens a credential for a provider call. Needs a connection with
 * tm_secrets (the web login gets "permission denied") and the private key.
 * The result must stay in memory: never log it or store it.
 */
export async function openCredential(
  tx: Transaction,
  input: { userId: string; id: string; privateKey: string | undefined },
): Promise<OpenedCredential> {
  if (!input.privateKey) {
    throw new CredentialError('unavailable', 'This worker has no credential key');
  }
  const [row] = await tx
    .select({
      provider: credentials.provider,
      environment: credentials.environment,
      keyId: credentials.keyId,
      wrappedKey: credentials.wrappedKey,
      iv: credentials.iv,
      ciphertext: credentials.ciphertext,
      authTag: credentials.authTag,
    })
    .from(credentials)
    .where(and(eq(credentials.id, input.id), eq(credentials.userId, input.userId)));
  if (!row) throw new CredentialError('not_found', 'Credential not found');
  if (row.environment !== 'paper') {
    throw new CredentialError('unavailable', 'Only paper credentials can be used');
  }
  const plaintext = openSecret(input.privateKey, row, aadOf(input.userId, input.id, row.provider));
  const opened: OpenedCredential = {
    provider: row.provider,
    environment: 'paper',
    fields: JSON.parse(plaintext) as Record<string, string>,
  };
  // If it is ever logged or serialized by mistake, the values stay hidden.
  const hidden = () => ({ provider: opened.provider, environment: 'paper', fields: '[redacted]' });
  Object.defineProperties(opened, {
    toJSON: { value: hidden },
    [inspect.custom]: { value: hidden },
  });
  return opened;
}
