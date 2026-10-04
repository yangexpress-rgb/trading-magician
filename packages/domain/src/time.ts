/**
 * Timestamps are stored in UTC and shown in the user's chosen zone (Design v1.0 §5.1).
 */
export interface DisplayPreferences {
  timeZone: string;
  locale: string;
}

export function formatDateTime(
  instant: Date | string | number,
  prefs: DisplayPreferences,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  return new Intl.DateTimeFormat(prefs.locale, { ...options, timeZone: prefs.timeZone }).format(
    date,
  );
}

/** Like formatDateTime but always names the zone, for times users act on. */
export function formatDateTimeWithZone(instant: Date | string | number, prefs: DisplayPreferences) {
  return formatDateTime(instant, prefs, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
