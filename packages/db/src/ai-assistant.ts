import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Transaction } from './client';
import { aiAssistants } from './schema';

/**
 * The one AI agent a person chats with in the Ask AI panel (N274, ADR 0094).
 * API keys are sealed with AES-256-GCM under a key derived from a secret only
 * the web app holds (its BETTER_AUTH_SECRET), as invite codes are (ADR 0085):
 * a leaked database reveals no key, and the key is never shown again.
 */

export const AI_PROVIDERS = ['muse', 'anthropic', 'openai', 'openai_compatible'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export function aiKeySealKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'tm-ai-assistant', 'ai assistant key v1', 32));
}

/** AES-256-GCM: `v1.` + base64url(iv | tag | ciphertext). */
export function sealAiKey(apiKey: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

/** The API key, or null when it was sealed with another key or is damaged. */
export function openAiKey(sealed: string, key: Buffer): string | null {
  if (!sealed.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface AiAssistantSummary {
  provider: AiProvider;
  model: string | null;
  baseUrl: string | null;
  /** The key's last four characters; null without a key. */
  keyHint: string | null;
  updatedAt: string;
}

export interface AiAssistantSecret extends AiAssistantSummary {
  /** The API key; null for Muse, or when the key no longer opens. */
  apiKey: string | null;
}

/** The person's Ask AI agent, without its key; null when none is chosen. */
export async function getAiAssistant(
  tx: Transaction,
  userId: string,
): Promise<AiAssistantSummary | null> {
  const [row] = await tx.select().from(aiAssistants).where(eq(aiAssistants.userId, userId));
  if (!row) return null;
  return {
    provider: row.provider as AiProvider,
    model: row.model,
    baseUrl: row.baseUrl,
    keyHint: row.keyHint,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The person's Ask AI agent with its key opened, for the chat route only. */
export async function loadAiAssistantSecret(
  tx: Transaction,
  userId: string,
  sealKey: Buffer,
): Promise<AiAssistantSecret | null> {
  const [row] = await tx.select().from(aiAssistants).where(eq(aiAssistants.userId, userId));
  if (!row) return null;
  return {
    provider: row.provider as AiProvider,
    model: row.model,
    baseUrl: row.baseUrl,
    keyHint: row.keyHint,
    updatedAt: row.updatedAt.toISOString(),
    apiKey: row.keySealed ? openAiKey(row.keySealed, sealKey) : null,
  };
}

/**
 * Chooses the person's Ask AI agent. An omitted `apiKey` keeps the stored key
 * when the provider is unchanged; Muse stores no key.
 */
export async function saveAiAssistant(
  tx: Transaction,
  userId: string,
  input: { provider: AiProvider; model?: string | null; baseUrl?: string | null; apiKey?: string },
  sealKey: Buffer,
): Promise<AiAssistantSummary> {
  const [existing] = await tx.select().from(aiAssistants).where(eq(aiAssistants.userId, userId));
  const keepKey = existing && existing.provider === input.provider && !input.apiKey;
  const muse = input.provider === 'muse';
  const keySealed = muse
    ? null
    : input.apiKey
      ? sealAiKey(input.apiKey, sealKey)
      : keepKey
        ? existing.keySealed
        : null;
  if (!muse && !keySealed) throw new Error('An API key is needed for this agent.');
  const values = {
    provider: input.provider,
    model: muse ? null : (input.model ?? null),
    baseUrl: input.provider === 'openai_compatible' ? (input.baseUrl ?? null) : null,
    keySealed,
    keyHint: muse ? null : input.apiKey ? input.apiKey.slice(-4) : (existing?.keyHint ?? null),
  };
  await tx
    .insert(aiAssistants)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: aiAssistants.userId, set: { ...values, updatedAt: sql`now()` } });
  const saved = await getAiAssistant(tx, userId);
  if (!saved) throw new Error('The AI agent was not saved.');
  return saved;
}

/** Forgets the person's Ask AI agent and its key. */
export async function clearAiAssistant(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(aiAssistants).where(eq(aiAssistants.userId, userId));
}
