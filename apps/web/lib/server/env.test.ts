import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { loadServerEnv } = await import('./env');

const base = {
  APP_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  DATABASE_APP_URL: 'postgres://app@localhost/tm',
  DATABASE_AUTH_URL: 'postgres://auth@localhost/tm',
};

describe('email verification setting (ADR 0036)', () => {
  it('requires verification unless switched off', () => {
    expect(loadServerEnv(base).EMAIL_VERIFICATION).toBe('required');
    expect(loadServerEnv({ ...base, EMAIL_VERIFICATION: 'off' }).EMAIL_VERIFICATION).toBe('off');
  });

  it('refuses no email with open sign-up, since the invite code is then the only gate', () => {
    expect(() =>
      loadServerEnv({ ...base, EMAIL_VERIFICATION: 'off', SIGNUP_MODE: 'open' }),
    ).toThrow('needs SIGNUP_MODE=invite');
  });
});
