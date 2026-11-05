import { describe, expect, it } from 'vitest';
import { loadOwnerDbEnv, loadRuntimeDbEnv } from './env';

describe('database env', () => {
  it('requires a postgres URL for each runtime role', () => {
    expect(() => loadRuntimeDbEnv({ DATABASE_APP_URL: 'postgres://a@h/db' })).toThrowError(
      /DATABASE_AUTH_URL: is required/,
    );
    expect(() => loadOwnerDbEnv({ DATABASE_URL: 'mysql://h/db' })).toThrowError(
      /DATABASE_URL: is invalid/,
    );
  });

  it('accepts postgres and postgresql schemes', () => {
    expect(
      loadRuntimeDbEnv({
        DATABASE_APP_URL: 'postgres://a@h/db',
        DATABASE_AUTH_URL: 'postgresql://b@h/db',
      }),
    ).toEqual({ DATABASE_APP_URL: 'postgres://a@h/db', DATABASE_AUTH_URL: 'postgresql://b@h/db' });
  });
});
