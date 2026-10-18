import { describe, expect, it } from 'vitest';
import { analyze } from './analysis';
import { buildCameraTrack, blendCameras, cameraAt, type Frame } from './camera';
import { buildJourney, positionAt, progressAtTime } from './journey';
import { parseCoordinate, parseDocuments, parseTime, SEG_FLIGHT, TZ_UNKNOWN } from './parse';
import { CityIndex } from './places';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00');

/** A day of wandering around a city: one point every 10 minutes within ~3 km. */
function cityDay(start: number, lat: number, lng: number) {
  return Array.from({ length: 6 * 14 }, (_, k) => ({
    point: `${(lat + 0.02 * Math.sin(k / 7)).toFixed(5)}°, ${(lng + 0.02 * Math.cos(k / 5)).toFixed(5)}°`,
    time: iso(start + 8 * HOUR + k * 10 * 60_000),
  }));
}

const T0 = Date.UTC(2025, 4, 1);
const DELHI = [28.61, 77.21] as const;
const MUMBAI = [19.08, 72.88] as const;

/** Delhi (home) → 3 days in Mumbai via flights → back to Delhi. */
function tripFixture() {
  const segments: unknown[] = [];
  for (let d = 0; d < 3; d += 1) segments.push({ timelinePath: cityDay(T0 + d * 24 * HOUR, ...DELHI) });
  const out = T0 + 3 * 24 * HOUR + 7 * HOUR;
  segments.push({
    startTime: iso(out), endTime: iso(out + 2 * HOUR),
    activity: { start: { latLng: `${DELHI[0]}°, ${DELHI[1]}°` }, end: { latLng: `${MUMBAI[0]}°, ${MUMBAI[1]}°` }, topCandidate: { type: 'FLYING' } },
  });
  for (let d = 3; d < 6; d += 1) segments.push({ timelinePath: cityDay(T0 + d * 24 * HOUR + 4 * HOUR, ...MUMBAI) });
  const back = T0 + 6 * 24 * HOUR + 9 * HOUR;
  segments.push({
    startTime: iso(back), endTime: iso(back + 2 * HOUR),
    activity: { start: `geo:${MUMBAI[0]},${MUMBAI[1]}`, end: `geo:${DELHI[0]},${DELHI[1]}`, topCandidate: { type: 'flying' } },
  });
  for (let d = 7; d < 10; d += 1) segments.push({ timelinePath: cityDay(T0 + d * 24 * HOUR, ...DELHI) });
  return { semanticSegments: segments };
}

const FRAME: Frame = { width: 960, height: 540, safe: { left: 22, top: 112, right: 938, bottom: 482 } };

describe('parsing', () => {
  it('reads every coordinate style', () => {
    expect(parseCoordinate('28.6743117°, 77.2028737°')).toEqual([28.6743117, 77.2028737]);
    expect(parseCoordinate('geo:37.5665,126.9780')).toEqual([37.5665, 126.978]);
    expect(parseCoordinate({ latLng: '1.5°, 2.5°' })).toEqual([1.5, 2.5]);
    expect(parseCoordinate({ latitudeE7: 515000000, longitudeE7: -1000000 })).toEqual([51.5, -0.1]);
    expect(parseCoordinate('nonsense')).toBeNull();
  });

  it('keeps the recorded UTC offset', () => {
    expect(parseTime('2016-05-30T13:30:00.000+05:30')).toEqual({ t: Date.UTC(2016, 4, 30, 8, 0), tz: 330 });
    expect(parseTime('2025-01-10T00:00:00Z')?.tz).toBe(TZ_UNKNOWN);
  });

  it('parses on-device, iOS array and legacy Records formats', () => {
    const android = parseDocuments([tripFixture()]);
    expect(android.count).toBeGreaterThan(400);
    expect([...android.kind].filter((k) => k === SEG_FLIGHT)).toHaveLength(2);

    const ios = parseDocuments([[{
      startTime: '2025-03-18T00:00:00Z',
      timelinePath: [
        { point: 'geo:37.4563,126.7052', durationMinutesOffsetFromStartTime: '0' },
        { point: 'geo:36.3504,127.3845', durationMinutesOffsetFromStartTime: '60' },
      ],
    }]]);
    expect(ios.t[1] - ios.t[0]).toBe(HOUR);

    const legacy = parseDocuments([{ locations: [
      { latitudeE7: 515000000, longitudeE7: -1000000, timestamp: '2014-01-01T00:00:00Z', accuracy: 20 },
      { latitudeE7: 515100000, longitudeE7: -1100000, timestampMs: '1388538000000', accuracy: 20 },
    ] }]);
    expect(legacy.count).toBe(2);
  });

  it('prefers semantic data and drops raw signals inside it', () => {
    const dataset = parseDocuments([{
      semanticSegments: [{
        startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-03T00:00:00Z',
        activity: { start: 'geo:37.5665,126.9780', end: 'geo:37.5700,126.9800' },
      }],
      rawSignals: [
        { position: { LatLng: '37.0°, 127.0°', timestamp: '2026-01-02T00:00:00Z', accuracyMeters: 10 } },
        { position: { LatLng: '37.5°, 127.0°', timestamp: '2026-02-01T00:00:00Z', accuracyMeters: 10 } },
        { position: { LatLng: '37.6°, 127.0°', timestamp: '2026-02-02T00:00:00Z', accuracyMeters: 900 } },
      ],
    }]);
    expect(dataset.count).toBe(3);
  });

  it('removes single-point GPS spikes', () => {
    const dataset = parseDocuments([[{
      startTime: '2026-01-01T00:00:00Z',
      timelinePath: [
        { point: 'geo:37.5665,126.9780', time: '2026-01-01T00:00:00Z' },
        { point: 'geo:10.0,-50.0', time: '2026-01-01T00:10:00Z' },
        { point: 'geo:37.5700,126.9800', time: '2026-01-01T00:20:00Z' },
      ],
    }]]);
    expect(dataset.count).toBe(2);
    expect(dataset.stats.outliers).toBe(1);
  });
});

describe('story clock', () => {
  const dataset = parseDocuments([tripFixture()]);
  const journey = buildJourney(dataset, -Infinity, Infinity, { durationSec: 30, pace: 1 })!;

  it('spends real screen time in each city, not just on distance', () => {
    const mumbaiStart = progressAtTime(journey, T0 + 3 * 24 * HOUR + 10 * HOUR);
    const mumbaiEnd = progressAtTime(journey, T0 + 6 * 24 * HOUR + 8 * HOUR);
    // ~3 of 10 days are in Mumbai; distance-only pacing would give them almost nothing.
    expect(mumbaiEnd - mumbaiStart).toBeGreaterThan(0.2);
  });

  it('gives each flight a readable minimum duration', () => {
    const first = [...journey.kind].indexOf(SEG_FLIGHT);
    const seconds = (journey.p[first] - journey.p[first - 1]) * 30;
    expect(seconds).toBeGreaterThan(1.1);
    expect(seconds).toBeLessThan(3);
  });

  it('moves along an arc during flights', () => {
    const first = [...journey.kind].indexOf(SEG_FLIGHT);
    const middle = positionAt(journey, (journey.p[first] + journey.p[first - 1]) / 2);
    const straightY = (journey.y[first] + journey.y[first - 1]) / 2;
    expect(middle.kind).toBe(SEG_FLIGHT);
    expect(middle.y).toBeLessThan(straightY); // bulges north
  });
});

describe('camera', () => {
  const dataset = parseDocuments([tripFixture()]);
  const journey = buildJourney(dataset, -Infinity, Infinity, { durationSec: 30, pace: 1 })!;
  const track = buildCameraTrack(journey, FRAME);
  const zoomAtTime = (time: number) => cameraAt(track, progressAtTime(journey, time)).zoom;

  it('zooms out for a flight and back in after landing', () => {
    const inDelhi = zoomAtTime(T0 + 1 * 24 * HOUR + 12 * HOUR);
    const first = [...journey.kind].indexOf(SEG_FLIGHT);
    const midFlight = cameraAt(track, (journey.p[first] + journey.p[first - 1]) / 2).zoom;
    const inMumbai = zoomAtTime(T0 + 4 * 24 * HOUR + 16 * HOUR);
    const homeAgain = zoomAtTime(T0 + 8 * 24 * HOUR + 14 * HOUR);
    expect(inDelhi).toBeGreaterThan(midFlight + 3);
    expect(inMumbai).toBeGreaterThan(midFlight + 3);
    expect(homeAgain).toBeGreaterThan(midFlight + 3);
  });

  it('keeps the marker inside the frame', () => {
    for (let s = 0; s <= 400; s += 1) {
      const progress = s / 400;
      const camera = cameraAt(track, progress);
      const marker = positionAt(journey, progress);
      const scale = 512 * 2 ** camera.zoom;
      const sx = (marker.x - camera.x) * scale + FRAME.width / 2;
      const sy = (marker.y - camera.y) * scale + FRAME.height / 2;
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sx).toBeLessThanOrEqual(FRAME.width);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sy).toBeLessThanOrEqual(FRAME.height);
    }
  });

  it('changes zoom smoothly', () => {
    let maxStep = 0;
    for (let s = 1; s <= track.samples; s += 1) maxStep = Math.max(maxStep, Math.abs(track.zoom[s] - track.zoom[s - 1]));
    // At 12 samples per second, never more than ~5 zoom levels per second (no jumps).
    expect(maxStep).toBeLessThan(0.42);
  });

  it('blends cameras as a zoom around a fixed point', () => {
    const a = { x: 0.5, y: 0.5, zoom: 10 };
    const b = { x: 0.6, y: 0.5, zoom: 4 };
    expect(blendCameras(a, b, 0)).toEqual(a);
    const end = blendCameras(a, b, 1);
    expect(end.x).toBeCloseTo(0.6);
    expect(end.zoom).toBeCloseTo(4);
  });
});

describe('trips and places', () => {
  const cities = new CityIndex([
    { name: 'Delhi', cc: 'IN', lat: 28.65, lng: 77.23, pop: 11_000_000 },
    { name: 'Rohini Town', cc: 'IN', lat: 28.62, lng: 77.2, pop: 50_000 },
    { name: 'Mumbai', cc: 'IN', lat: 19.07, lng: 72.88, pop: 12_000_000 },
  ]);

  it('prefers the big city over a small nearby town', () => {
    expect(cities.cities[cities.lookup(28.61, 77.21)].name).toBe('Delhi');
    expect(cities.lookup(0, 0)).toBe(-1);
  });

  it('detects a trip away from home and names it', () => {
    const dataset = parseDocuments([tripFixture()]);
    const analysis = analyze(dataset, cities);
    expect(cities.cities[analysis.homeCity].name).toBe('Delhi');
    expect(analysis.trips).toHaveLength(1);
    expect(analysis.trips[0].label).toBe('Mumbai');
    expect(analysis.trips[0].days).toBeGreaterThanOrEqual(3);
  });
});
