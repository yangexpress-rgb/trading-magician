import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * Envelope encryption for provider credentials (ADR 0015). Each secret gets a
 * fresh AES-256-GCM data key, which is wrapped with an RSA-OAEP (SHA-256)
 * public key. Whoever holds only the public key (the web app) can seal but
 * never open; the worker holds the private key. The additional data binds a
 * sealed value to its row, so ciphertext copied to another row fails to open.
 */

export interface SealedSecret {
  /** Fingerprint of the public key that wrapped the data key. */
  keyId: string;
  wrappedKey: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class SealError extends Error {
  override name = 'SealError';
}

const MIN_MODULUS_BITS = 3072;
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' } as const;

function publicKeyOf(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new SealError('The credential public key is not a valid PEM key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new SealError('The credential key must be RSA');
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_MODULUS_BITS) {
    throw new SealError(`The credential key must be at least ${MIN_MODULUS_BITS} bits`);
  }
  return key;
}

/** A short, stable fingerprint of a public (or private) key. */
export function keyIdOf(pem: string): string {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function sealSecret(publicKeyPem: string, plaintext: string, aad: string): SealedSecret {
  const key = publicKeyOf(publicKeyPem);
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt({ key, ...OAEP }, dataKey);
  dataKey.fill(0);
  return { keyId: keyIdOf(publicKeyPem), wrappedKey, iv, ciphertext, authTag };
}

export function openSecret(privateKeyPem: string, sealed: SealedSecret, aad: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new SealError('The credential private key is not a valid PEM key');
  }
  if (keyIdOf(privateKeyPem) !== sealed.keyId) {
    throw new SealError('This credential was sealed with a different key');
  }
  try {
    const dataKey = privateDecrypt({ key, ...OAEP }, sealed.wrappedKey);
    const decipher = createDecipheriv('aes-256-gcm', dataKey, sealed.iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.authTag);
    const plain = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    dataKey.fill(0);
    return plain.toString('utf8');
  } catch {
    throw new SealError('This credential could not be opened');
  }
}

/** A new key pair for local development and tests. */
export function generateCredentialKeyPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync('rsa', {
    modulusLength: MIN_MODULUS_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/** The masked tail shown for a stored secret field: its last four characters. */
export function maskTail(value: string): string {
  const tail = value.length > 8 ? value.slice(-4) : '';
  return `••••${tail}`;
}
