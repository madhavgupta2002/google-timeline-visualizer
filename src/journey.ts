import { SEG_FLIGHT, SEG_GAP, type Dataset, type Stay } from './parse';
import { clamp, haversineKm, lowerBound, mercatorX, mercatorY, unwrapNear, upperBound } from './geo';

export interface JourneySettings {
  /** Seconds of animation the journey is paced for (video duration, preview speed 1x). */
  durationSec: number;
  /** 0 = pure elapsed time, 1 = balanced, 2 = movement-heavy. */
  pace: number;
}

/**
 * A selected slice of the dataset, re-timed onto a "story clock".
 *
 * The original visualizer animated by distance only, so days spent in one
 * city flashed by in a frame. Here every segment gets story time from both
 * the time it took (stationary gaps capped) and how fast you moved, while
 * flights get a guaranteed minimum on-screen duration.
 */
export interface Journey {
  dataset: Dataset;
  i0: number;
  n: number;
  t: Float64Array;
  /** Mercator coordinates, x unwrapped so the path is continuous across the antimeridian. */
  x: Float64Array;
  y: Float64Array;
  /** Story progress in [0, 1] for each point. */
  p: Float64Array;
  /** Cumulative distance in km. */
  km: Float64Array;
  kind: Uint8Array;
  /** Quadratic bezier control points for flight and gap segments (NaN for ground). */
  ctrlX: Float64Array;
  ctrlY: Float64Array;
  stays: Stay[];
  startTime: number;
  endTime: number;
  totalKm: number;
  flightCount: number;
  settings: JourneySettings;
}

export interface Position {
  x: number;
  y: number;
  /** Index (journey-local) of the segment end point; the marker is between index-1 and index. */
  index: number;
  fraction: number;
  t: number;
  km: number;
  kind: number;
  /** Direction of travel in screen space (radians, 0 = east). */
  heading: number;
}

const FLIGHT_MIN_SECONDS = 1.6;
const FLIGHT_MAX_SHARE = 0.35;

export function arcControl(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [x0, y0];
  let px = -dy / length;
  let py = dx / length;
  if (py > 0 || (py === 0 && px > 0)) {
    px = -px;
    py = -py;
  }
  return [(x0 + x1) / 2 + px * length * 0.18, (y0 + y1) / 2 + py * length * 0.18];
}

export function storyWeights(
  dtHours: number,
  km: number,
  kind: number,
  pace: number,
): number {
  if (kind === SEG_GAP) return 0.5 + 0.5 * Math.log2(1 + km / 100);
  if (kind === SEG_FLIGHT) return 1 + Math.log2(1 + km / 100);
  const speed = km / Math.max(dtHours, 1 / 60);
  const cappedHours = Math.min(dtHours, speed < 2 ? 3 : 12);
  return cappedHours * (1 + pace * Math.log2(1 + speed / 5));
}

export function buildJourney(
  dataset: Dataset,
  startTime: number,
  endTime: number,
  settings: JourneySettings,
): Journey | null {
  const i0 = lowerBound(dataset.t, startTime);
  const i1 = upperBound(dataset.t, endTime) - 1;
  if (i1 < i0) return null;
  const n = i1 - i0 + 1;
  const t = dataset.t.subarray(i0, i1 + 1);
  const kind = dataset.kind.slice(i0, i1 + 1);
  kind[0] = 0;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const km = new Float64Array(n);
  const ctrlX = new Float64Array(n).fill(Number.NaN);
  const ctrlY = new Float64Array(n).fill(Number.NaN);
  const weights = new Float64Array(n);
  let flightCount = 0;
  for (let k = 0; k < n; k += 1) {
    const i = i0 + k;
    const rawX = mercatorX(dataset.lng[i]);
    x[k] = k === 0 ? rawX : unwrapNear(rawX, x[k - 1]);
    y[k] = mercatorY(dataset.lat[i]);
    if (k === 0) continue;
    const segmentKm = haversineKm(dataset.lat[i - 1], dataset.lng[i - 1], dataset.lat[i], dataset.lng[i]);
    km[k] = km[k - 1] + (kind[k] === SEG_GAP ? 0 : segmentKm);
    weights[k] = storyWeights((t[k] - t[k - 1]) / 3.6e6, segmentKm, kind[k], settings.pace);
    if (kind[k] !== 0) {
      const [cx, cy] = arcControl(x[k - 1], y[k - 1], x[k], y[k]);
      ctrlX[k] = cx;
      ctrlY[k] = cy;
    }
    if (kind[k] === SEG_FLIGHT && kind[k - 1] !== SEG_FLIGHT) flightCount += 1;
  }

  // Give every flight enough screen time to read, without letting flights take over.
  // A flight recorded with several points is one run of consecutive flight segments.
  if (flightCount > 0) {
    let ground = 0;
    for (let k = 1; k < n; k += 1) if (kind[k] !== SEG_FLIGHT) ground += weights[k];
    const duration = Math.max(1, settings.durationSec);
    const perFlight = Math.min(FLIGHT_MIN_SECONDS, (FLIGHT_MAX_SHARE * duration) / flightCount);
    const flightWeight = ground > 0 ? (perFlight * ground) / Math.max(1e-6, duration - flightCount * perFlight) : 1;
    for (let k = 1; k < n; k += 1) {
      if (kind[k] !== SEG_FLIGHT) continue;
      let end = k;
      while (end + 1 < n && kind[end + 1] === SEG_FLIGHT) end += 1;
      const runKm = km[end] - km[k - 1];
      const longness = clamp(Math.log(runKm / 150) / Math.log(100), 0, 1);
      const runWeight = flightWeight * (0.75 + 0.5 * longness);
      for (let j = k; j <= end; j += 1) {
        weights[j] = runWeight * (runKm > 0 ? (km[j] - km[j - 1]) / runKm : 1 / (end - k + 1));
      }
      k = end;
    }
  }

  const p = new Float64Array(n);
  let total = 0;
  for (let k = 1; k < n; k += 1) total += weights[k];
  if (total > 0) {
    let running = 0;
    for (let k = 1; k < n; k += 1) {
      running += weights[k];
      p[k] = running / total;
    }
  } else {
    for (let k = 0; k < n; k += 1) p[k] = n === 1 ? 0 : k / (n - 1);
  }
  if (n > 1) p[n - 1] = 1;

  const stays = dataset.stays.filter((stay) => stay.end >= t[0] && stay.start <= t[n - 1]);
  return {
    dataset, i0, n, t, x, y, p, km, kind, ctrlX, ctrlY, stays,
    startTime: t[0],
    endTime: t[n - 1],
    totalKm: km[n - 1],
    flightCount,
    settings,
  };
}

function bezier(a: number, c: number, b: number, f: number): number {
  const u = 1 - f;
  return u * u * a + 2 * u * f * c + f * f * b;
}

export function positionAt(journey: Journey, progress: number): Position {
  const { n, p, x, y, t, km, kind } = journey;
  if (n === 1) {
    return { x: x[0], y: y[0], index: 0, fraction: 0, t: t[0], km: 0, kind: 0, heading: 0 };
  }
  const target = clamp(progress, 0, 1);
  const index = clamp(lowerBound(p, target), 1, n - 1);
  const span = p[index] - p[index - 1];
  const fraction = span > 0 ? clamp((target - p[index - 1]) / span, 0, 1) : 1;
  const segmentKind = kind[index];
  let px: number;
  let py: number;
  let heading: number;
  if (segmentKind !== 0) {
    const cx = journey.ctrlX[index];
    const cy = journey.ctrlY[index];
    px = bezier(x[index - 1], cx, x[index], fraction);
    py = bezier(y[index - 1], cy, y[index], fraction);
    const dx = 2 * (1 - fraction) * (cx - x[index - 1]) + 2 * fraction * (x[index] - cx);
    const dy = 2 * (1 - fraction) * (cy - y[index - 1]) + 2 * fraction * (y[index] - cy);
    heading = Math.atan2(dy, dx);
  } else {
    px = x[index - 1] + (x[index] - x[index - 1]) * fraction;
    py = y[index - 1] + (y[index] - y[index - 1]) * fraction;
    heading = Math.atan2(y[index] - y[index - 1], x[index] - x[index - 1]);
  }
  return {
    x: px,
    y: py,
    index,
    fraction,
    t: t[index - 1] + (t[index] - t[index - 1]) * fraction,
    km: km[index - 1] + (km[index] - km[index - 1]) * fraction,
    kind: segmentKind,
    heading,
  };
}

export function progressAtTime(journey: Journey, time: number): number {
  const { n, t, p } = journey;
  if (n === 1 || time <= t[0]) return 0;
  if (time >= t[n - 1]) return 1;
  const index = clamp(upperBound(t, time), 1, n - 1);
  const span = t[index] - t[index - 1];
  const fraction = span > 0 ? (time - t[index - 1]) / span : 1;
  return p[index - 1] + (p[index] - p[index - 1]) * fraction;
}

/** Splits a quadratic bezier at `f`, returning the control point and end of the first part. */
export function partialArc(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, f: number,
): [number, number, number, number] {
  const qx = x0 + (cx - x0) * f;
  const qy = y0 + (cy - y0) * f;
  const rx = cx + (x1 - cx) * f;
  const ry = cy + (y1 - cy) * f;
  return [qx, qy, qx + (rx - qx) * f, qy + (ry - qy) * f];
}
