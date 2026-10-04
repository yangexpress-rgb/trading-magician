import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvValidationError, parseEnv, pemKey } from './env';

describe('parseEnv', () => {
  const shape = { DATABASE_URL: z.string().url(), PORT: z.coerce.number().int().default(3000) };

  it('returns typed values and applies defaults', () => {
    expect(parseEnv(shape, { DATABASE_URL: 'postgres://localhost/db' })).toEqual({
      DATABASE_URL: 'postgres://localhost/db',
      PORT: 3000,
    });
  });

  it('reports missing variables by name', () => {
    expect(() => parseEnv(shape, {})).toThrowError(/DATABASE_URL: is required/);
  });

  it('never echoes the value of an invalid variable', () => {
    const secret = 'not-a-url-but-a-s3cret';
    try {
      parseEnv(shape, { DATABASE_URL: secret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain('DATABASE_URL: is invalid');
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('pemKey', () => {
  const shape = { KEY: pemKey('PUBLIC KEY') };

  it('accepts a key stored on one line with escaped line breaks', () => {
    const oneLine = '-----BEGIN PUBLIC KEY-----\\nMIIB\\n-----END PUBLIC KEY-----';
    expect(parseEnv(shape, { KEY: oneLine }).KEY).toBe(
      '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
    );
  });

  it('rejects the wrong kind of key without echoing it', () => {
    const priv = '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----';
    expect(() => parseEnv(shape, { KEY: priv })).toThrowError(/KEY: is invalid/);
    try {
      parseEnv(shape, { KEY: priv });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-material');
    }
  });
});
