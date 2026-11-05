import { describe, expect, it } from 'vitest';
import { profileUpdateSchema } from './profile';

const valid = { displayName: 'Ana', timezone: 'Asia/Tokyo', baseCurrency: 'usd', locale: 'en-US' };

describe('profileUpdateSchema', () => {
  it('accepts a valid profile and normalises currency case', () => {
    expect(profileUpdateSchema.parse(valid)).toEqual({ ...valid, baseCurrency: 'USD' });
  });

  it('accepts UTC', () => {
    expect(profileUpdateSchema.safeParse({ ...valid, timezone: 'UTC' }).success).toBe(true);
  });

  it.each([
    ['displayName', '   '],
    ['timezone', 'Mars/Olympus'],
    ['timezone', 'EST5EDT; drop table'],
    ['baseCurrency', 'XYZW'],
    ['locale', 'xx-XX'],
  ])('rejects invalid %s %j', (field, value) => {
    expect(profileUpdateSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });
});
