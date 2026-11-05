import { createHash, createPublicKey } from 'node:crypto';
import {
  DecryptCommand,
  GetPublicKeyCommand,
  KMSClient,
  type DecryptCommandOutput,
  type GetPublicKeyCommandOutput,
} from '@aws-sdk/client-kms';
import { keyIdOf, pemUnwrapper, type KeyUnwrapper } from '@tm/db';

/**
 * Where the worker's credential key lives (ADR 0035). In staging and
 * production the private key stays inside AWS KMS: the worker asks KMS to
 * unwrap each sealed value's data key and never sees the private key. Local
 * development may still keep a PEM key in CREDENTIALS_PRIVATE_KEY.
 */

/** The two KMS calls the worker makes, so tests can stand in for KMS. */
export interface KmsCalls {
  getPublicKey(
    keyId: string,
  ): Promise<
    Pick<GetPublicKeyCommandOutput, 'PublicKey' | 'KeySpec' | 'KeyUsage' | 'EncryptionAlgorithms'>
  >;
  decrypt(keyId: string, wrappedKey: Buffer): Promise<Pick<DecryptCommandOutput, 'Plaintext'>>;
}

export function awsKmsCalls(region: string | undefined): KmsCalls {
  const client = new KMSClient(region ? { region } : {});
  return {
    getPublicKey: (keyId) => client.send(new GetPublicKeyCommand({ KeyId: keyId })),
    decrypt: (keyId, wrappedKey) =>
      client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: wrappedKey,
          EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
        }),
      ),
  };
}

const ALLOWED_SPECS = new Set(['RSA_3072', 'RSA_4096']);

/** Unwrapped data keys are kept this long, so a busy worker is not one KMS call per quote. */
const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 1000;

export interface KmsKey extends KeyUnwrapper {
  /** The public key, PEM, to give the web app as CREDENTIALS_PUBLIC_KEY. */
  readonly publicKeyPem: string;
}

/**
 * Reads the KMS key's public half once, checks it can do RSA-OAEP SHA-256
 * decryption, and returns an unwrapper whose keyId is the same fingerprint the
 * web app stamps on every value it seals with that public key.
 */
export async function kmsKey(
  keyArn: string,
  calls: KmsCalls,
  options: { now?: () => number } = {},
): Promise<KmsKey> {
  const now = options.now ?? Date.now;
  const info = await calls.getPublicKey(keyArn);
  if (!info.PublicKey) throw new Error('KMS returned no public key for the credential key');
  if (info.KeyUsage !== 'ENCRYPT_DECRYPT') {
    throw new Error('The KMS credential key must have key usage ENCRYPT_DECRYPT');
  }
  if (!info.KeySpec || !ALLOWED_SPECS.has(info.KeySpec)) {
    throw new Error('The KMS credential key must be RSA_3072 or RSA_4096');
  }
  if (!info.EncryptionAlgorithms?.includes('RSAES_OAEP_SHA_256')) {
    throw new Error('The KMS credential key must allow RSAES_OAEP_SHA_256');
  }
  const publicKeyPem = createPublicKey({
    key: Buffer.from(info.PublicKey),
    format: 'der',
    type: 'spki',
  })
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const cache = new Map<string, { dataKey: Buffer; until: number }>();
  return {
    keyId: keyIdOf(publicKeyPem),
    publicKeyPem,
    async unwrap(wrappedKey) {
      const slot = createHash('sha256').update(wrappedKey).digest('hex');
      const hit = cache.get(slot);
      if (hit && hit.until > now()) return hit.dataKey;
      if (hit) {
        hit.dataKey.fill(0);
        cache.delete(slot);
      }
      const out = await calls.decrypt(keyArn, wrappedKey);
      if (!out.Plaintext || out.Plaintext.length !== 32) {
        throw new Error('KMS did not return a data key');
      }
      const dataKey = Buffer.from(out.Plaintext);
      if (cache.size >= CACHE_MAX) {
        const [oldest] = cache.keys();
        if (oldest) {
          cache.get(oldest)?.dataKey.fill(0);
          cache.delete(oldest);
        }
      }
      cache.set(slot, { dataKey, until: now() + CACHE_MS });
      return dataKey;
    },
  };
}

export interface CredentialKeyEnv {
  CREDENTIALS_PRIVATE_KEY?: string | undefined;
  CREDENTIALS_KMS_KEY_ID?: string | undefined;
  AWS_REGION?: string | undefined;
}

/**
 * The worker's credential key from its environment: KMS when
 * CREDENTIALS_KMS_KEY_ID is set, a PEM key in development, or none (stored
 * credentials then cannot be used; demo connections still run).
 */
export async function loadCredentialKey(
  env: CredentialKeyEnv,
  calls: (region: string | undefined) => KmsCalls = awsKmsCalls,
): Promise<KeyUnwrapper | undefined> {
  if (env.CREDENTIALS_KMS_KEY_ID) return kmsKey(env.CREDENTIALS_KMS_KEY_ID, calls(env.AWS_REGION));
  if (env.CREDENTIALS_PRIVATE_KEY) return pemUnwrapper(env.CREDENTIALS_PRIVATE_KEY);
  return undefined;
}
