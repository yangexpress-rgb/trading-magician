import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDateTimeWithZone,
  isoToZonedWallTime,
  isValidTimeZone,
  zonedWallTimeToIso,
} from './time';

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

describe('zoned wall times', () => {
  it('adds the zone offset for the date, including daylight saving', () => {
    expect(zonedWallTimeToIso('2027-01-15T09:30', 'America/New_York')).toBe(
      '2027-01-15T09:30:00-05:00',
    );
    expect(zonedWallTimeToIso('2027-07-15T09:30', 'America/New_York')).toBe(
      '2027-07-15T09:30:00-04:00',
    );
    expect(zonedWallTimeToIso('2027-07-15T09:30', 'UTC')).toBe('2027-07-15T09:30:00+00:00');
    expect(zonedWallTimeToIso('2027-07-15T09:30', 'Asia/Kolkata')).toBe(
      '2027-07-15T09:30:00+05:30',
    );
  });

  it('moves a time in a spring-forward gap to a real instant', () => {
    // 02:30 does not exist in New York on 2027-03-14.
    const iso = zonedWallTimeToIso('2027-03-14T02:30', 'America/New_York');
    expect(iso).toBe('2027-03-14T03:30:00-04:00');
  });

  it('picks the earlier instant for a repeated fall-back hour', () => {
    expect(zonedWallTimeToIso('2027-11-07T01:30', 'America/New_York')).toBe(
      '2027-11-07T01:30:00-04:00',
    );
  });

  it('round-trips with isoToZonedWallTime', () => {
    for (const zone of ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Adelaide']) {
      const iso = zonedWallTimeToIso('2027-11-02T16:45', zone)!;
      expect(isoToZonedWallTime(iso, zone)).toBe('2027-11-02T16:45');
    }
  });

  it('rejects malformed input and unknown zones', () => {
    expect(zonedWallTimeToIso('15/01/2027 09:30', 'UTC')).toBeUndefined();
    expect(zonedWallTimeToIso('2027-01-15T09:30', 'Mars/Olympus')).toBeUndefined();
    expect(isoToZonedWallTime('nope', 'UTC')).toBeUndefined();
  });
});
