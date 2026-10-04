import { describe, expect, it } from 'vitest';
import { formatDateTime, formatDateTimeWithZone, isValidTimeZone } from './time';

const instant = '2026-03-09T14:30:00Z';

describe('formatDateTime', () => {
  it('renders the same instant in different zones', () => {
    const ny = formatDateTime(instant, { timeZone: 'America/New_York', locale: 'en-US' });
    const tokyo = formatDateTime(instant, { timeZone: 'Asia/Tokyo', locale: 'en-US' });
    expect(ny).toMatch(/10:30/); // EDT began 2026-03-08
    expect(tokyo).toMatch(/11:30/);
    expect(tokyo).toMatch(/Mar 9/);
  });

  it('names the zone when asked', () => {
    expect(formatDateTimeWithZone(instant, { timeZone: 'UTC', locale: 'en-GB' })).toMatch(/UTC/);
  });

  it('rejects invalid dates', () => {
    expect(() => formatDateTime('not a date', { timeZone: 'UTC', locale: 'en-US' })).toThrow(
      RangeError,
    );
  });
});

describe('isValidTimeZone', () => {
  it.each(['UTC', 'Europe/London', 'America/New_York'])('accepts %s', (z) => {
    expect(isValidTimeZone(z)).toBe(true);
  });
  it.each(['Mars/Base', '', 'EST5EDT; drop'])('rejects %j', (z) => {
    expect(isValidTimeZone(z)).toBe(false);
  });
});
