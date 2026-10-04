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

/** Offset of `zone` from UTC at `instant`, in minutes (e.g. -240 for New York in summer). */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');

function formatOffset(minutes: number): string {
  return `${minutes < 0 ? '-' : '+'}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * Converts a wall-clock time in `zone` ("2027-01-15T09:30") to ISO 8601 with an
 * explicit offset ("2027-01-15T09:30:00-05:00"), so stored times always carry
 * their zone (§6.8). In a DST gap the time moves forward by the gap; in an
 * overlap the earlier instant wins. Returns undefined for malformed input.
 */
export function zonedWallTimeToIso(local: string, zone: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (!m || !isValidTimeZone(zone)) return undefined;
  const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = m.slice(1).map((v) => Number(v ?? 0));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(wall)) return undefined;
  // Around a DST change the zone has two offsets. Prefer the earliest instant whose
  // offset matches; in a gap no offset matches, so use the one before the change.
  const before = zoneOffsetMinutes(new Date(wall - 86_400_000), zone);
  const after = zoneOffsetMinutes(new Date(wall + 86_400_000), zone);
  const candidates = [...new Set([before, after])]
    .map((o) => wall - o * 60_000)
    .filter((t) => wall - zoneOffsetMinutes(new Date(t), zone) * 60_000 === t)
    .sort((a, b) => a - b);
  const instant = new Date(candidates[0] ?? wall - before * 60_000);
  const offset = zoneOffsetMinutes(instant, zone);
  const shown = isoToZonedWallTime(instant.toISOString(), zone);
  return `${shown ?? local}:${pad(instant.getUTCSeconds())}${formatOffset(offset)}`;
}

/** The wall-clock time ("YYYY-MM-DDTHH:mm") of an instant in `zone`, for date-time inputs. */
export function isoToZonedWallTime(iso: string, zone: string): string | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t) || !isValidTimeZone(zone)) return undefined;
  const local = new Date(t + zoneOffsetMinutes(new Date(t), zone) * 60_000);
  return local.toISOString().slice(0, 16);
}
