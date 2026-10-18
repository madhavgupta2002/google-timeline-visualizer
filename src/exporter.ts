import { Map as LibreMap } from 'maplibre-gl';
import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import {
  buildCameraTrack, overviewCamera, totalSeconds, videoMoment, videoTiming,
  type CameraSettings, type Camera,
} from './camera';
import { latFromY, lngFromX } from './geo';
import type { Journey } from './journey';
import { drawHud, drawRoute, hudFrame, Projector, type HudContent } from './overlay';
import { MAP_STYLES, themeFor, type MapStyleId } from './scene';

export interface ExportOptions {
  journey: Journey;
  width: number;
  height: number;
  fps: number;
  style: MapStyleId;
  camera: CameraSettings;
  showStays: boolean;
  hud: (progress: number, outro: number) => HudContent;
  onProgress: (done: number, total: number, etaSec: number | null) => void;
  signal: AbortSignal;
}

/** Map rendering is done at a 540 px short edge and upscaled by the pixel ratio, so labels stay legible. */
const REFERENCE_SHORT_EDGE = 540;

export function canExportVideo(): boolean {
  return typeof VideoEncoder !== 'undefined';
}

export function toLngLat(camera: Camera): [number, number] {
  return [lngFromX(camera.x), latFromY(camera.y)];
}

function waitForIdle(map: LibreMap, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // A tile that never loads must not stall the export forever.
    const timeout = setTimeout(done, 20_000);
    function done() {
      clearTimeout(timeout);
      map.off('idle', done);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timeout);
      map.off('idle', done);
      reject(new DOMException('Cancelled', 'AbortError'));
    }
    map.once('idle', done);
    signal.addEventListener('abort', abort, { once: true });
    map.triggerRepaint();
  });
}

export async function exportVideo(options: ExportOptions): Promise<Blob> {
  if (!canExportVideo()) throw new Error('This browser cannot encode video (WebCodecs is missing). Use a recent Chrome, Edge or Safari.');
  const { journey, width, height, fps, signal } = options;
  const pixelRatio = Math.min(width, height) / REFERENCE_SHORT_EDGE;
  const cssWidth = width / pixelRatio;
  const cssHeight = height / pixelRatio;
  const frame = hudFrame(cssWidth, cssHeight);
  const track = buildCameraTrack(journey, frame, options.camera);
  const overview = overviewCamera(journey, frame, options.camera.maxZoom);
  const timing = videoTiming(journey.settings.durationSec);
  const frameCount = Math.ceil(totalSeconds(timing) * fps);
  const theme = themeFor(options.style);

  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height });
  if (!codec) throw new Error(`This browser cannot encode ${width}×${height} video. Try a smaller format.`);

  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, {
    position: 'fixed', left: '0', top: '0', width: `${cssWidth}px`, height: `${cssHeight}px`,
    opacity: '0', pointerEvents: 'none', zIndex: '-1',
  });
  document.body.append(container);
  const first = videoMoment(0, timing, track, overview, frame).camera;
  const map = new LibreMap({
    container,
    style: MAP_STYLES[options.style].url,
    center: toLngLat(first),
    zoom: first.zoom,
    interactive: false,
    attributionControl: false,
    pixelRatio,
    fadeDuration: 0,
    renderWorldCopies: true,
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    // Keep the exact camera, including wide overviews.
    transformConstrain: (center, zoom) => ({ center, zoom }),
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, {
    codec,
    quality: new Quality({ bitrate: Math.round(width * height * fps * 0.12) }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate: fps });

  try {
    await new Promise<void>((resolve, reject) => {
      // Individual tile errors are tolerated; only a style that never loads is fatal.
      const timer = setTimeout(() => reject(new Error('The map style could not be loaded. Check your connection.')), 30_000);
      map.once('load', () => {
        clearTimeout(timer);
        resolve();
      });
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelled', 'AbortError'));
      }, { once: true });
    });
    await output.start();
    const started = performance.now();
    for (let f = 0; f < frameCount; f += 1) {
      signal.throwIfAborted();
      const seconds = f / fps;
      const moment = videoMoment(seconds, timing, track, overview, frame);
      map.jumpTo({ center: toLngLat(moment.camera), zoom: moment.camera.zoom });
      await waitForIdle(map, signal);
      ctx.drawImage(map.getCanvas(), 0, 0, width, height);
      ctx.save();
      ctx.scale(pixelRatio, pixelRatio);
      const projector = new Projector(moment.camera, cssWidth, cssHeight);
      drawRoute(ctx, journey, projector, moment.progress, {
        theme,
        showFuture: false,
        showStays: options.showStays,
        tail: 1.4 / Math.max(1, timing.journey),
        reveal: moment.outro,
        clock: seconds,
        unit: 1,
      });
      drawHud(ctx, 0, 0, cssWidth, cssHeight, options.hud(moment.progress, moment.outro), theme);
      ctx.restore();
      await source.add(seconds, 1 / fps);
      const elapsed = (performance.now() - started) / 1000;
      options.onProgress(f + 1, frameCount, f > 10 ? (elapsed / (f + 1)) * (frameCount - f - 1) : null);
    }
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('The encoder produced no output.');
    return new Blob([buffer], { type: 'video/mp4' });
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    map.remove();
    container.remove();
  }
}
