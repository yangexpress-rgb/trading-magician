import { describe, expect, it } from 'vitest';
import { loadWebEnv } from './env';

describe('web env', () => {
  it('applies defaults', () => {
    expect(loadWebEnv({})).toMatchObject({
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:3000',
    });
  });

  it('rejects a malformed APP_URL', () => {
    expect(() => loadWebEnv({ APP_URL: 'nope' })).toThrowError(/APP_URL: is invalid/);
  });
});
