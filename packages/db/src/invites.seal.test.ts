import { describe, expect, it } from 'vitest';
import { generateInviteCode, inviteCodeKey, openInviteCode, sealInviteCode } from './invites';

describe('sealed invite codes (N238, ADR 0085)', () => {
  const key = inviteCodeKey('a'.repeat(32));

  it('opens what it sealed, with a fresh nonce each time', () => {
    const code = generateInviteCode();
    const a = sealInviteCode(code, key);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toBe(sealInviteCode(code, key));
    expect(openInviteCode(a, key)).toBe(code);
  });

  it('refuses another key, a damaged value or an unknown version', () => {
    const sealed = sealInviteCode(generateInviteCode(), key);
    expect(openInviteCode(sealed, inviteCodeKey('b'.repeat(32)))).toBeNull();
    expect(openInviteCode(`${sealed.slice(0, -2)}AA`, key)).toBeNull();
    expect(openInviteCode(`v2.${sealed.slice(3)}`, key)).toBeNull();
  });
});
