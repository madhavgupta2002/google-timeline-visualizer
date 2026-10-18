import { clamp, lowerBound, upperBound } from './geo';
import { positionAt, type Journey } from './journey';

export const TILE_SIZE = 512;

/** A camera in Mercator world units: (x, y) is the map centre. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Frame {
  width: number;
  height: number;
  /** Area (CSS px, within the frame) that the route must stay inside, e.g. clear of the HUD. */
  safe: { left: number; top: number; right: number; bottom: number };
}

export interface CameraSettings {
  /** Seconds of story the camera looks ahead and behind to frame. Smaller = tighter, more zooming. */
  windowSec: number;
  /** Closest zoom when you stay in one place (13 ≈ a city district). */
  maxZoom: number;
  /** How smoothly zoom changes, in seconds. */
  smoothSec: number;
}

export const DEFAULT_CAMERA: CameraSettings = { windowSec: 2, maxZoom: 13, smoothSec: 0.7 };
const MIN_ZOOM = 0.5;
const MIN_SPAN = 1e-7;

export interface CameraTrack {
  samples: number;
  /** World point shown at the centre of the safe area. */
  fx: Float64Array;
  fy: Float64Array;
  zoom: Float64Array;
  frame: Frame;
}

/** Range min/max over fixed-size blocks; fast enough for thousands of window queries. */
class RangeBounds {
  private static readonly BLOCK = 128;
  private readonly minX: Float64Array;
  private readonly maxX: Float64Array;
  private readonly minY: Float64Array;
  private readonly maxY: Float64Array;

  constructor(private readonly x: Float64Array, private readonly y: Float64Array) {
    const blocks = Math.ceil(x.length / RangeBounds.BLOCK);
    this.minX = new Float64Array(blocks).fill(Infinity);
    this.maxX = new Float64Array(blocks).fill(-Infinity);
    this.minY = new Float64Array(blocks).fill(Infinity);
    this.maxY = new Float64Array(blocks).fill(-Infinity);
    for (let i = 0; i < x.length; i += 1) {
      const b = (i / RangeBounds.BLOCK) | 0;
      if (x[i] < this.minX[b]) this.minX[b] = x[i];
      if (x[i] > this.maxX[b]) this.maxX[b] = x[i];
      if (y[i] < this.minY[b]) this.minY[b] = y[i];
      if (y[i] > this.maxY[b]) this.maxY[b] = y[i];
    }
  }

  /** Extends `box` ([minX, minY, maxX, maxY]) with points in [from, to). */
  extend(box: number[], from: number, to: number): void {
    const size = RangeBounds.BLOCK;
    let i = from;
    while (i < to) {
      if (i % size === 0 && i + size <= to) {
        const b = i / size;
        box[0] = Math.min(box[0], this.minX[b]);
        box[1] = Math.min(box[1], this.minY[b]);
        box[2] = Math.max(box[2], this.maxX[b]);
        box[3] = Math.max(box[3], this.maxY[b]);
        i += size;
      } else {
        box[0] = Math.min(box[0], this.x[i]);
        box[1] = Math.min(box[1], this.y[i]);
        box[2] = Math.max(box[2], this.x[i]);
        box[3] = Math.max(box[3], this.y[i]);
        i += 1;
      }
    }
  }
}

export function gaussianSmooth(values: Float64Array, sigma: number): Float64Array {
  if (sigma < 0.5) return values.slice();
  const radius = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, k) => Math.exp(-((k - radius) ** 2) / (2 * sigma * sigma)));
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const j = clamp(i + k, 0, values.length - 1);
      sum += values[j] * kernel[k + radius];
      weight += kernel[k + radius];
    }
    out[i] = sum / weight;
  }
  return out;
}

export function minFilter(values: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let minimum = Infinity;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j += 1) {
      if (values[j] < minimum) minimum = values[j];
    }
    out[i] = minimum;
  }
  return out;
}

function safeSize(frame: Frame): [number, number] {
  return [
    Math.max(40, frame.safe.right - frame.safe.left),
    Math.max(40, frame.safe.bottom - frame.safe.top),
  ];
}

export function fitZoom(frame: Frame, spanX: number, spanY: number, maxZoom: number): number {
  const [width, height] = safeSize(frame);
  const scale = Math.min(width / Math.max(spanX, MIN_SPAN), height / Math.max(spanY, MIN_SPAN));
  return clamp(Math.log2(scale / TILE_SIZE), MIN_ZOOM, maxZoom);
}

/** Converts "focus point at safe-area centre" into the map centre. */
export function cameraFromFocus(frame: Frame, fx: number, fy: number, zoom: number): Camera {
  const scale = TILE_SIZE * 2 ** zoom;
  const safeCenterX = (frame.safe.left + frame.safe.right) / 2;
  const safeCenterY = (frame.safe.top + frame.safe.bottom) / 2;
  return {
    x: fx + (frame.width / 2 - safeCenterX) / scale,
    y: fy + (frame.height / 2 - safeCenterY) / scale,
    zoom,
  };
}

/**
 * Builds a smooth camera path over story progress.
 *
 * At each moment the camera frames everything you do within ±windowSec of
 * story time. In a city that is just the day's local movement, so the camera
 * zooms in; around a flight or long drive the window spans origin and
 * destination, so it zooms out *before* departure and back in *after*
 * arrival. Zoom-out is protected with a min-filter before smoothing, so fast
 * travel is never cropped, and both directions use the same smoothing so the
 * camera actually comes back down.
 */
export function buildCameraTrack(
  journey: Journey,
  frame: Frame,
  settings: CameraSettings = DEFAULT_CAMERA,
): CameraTrack {
  const duration = Math.max(1, journey.settings.durationSec);
  const samples = clamp(Math.round(duration * 12), 240, 4000);
  const perSecond = samples / duration;
  // Short videos would otherwise look a large share of the journey ahead.
  const windowSec = Math.min(settings.windowSec, Math.max(0.6, duration * 0.07));
  const halfWindow = windowSec / duration;
  const bounds = new RangeBounds(journey.x, journey.y);
  const rawZoom = new Float64Array(samples + 1);
  const rawFx = new Float64Array(samples + 1);
  const rawFy = new Float64Array(samples + 1);
  const markerX = new Float64Array(samples + 1);
  const markerY = new Float64Array(samples + 1);
  const box = [0, 0, 0, 0];

  for (let s = 0; s <= samples; s += 1) {
    const progress = s / samples;
    const marker = positionAt(journey, progress);
    const before = positionAt(journey, progress - halfWindow);
    const after = positionAt(journey, progress + halfWindow);
    markerX[s] = marker.x;
    markerY[s] = marker.y;
    box[0] = Math.min(marker.x, before.x, after.x);
    box[1] = Math.min(marker.y, before.y, after.y);
    box[2] = Math.max(marker.x, before.x, after.x);
    box[3] = Math.max(marker.y, before.y, after.y);
    const from = lowerBound(journey.p, progress - halfWindow);
    const to = upperBound(journey.p, progress + halfWindow);
    if (to > from) bounds.extend(box, from, to);
    rawFx[s] = (box[0] + box[2]) / 2;
    rawFy[s] = (box[1] + box[3]) / 2;
    rawZoom[s] = fitZoom(frame, (box[2] - box[0]) * 1.08, (box[3] - box[1]) * 1.08, settings.maxZoom);
  }

  const sigma = settings.smoothSec * perSecond;
  const zoom = gaussianSmooth(minFilter(rawZoom, Math.round(sigma * 0.8)), sigma);
  let fx = gaussianSmooth(rawFx, sigma * 0.8);
  let fy = gaussianSmooth(rawFy, sigma * 0.8);

  // Keep the marker inside the safe area, then soften those corrections.
  const [safeWidth, safeHeight] = safeSize(frame);
  const contain = (limit: number) => {
    for (let s = 0; s <= samples; s += 1) {
      const scale = TILE_SIZE * 2 ** zoom[s];
      const halfX = (safeWidth / 2 / scale) * limit;
      const halfY = (safeHeight / 2 / scale) * limit;
      fx[s] = clamp(fx[s], markerX[s] - halfX, markerX[s] + halfX);
      fy[s] = clamp(fy[s], markerY[s] - halfY, markerY[s] + halfY);
    }
  };
  contain(0.7);
  fx = gaussianSmooth(fx, sigma * 0.3);
  fy = gaussianSmooth(fy, sigma * 0.3);
  contain(0.9);
  return { samples, fx, fy, zoom, frame };
}

export function cameraAt(track: CameraTrack, progress: number, frame: Frame = track.frame): Camera {
  const position = clamp(progress, 0, 1) * track.samples;
  const a = Math.min(track.samples, Math.floor(position));
  const b = Math.min(track.samples, a + 1);
  const f = position - a;
  const fx = track.fx[a] + (track.fx[b] - track.fx[a]) * f;
  const fy = track.fy[a] + (track.fy[b] - track.fy[a]) * f;
  // The track is scale-invariant: a frame of a different size just shifts zoom.
  const zoomOffset = Math.log2(Math.max(1, frame.width) / Math.max(1, track.frame.width));
  const zoom = track.zoom[a] + (track.zoom[b] - track.zoom[a]) * f + zoomOffset;
  return cameraFromFocus(frame, fx, fy, zoom);
}

export function overviewCamera(journey: Journey, frame: Frame, maxZoom = 15): Camera {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (let i = 0; i < journey.n; i += 1) {
    include(journey.x[i], journey.y[i]);
    // Arcs bulge beyond their endpoints; include each arc's apex.
    if (i > 0 && !Number.isNaN(journey.ctrlX[i])) {
      include(
        0.25 * journey.x[i - 1] + 0.5 * journey.ctrlX[i] + 0.25 * journey.x[i],
        0.25 * journey.y[i - 1] + 0.5 * journey.ctrlY[i] + 0.25 * journey.y[i],
      );
    }
  }
  const zoom = fitZoom(frame, (maxX - minX) * 1.15, (maxY - minY) * 1.15, maxZoom);
  return cameraFromFocus(frame, (minX + maxX) / 2, (minY + maxY) / 2, zoom);
}

export function easeInOut(t: number): number {
  const c = clamp(t, 0, 1);
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

/**
 * Interpolates two cameras as a pure zoom around their shared fixed point,
 * so nothing slides sideways while zooming. Falls back to a pan when both
 * zooms are equal.
 */
export function blendCameras(a: Camera, b: Camera, t: number): Camera {
  const e = clamp(t, 0, 1);
  const zoom = a.zoom + (b.zoom - a.zoom) * e;
  const sa = 2 ** -a.zoom;
  const sb = 2 ** -b.zoom;
  if (Math.abs(sa - sb) / Math.max(sa, sb) < 0.02) {
    return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom };
  }
  const s = 2 ** -zoom;
  const u = (s - sa) / (sb - sa);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, zoom };
}

export interface Timing {
  introHold: number;
  introMove: number;
  journey: number;
  outroMove: number;
  outroHold: number;
}

export function videoTiming(durationSec: number): Timing {
  return { introHold: 0.4, introMove: 1.4, journey: durationSec, outroMove: 1.8, outroHold: 1.6 };
}

export function totalSeconds(timing: Timing): number {
  return timing.introHold + timing.introMove + timing.journey + timing.outroMove + timing.outroHold;
}

export interface VideoMoment {
  camera: Camera;
  progress: number;
  phase: 'intro' | 'journey' | 'outro';
  /** 0..1 within the outro, used to fade in the full route and summary. */
  outro: number;
}

export function videoMoment(
  seconds: number,
  timing: Timing,
  track: CameraTrack,
  overview: Camera,
  frame: Frame,
): VideoMoment {
  const introEnd = timing.introHold + timing.introMove;
  const journeyEnd = introEnd + timing.journey;
  if (seconds < introEnd) {
    const move = easeInOut((seconds - timing.introHold) / timing.introMove);
    return { camera: blendCameras(overview, cameraAt(track, 0, frame), move), progress: 0, phase: 'intro', outro: 0 };
  }
  if (seconds < journeyEnd) {
    const progress = (seconds - introEnd) / timing.journey;
    return { camera: cameraAt(track, progress, frame), progress, phase: 'journey', outro: 0 };
  }
  const move = easeInOut((seconds - journeyEnd) / timing.outroMove);
  const outro = clamp((seconds - journeyEnd) / timing.outroMove, 0, 1);
  return { camera: blendCameras(cameraAt(track, 1, frame), overview, move), progress: 1, phase: 'outro', outro };
}
