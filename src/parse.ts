import { haversineKm } from './geo';

/** Kind of the segment that *ends* at a point (point i-1 -> point i). */
export const SEG_GROUND = 0;
export const SEG_FLIGHT = 1;
export const SEG_GAP = 2;

export const TZ_UNKNOWN = -32768;

export interface Stay {
  start: number;
  end: number;
  lat: number;
  lng: number;
}

export interface Dataset {
  count: number;
  /** Epoch milliseconds, ascending. */
  t: Float64Array;
  lat: Float64Array;
  lng: Float64Array;
  /** Local UTC offset in minutes at each point. */
  tz: Int16Array;
  /** Segment kind for i-1 -> i (index 0 is always ground). */
  kind: Uint8Array;
  stays: Stay[];
  stats: { semantic: number; raw: number; legacy: number; outliers: number };
}

interface RawPoint {
  t: number;
  lat: number;
  lng: number;
  tz: number;
}

interface Interval {
  start: number;
  end: number;
}

interface Collector {
  semantic: RawPoint[];
  raw: RawPoint[];
  legacy: RawPoint[];
  stays: Stay[];
  coverage: Interval[];
  flights: Interval[];
}

const RAW_MAX_ACCURACY_M = 100;
const FLIGHT_TYPES = new Set(['flying', 'in_flight', 'plane']);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseCoordinate(value: unknown): [number, number] | null {
  if (isObject(value)) {
    if (typeof value.latitudeE7 === 'number' && typeof value.longitudeE7 === 'number') {
      return validCoordinate(value.latitudeE7 / 1e7, value.longitudeE7 / 1e7);
    }
    if (typeof value.latE7 === 'number' && typeof value.lngE7 === 'number') {
      return validCoordinate(value.latE7 / 1e7, value.lngE7 / 1e7);
    }
    return parseCoordinate(value.latLng ?? value.LatLng ?? value.point);
  }
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^geo:/, '').split('?', 1)[0].replaceAll('°', '').replaceAll(' ', '');
  const parts = cleaned.split(',');
  if (parts.length < 2) return null;
  return validCoordinate(Number(parts[0]), Number(parts[1]));
}

function validCoordinate(lat: number, lng: number): [number, number] | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -85.05 || lat > 85.05 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return [lat, lng];
}

/** Parses an ISO timestamp. Returns the instant and the UTC offset written in the string, if any. */
export function parseTime(value: unknown): { t: number; tz: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return { t: value, tz: TZ_UNKNOWN };
  if (typeof value !== 'string' || value === '') return null;
  const text = value.trim();
  if (/^\d{10,14}$/.test(text)) return { t: Number(text), tz: TZ_UNKNOWN };
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(text);
  const hasZone = match !== null || /z$/i.test(text);
  const t = Date.parse(hasZone ? text : `${text}Z`);
  if (!Number.isFinite(t)) return null;
  const tz = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : TZ_UNKNOWN;
  return { t, tz };
}

function push(into: RawPoint[], time: unknown, coordinate: unknown, fallbackTz = TZ_UNKNOWN): RawPoint | null {
  const parsedTime = parseTime(time);
  const parsed = parseCoordinate(coordinate);
  if (!parsedTime || !parsed) return null;
  const point = {
    t: parsedTime.t,
    lat: parsed[0],
    lng: parsed[1],
    tz: parsedTime.tz === TZ_UNKNOWN ? fallbackTz : parsedTime.tz,
  };
  into.push(point);
  return point;
}

function offsetMinutes(value: unknown): number {
  const minutes = typeof value === 'string' ? Number(value) : value;
  return typeof minutes === 'number' && Number.isInteger(minutes) && Math.abs(minutes) <= 18 * 60 ? minutes : TZ_UNKNOWN;
}

function activityType(activity: Json): string {
  const candidate = isObject(activity.topCandidate) ? activity.topCandidate : null;
  const type = candidate?.type ?? activity.activityType ?? '';
  return typeof type === 'string' ? type.toLowerCase() : '';
}

/** Android / iOS on-device Timeline segment (semanticSegments item or direct array item). */
function collectSegment(segment: unknown, out: Collector): void {
  if (!isObject(segment)) return;
  const start = parseTime(segment.startTime);
  const end = parseTime(segment.endTime);
  const startTz = offsetMinutes(segment.startTimeTimezoneUtcOffsetMinutes);
  const endTz = offsetMinutes(segment.endTimeTimezoneUtcOffsetMinutes);

  if (isObject(segment.visit)) {
    const candidate = isObject(segment.visit.topCandidate) ? segment.visit.topCandidate : null;
    const location = candidate?.placeLocation;
    const first = push(out.semantic, segment.startTime, location, startTz);
    if (first) {
      const last = end ? push(out.semantic, segment.endTime, location, endTz === TZ_UNKNOWN ? startTz : endTz) : null;
      if (last && last.t > first.t) {
        out.stays.push({ start: first.t, end: last.t, lat: first.lat, lng: first.lng });
        out.coverage.push({ start: first.t, end: last.t });
      }
    }
  }

  if (isObject(segment.activity)) {
    const a = push(out.semantic, segment.startTime, segment.activity.start, startTz);
    const b = push(out.semantic, segment.endTime, segment.activity.end, endTz === TZ_UNKNOWN ? startTz : endTz);
    if (a && b && b.t >= a.t) {
      out.coverage.push({ start: a.t, end: b.t });
      if (FLIGHT_TYPES.has(activityType(segment.activity))) out.flights.push({ start: a.t, end: b.t });
    }
  }

  if (Array.isArray(segment.timelinePath)) {
    for (const node of segment.timelinePath) {
      if (!isObject(node)) continue;
      if (node.time !== undefined) {
        push(out.semantic, node.time, node.point, startTz);
      } else if (start && node.durationMinutesOffsetFromStartTime !== undefined) {
        const offset = Number(node.durationMinutesOffsetFromStartTime);
        if (Number.isFinite(offset)) push(out.semantic, start.t + offset * 60_000, node.point, start.tz === TZ_UNKNOWN ? startTz : start.tz);
      }
    }
  }
}

function collectRawSignal(signal: unknown, out: Collector): void {
  if (!isObject(signal) || !isObject(signal.position)) return;
  const position = signal.position;
  const accuracy = Number(position.accuracyMeters ?? 0);
  if (!Number.isFinite(accuracy) || accuracy > RAW_MAX_ACCURACY_M) return;
  push(out.raw, position.timestamp, position.LatLng ?? position.latLng);
}

/** Old Google Takeout Records.json. */
function collectLegacyRecord(record: unknown, out: Collector): void {
  if (!isObject(record)) return;
  const accuracy = Number(record.accuracy ?? 0);
  if (Number.isFinite(accuracy) && accuracy > RAW_MAX_ACCURACY_M * 2) return;
  const time = record.timestamp ?? (record.timestampMs !== undefined ? Number(record.timestampMs) : undefined);
  push(out.legacy, time, record);
}

/** Old Google Takeout "Semantic Location History" monthly files. */
function collectLegacyTimelineObject(item: unknown, out: Collector): void {
  if (!isObject(item)) return;
  if (isObject(item.placeVisit)) {
    const visit = item.placeVisit;
    const duration = isObject(visit.duration) ? visit.duration : {};
    const first = push(out.semantic, duration.startTimestamp ?? duration.startTimestampMs, visit.location);
    const last = push(out.semantic, duration.endTimestamp ?? duration.endTimestampMs, visit.location);
    if (first && last && last.t > first.t) {
      out.stays.push({ start: first.t, end: last.t, lat: first.lat, lng: first.lng });
      out.coverage.push({ start: first.t, end: last.t });
    }
  }
  if (isObject(item.activitySegment)) {
    const activity = item.activitySegment;
    const duration = isObject(activity.duration) ? activity.duration : {};
    const a = push(out.semantic, duration.startTimestamp ?? duration.startTimestampMs, activity.startLocation);
    // waypointPath has no timestamps, so only the timed raw path is usable.
    const path = isObject(activity.simplifiedRawPath) ? activity.simplifiedRawPath.points : null;
    if (Array.isArray(path)) {
      for (const node of path) {
        if (isObject(node)) push(out.semantic, node.timestamp ?? node.timestampMs, node);
      }
    }
    const b = push(out.semantic, duration.endTimestamp ?? duration.endTimestampMs, activity.endLocation);
    if (a && b && b.t >= a.t) {
      out.coverage.push({ start: a.t, end: b.t });
      const type = typeof activity.activityType === 'string' ? activity.activityType.toLowerCase() : '';
      if (FLIGHT_TYPES.has(type)) out.flights.push({ start: a.t, end: b.t });
    }
  }
}

export function newCollector(): Collector {
  return { semantic: [], raw: [], legacy: [], stays: [], coverage: [], flights: [] };
}

/** Adds one parsed JSON document. Throws if the format is not recognised. */
export function collectDocument(data: unknown, out: Collector): void {
  if (Array.isArray(data)) {
    for (const segment of data) collectSegment(segment, out);
    return;
  }
  if (!isObject(data)) throw new Error('Unrecognised file: expected a JSON object or array.');
  let recognised = false;
  if (Array.isArray(data.semanticSegments)) {
    recognised = true;
    for (const segment of data.semanticSegments) collectSegment(segment, out);
  }
  if (Array.isArray(data.rawSignals)) {
    recognised = true;
    for (const signal of data.rawSignals) collectRawSignal(signal, out);
  }
  if (Array.isArray(data.locations)) {
    recognised = true;
    for (const record of data.locations) collectLegacyRecord(record, out);
  }
  if (Array.isArray(data.timelineObjects)) {
    recognised = true;
    for (const item of data.timelineObjects) collectLegacyTimelineObject(item, out);
  }
  if (!recognised) {
    throw new Error('Unrecognised file: no semanticSegments, rawSignals, locations or timelineObjects found.');
  }
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function covered(t: number, intervals: Interval[]): boolean {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (t < intervals[middle].start) high = middle - 1;
    else if (t > intervals[middle].end) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * Removes single-point GPS spikes: a point far from both neighbours while the
 * neighbours agree with each other, reached at an implausible speed.
 */
export function removeSpikes(points: RawPoint[]): { points: RawPoint[]; removed: number } {
  if (points.length < 3) return { points, removed: 0 };
  const kept: RawPoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const before = kept[kept.length - 1];
    const candidate = points[i];
    const after = points[i + 1];
    const dIn = haversineKm(before.lat, before.lng, candidate.lat, candidate.lng);
    const dOut = haversineKm(candidate.lat, candidate.lng, after.lat, after.lng);
    const dSkip = haversineKm(before.lat, before.lng, after.lat, after.lng);
    if (dIn > 2 && dOut > 2 && dSkip < 0.3 * Math.min(dIn, dOut)) {
      const hoursIn = Math.max(1 / 3600, (candidate.t - before.t) / 3.6e6);
      const hoursOut = Math.max(1 / 3600, (after.t - candidate.t) / 3.6e6);
      if (dIn / hoursIn > 250 || dOut / hoursOut > 250) continue;
    }
    kept.push(candidate);
  }
  kept.push(points[points.length - 1]);
  return { points: kept, removed: points.length - kept.length };
}

function fillTimeZones(points: RawPoint[]): void {
  let last = TZ_UNKNOWN;
  for (const point of points) {
    if (point.tz === TZ_UNKNOWN) point.tz = last;
    else last = point.tz;
  }
  last = TZ_UNKNOWN;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i].tz === TZ_UNKNOWN) points[i].tz = last;
    else last = points[i].tz;
  }
  const fallback = -new Date().getTimezoneOffset();
  for (const point of points) if (point.tz === TZ_UNKNOWN) point.tz = fallback;
}

export function finishDataset(out: Collector): Dataset {
  const coverage = mergeIntervals(out.coverage);
  const flights = mergeIntervals(out.flights.map((f) => ({ start: f.start - 60_000, end: f.end + 60_000 })));
  // Semantic reconstruction wins; raw and legacy samples only fill uncovered time.
  const extra = [...out.raw, ...out.legacy].filter((point) => !covered(point.t, coverage));
  const all = [...out.semantic, ...extra].sort((a, b) => a.t - b.t);
  const unique: RawPoint[] = [];
  for (const point of all) {
    const last = unique[unique.length - 1];
    if (last && last.t === point.t) {
      if (Math.abs(last.lat - point.lat) < 1e-6 && Math.abs(last.lng - point.lng) < 1e-6) continue;
      // Same instant, different place (e.g. visit end vs next activity start): keep both, 1 ms apart.
      point.t = last.t + 1;
    }
    unique.push(point);
  }
  const { points, removed } = removeSpikes(unique);
  if (points.length === 0) throw new Error('No usable location points were found in this file.');
  fillTimeZones(points);

  const count = points.length;
  const t = new Float64Array(count);
  const lat = new Float64Array(count);
  const lng = new Float64Array(count);
  const tz = new Int16Array(count);
  const kind = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const point = points[i];
    t[i] = point.t;
    lat[i] = point.lat;
    lng[i] = point.lng;
    tz[i] = point.tz;
    if (i === 0) continue;
    const previous = points[i - 1];
    const km = haversineKm(previous.lat, previous.lng, point.lat, point.lng);
    const hours = Math.max(1 / 60, (point.t - previous.t) / 3.6e6);
    const inFlight = covered(previous.t, flights) && covered(point.t, flights);
    if (km > 80 && (inFlight || (km > 150 && km / hours > 180))) kind[i] = SEG_FLIGHT;
    else if (km > 30 && hours > 12) kind[i] = SEG_GAP;
  }
  const stays = out.stays
    .filter((stay) => stay.end - stay.start >= 20 * 60_000)
    .sort((a, b) => a.start - b.start);
  return {
    count, t, lat, lng, tz, kind, stays,
    stats: { semantic: out.semantic.length, raw: out.raw.length, legacy: out.legacy.length, outliers: removed },
  };
}

export function parseDocuments(documents: unknown[]): Dataset {
  const out = newCollector();
  for (const document of documents) collectDocument(document, out);
  return finishDataset(out);
}
