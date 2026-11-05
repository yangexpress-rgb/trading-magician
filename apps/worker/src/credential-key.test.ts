import { constants, createPublicKey, privateDecrypt } from 'node:crypto';
import { DecryptCommand, GetPublicKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import {
  generateCredentialKeyPair,
  keyIdOf,
  openSecret,
  openSecretWith,
  SealError,
  sealSecret,
} from '@tm/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awsKmsCalls, kmsKey, loadCredentialKey, type KmsCalls } from './credential-key';
import { loadWorkerEnv } from './env';

const ARN = 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const pair = generateCredentialKeyPair();
const AAD = 'user-1:credential-1:alpaca';

/**
 * Stands in for KMS with a key pair in memory, doing what KMS documents for an
 * RSA_3072 ENCRYPT_DECRYPT key: GetPublicKey returns the SPKI DER, Decrypt with
 * RSAES_OAEP_SHA_256 is RSA-OAEP with SHA-256 for both the hash and MGF1.
 */
function fakeKms(
  keyPair = pair,
  overrides: Partial<Awaited<ReturnType<KmsCalls['getPublicKey']>>> = {},
) {
  const calls = { decrypt: 0 };
  const kms: KmsCalls = {
    getPublicKey: () =>
      Promise.resolve({
        PublicKey: new Uint8Array(
          createPublicKey(keyPair.publicKey).export({ type: 'spki', format: 'der' }),
        ),
        KeySpec: 'RSA_3072',
        KeyUsage: 'ENCRYPT_DECRYPT',
        EncryptionAlgorithms: ['RSAES_OAEP_SHA_1', 'RSAES_OAEP_SHA_256'],
        ...overrides,
      }),
    decrypt: (_keyId, wrapped) => {
      calls.decrypt += 1;
      return Promise.resolve({
        Plaintext: new Uint8Array(
          privateDecrypt(
            {
              key: keyPair.privateKey,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: 'sha256',
            },
            wrapped,
          ),
        ),
      });
    },
  };
  return { kms, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('credential key in AWS KMS (ADR 0035)', () => {
  it('opens a value the web app sealed before the change, with no change to its format', async () => {
    // Sealed exactly as the web app does today, with only the public key.
    const sealed = sealSecret(pair.publicKey, '{"keyId":"PK123","secretKey":"s3cret"}', AAD);
    const { kms } = fakeKms();
    const key = await kmsKey(ARN, kms);
    expect(key.keyId).toBe(keyIdOf(pair.publicKey));
    expect(key.keyId).toBe(sealed.keyId);
    expect(await openSecretWith(key, sealed, AAD)).toBe('{"keyId":"PK123","secretKey":"s3cret"}');
    // The same row still opens with the development PEM key.
    expect(openSecret(pair.privateKey, sealed, AAD)).toBe('{"keyId":"PK123","secretKey":"s3cret"}');
    expect(key.publicKeyPem).toBe(
      createPublicKey(pair.publicKey).export({ type: 'spki', format: 'pem' }),
    );
  });

  it('keeps an unwrapped data key for five minutes, then asks KMS again', async () => {
    const sealed = sealSecret(pair.publicKey, 'value', AAD);
    const { kms, calls } = fakeKms();
    let now = 0;
    const key = await kmsKey(ARN, kms, { now: () => now });
    await openSecretWith(key, sealed, AAD);
    await openSecretWith(key, sealed, AAD);
    expect(calls.decrypt).toBe(1);
    now += 5 * 60_000 + 1;
    expect(await openSecretWith(key, sealed, AAD)).toBe('value');
    expect(calls.decrypt).toBe(2);
  });

  it('refuses a value sealed under another key without calling KMS', async () => {
    const other = generateCredentialKeyPair();
    const sealed = sealSecret(other.publicKey, 'value', AAD);
    const { kms, calls } = fakeKms();
    const key = await kmsKey(ARN, kms);
    await expect(openSecretWith(key, sealed, AAD)).rejects.toThrow(
      new SealError('This credential was sealed with a different key'),
    );
    expect(calls.decrypt).toBe(0);
  });

  it('turns a KMS failure or a wrong row into the usual "could not be opened"', async () => {
    const sealed = sealSecret(pair.publicKey, 'value', AAD);
    const { kms } = fakeKms();
    const failing = await kmsKey(ARN, {
      ...kms,
      decrypt: () => Promise.reject(new Error('AccessDeniedException')),
    });
    await expect(openSecretWith(failing, sealed, AAD)).rejects.toThrow('could not be opened');
    const key = await kmsKey(ARN, kms);
    await expect(openSecretWith(key, sealed, 'user-2:credential-1:alpaca')).rejects.toThrow(
      'could not be opened',
    );
  });

  it('refuses a KMS key that cannot do RSA-OAEP SHA-256 decryption', async () => {
    await expect(kmsKey(ARN, fakeKms(pair, { KeyUsage: 'SIGN_VERIFY' }).kms)).rejects.toThrow(
      'ENCRYPT_DECRYPT',
    );
    await expect(kmsKey(ARN, fakeKms(pair, { KeySpec: 'RSA_2048' }).kms)).rejects.toThrow(
      'RSA_3072',
    );
    await expect(
      kmsKey(ARN, fakeKms(pair, { EncryptionAlgorithms: ['RSAES_OAEP_SHA_1'] }).kms),
    ).rejects.toThrow('RSAES_OAEP_SHA_256');
  });

  it('asks AWS for exactly RSAES_OAEP_SHA_256 on the configured key', async () => {
    const send = vi.spyOn(KMSClient.prototype, 'send').mockImplementation((command: unknown) => {
      if (command instanceof GetPublicKeyCommand) return fakeKms().kms.getPublicKey(ARN);
      if (command instanceof DecryptCommand) {
        expect(command.input).toMatchObject({
          KeyId: ARN,
          EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
        });
        return fakeKms().kms.decrypt(ARN, Buffer.from(command.input.CiphertextBlob!));
      }
      throw new Error('unexpected command');
    });
    const sealed = sealSecret(pair.publicKey, 'value', AAD);
    const key = await kmsKey(ARN, awsKmsCalls('us-east-1'));
    expect(await openSecretWith(key, sealed, AAD)).toBe('value');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('picks KMS when configured, the PEM key in development, or nothing', async () => {
    const { kms } = fakeKms();
    expect((await loadCredentialKey({ CREDENTIALS_KMS_KEY_ID: ARN }, () => kms))?.keyId).toBe(
      keyIdOf(pair.publicKey),
    );
    expect((await loadCredentialKey({ CREDENTIALS_PRIVATE_KEY: pair.privateKey }))?.keyId).toBe(
      keyIdOf(pair.publicKey),
    );
    expect(await loadCredentialKey({})).toBeUndefined();
  });
});

describe('worker env for the credential key', () => {
  it('accepts a KMS key ARN and refuses anything else', () => {
    expect(loadWorkerEnv({ CREDENTIALS_KMS_KEY_ID: ARN }).CREDENTIALS_KMS_KEY_ID).toBe(ARN);
    expect(() => loadWorkerEnv({ CREDENTIALS_KMS_KEY_ID: 'alias/credentials' })).toThrow();
  });

  it('refuses both kinds of key at once', () => {
    expect(() =>
      loadWorkerEnv({ CREDENTIALS_KMS_KEY_ID: ARN, CREDENTIALS_PRIVATE_KEY: pair.privateKey }),
    ).toThrow('not both');
  });

  it('refuses a private key in the environment on Railway', () => {
    expect(() =>
      loadWorkerEnv({
        CREDENTIALS_PRIVATE_KEY: pair.privateKey,
        RAILWAY_ENVIRONMENT_NAME: 'staging',
      }),
    ).toThrow('local development only');
    expect(
      loadWorkerEnv({ CREDENTIALS_KMS_KEY_ID: ARN, RAILWAY_ENVIRONMENT_NAME: 'production' })
        .CREDENTIALS_KMS_KEY_ID,
    ).toBe(ARN);
  });
});
