import { z } from 'zod';

/**
 * Settings integrations (§9.2–9.3, §14.4). Credential values travel only in
 * the body of a create or rotate request; no response ever carries them.
 */

const secretValue = z.string().trim().min(1).max(500);

export const createCredentialRequest = z.object({
  provider: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(100),
  fields: z.record(z.string().max(40), secretValue),
});
export type CreateCredentialRequest = z.infer<typeof createCredentialRequest>;

export const rotateCredentialRequest = z.object({
  fields: z.record(z.string().max(40), secretValue),
});
export type RotateCredentialRequest = z.infer<typeof rotateCredentialRequest>;

export const renameCredentialRequest = z.object({
  label: z.string().trim().min(1).max(100),
});
export type RenameCredentialRequest = z.infer<typeof renameCredentialRequest>;

export interface CredentialDto {
  id: string;
  provider: string;
  label: string;
  environment: 'paper';
  /** Field name to masked tail, e.g. { keyId: '••••7Q2A' }. */
  hint: Record<string, string>;
  createdAt: string;
  rotatedAt: string | null;
  usedBy: { kind: 'data_feed' | 'broker'; id: string; name: string }[];
}

export interface CredentialListDto {
  credentials: CredentialDto[];
  /** False until the server has a key to seal new credentials with. */
  storageReady: boolean;
}
