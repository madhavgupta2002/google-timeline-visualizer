export type DistanceUnit = 'km' | 'mi';

const KM_PER_MILE = 1.609344;

export function formatDistance(km: number, unit: DistanceUnit): string {
  const value = unit === 'mi' ? km / KM_PER_MILE : km;
  const digits = value < 10 ? 1 : 0;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${unit}`;
}

/** Formats an instant in the local time zone it was recorded in. */
export function formatLocal(t: number, tzMinutes: number, options: Intl.DateTimeFormatOptions): string {
  return new Date(t + tzMinutes * 60_000).toLocaleString(undefined, { ...options, timeZone: 'UTC' });
}

export function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 36) return `${Math.round(hours)} h`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)} days`;
}

/** yyyy-mm-dd for <input type="date">, in the given offset. */
export function isoDate(t: number, tzMinutes: number): string {
  return new Date(t + tzMinutes * 60_000).toISOString().slice(0, 10);
}
