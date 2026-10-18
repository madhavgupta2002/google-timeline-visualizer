import { TILE_SIZE, type Camera, type Frame } from './camera';
import { lowerBound } from './geo';
import { partialArc, positionAt, type Journey, type Position } from './journey';
import { SEG_GAP } from './parse';

export interface Theme {
  route: string;
  routeAlpha: number;
  tail: string;
  marker: string;
  halo: string;
  ghost: string;
  stay: string;
  hudBackground: string;
  hudText: string;
  hudMuted: string;
}

export const THEMES: Record<'light' | 'dark', Theme> = {
  light: {
    route: '#3355dd', routeAlpha: 0.55, tail: '#ff5a1f', marker: '#ff3d00', halo: '#ffffff',
    ghost: 'rgba(40, 50, 80, 0.22)', stay: '#3355dd',
    hudBackground: 'rgba(255, 255, 255, 0.86)', hudText: '#121826', hudMuted: '#5b6478',
  },
  dark: {
    route: '#4fb3ff', routeAlpha: 0.6, tail: '#ffd23f', marker: '#ffb000', halo: '#0b1020',
    ghost: 'rgba(200, 220, 255, 0.22)', stay: '#4fb3ff',
    hudBackground: 'rgba(14, 18, 30, 0.82)', hudText: '#f3f6ff', hudMuted: '#9aa6c2',
  },
};

/** Screen projection for an unrotated Web Mercator camera, matching MapLibre's 512 px tiles. */
export class Projector {
  readonly scale: number;

  constructor(readonly camera: Camera, readonly width: number, readonly height: number, readonly originX = 0, readonly originY = 0) {
    this.scale = TILE_SIZE * 2 ** camera.zoom;
  }

  /** Whole-world shift that brings `x` closest to the camera. */
  shiftFor(x: number): number {
    return Math.round(this.camera.x - x);
  }

  px(x: number, shift: number): number {
    return this.originX + (x + shift - this.camera.x) * this.scale + this.width / 2;
  }

  py(y: number): number {
    return this.originY + (y - this.camera.y) * this.scale + this.height / 2;
  }
}

export interface RouteOptions {
  theme: Theme;
  /** Draw the not-yet-travelled part faintly. */
  showFuture: boolean;
  showStays: boolean;
  /** Length of the bright comet tail, in story progress. */
  tail: number;
  /** 0..1 – fades the comet tail out and the full route in (video ending). */
  reveal: number;
  /** Animation clock in seconds, for the marker pulse. */
  clock: number;
  /** Line width multiplier (export uses 1, high-DPI handled by the canvas transform). */
  unit: number;
}

const ARC_STEPS = 32;

/** Ground segments from `from` to `to` (and on to `end`) as one decimated polyline; arcs leave gaps. */
function traceGround(
  ctx: CanvasRenderingContext2D,
  journey: Journey,
  proj: Projector,
  shift: number,
  from: number,
  to: number,
  end: Position | null,
): void {
  const { x, y, kind } = journey;
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let open = false;
  const visit = (sx: number, sy: number, force: boolean) => {
    if (!open) {
      ctx.moveTo(sx, sy);
      open = true;
    } else if (force || Math.abs(sx - lastX) >= 0.8 || Math.abs(sy - lastY) >= 0.8) {
      ctx.lineTo(sx, sy);
    } else {
      return;
    }
    lastX = sx;
    lastY = sy;
  };
  for (let i = from; i <= to; i += 1) {
    if (i > from && kind[i] !== 0) open = false;
    visit(proj.px(x[i], shift), proj.py(y[i]), i === to);
  }
  if (end && end.index > to && kind[end.index] === 0) visit(proj.px(end.x, shift), proj.py(end.y), true);
}

/** Appends world coordinates of segment `i` from fraction f0 to f1 (exclusive of f0). */
function appendSegment(journey: Journey, i: number, f0: number, f1: number, out: number[]): void {
  const { x, y, kind, ctrlX, ctrlY } = journey;
  if (i <= 0 || f1 <= f0) return;
  if (kind[i] === 0) {
    out.push(x[i - 1] + (x[i] - x[i - 1]) * f1, y[i - 1] + (y[i] - y[i - 1]) * f1);
    return;
  }
  const steps = Math.max(1, Math.ceil(ARC_STEPS * (f1 - f0)));
  for (let s = 1; s <= steps; s += 1) {
    const f = f0 + ((f1 - f0) * s) / steps;
    const u = 1 - f;
    out.push(
      u * u * x[i - 1] + 2 * u * f * ctrlX[i] + f * f * x[i],
      u * u * y[i - 1] + 2 * u * f * ctrlY[i] + f * f * y[i],
    );
  }
}

/** The travelled path between two positions, following arcs, as flat [x, y, ...] world coordinates. */
export function pathBetween(journey: Journey, a: Position, b: Position): number[] {
  const out = [a.x, a.y];
  if (a.index === b.index) {
    appendSegment(journey, a.index, a.fraction, b.fraction, out);
    return out;
  }
  appendSegment(journey, a.index, a.fraction, 1, out);
  for (let i = a.index + 1; i < b.index; i += 1) appendSegment(journey, i, 0, 1, out);
  appendSegment(journey, b.index, 0, b.fraction, out);
  return out;
}

function strokeArcs(
  ctx: CanvasRenderingContext2D,
  journey: Journey,
  proj: Projector,
  shift: number,
  from: number,
  to: number,
  partial: Position | null,
): void {
  const { x, y, kind, ctrlX, ctrlY } = journey;
  for (let i = Math.max(1, from); i <= Math.min(to, journey.n - 1); i += 1) {
    if (kind[i] === 0) continue;
    let [cx, cy, ex, ey] = [ctrlX[i], ctrlY[i], x[i], y[i]];
    if (partial && i === partial.index) {
      if (partial.fraction <= 0) continue;
      [cx, cy, ex, ey] = partialArc(x[i - 1], y[i - 1], cx, cy, x[i], y[i], partial.fraction);
    }
    ctx.beginPath();
    ctx.setLineDash(kind[i] === SEG_GAP ? [2, 6] : [7, 6]);
    ctx.moveTo(proj.px(x[i - 1], shift), proj.py(y[i - 1]));
    ctx.quadraticCurveTo(proj.px(cx, shift), proj.py(cy), proj.px(ex, shift), proj.py(ey));
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

export function drawRoute(
  ctx: CanvasRenderingContext2D,
  journey: Journey,
  proj: Projector,
  progress: number,
  options: RouteOptions,
): Position {
  const { theme, unit } = options;
  const current = positionAt(journey, progress);
  const shift = proj.shiftFor(current.x);
  const pastEnd = Math.min(journey.n - 1, current.index - 1);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (options.showFuture && progress < 1) {
    ctx.strokeStyle = theme.ghost;
    ctx.lineWidth = 1.6 * unit;
    ctx.beginPath();
    traceGround(ctx, journey, proj, shift, Math.max(0, current.index - 1), journey.n - 1, null);
    ctx.stroke();
    strokeArcs(ctx, journey, proj, shift, current.index, journey.n - 1, null);
  }

  // Everything travelled so far.
  ctx.globalAlpha = theme.routeAlpha + (1 - theme.routeAlpha) * options.reveal * 0.6;
  ctx.strokeStyle = theme.route;
  ctx.lineWidth = (2.4 + options.reveal * 0.8) * unit;
  ctx.beginPath();
  traceGround(ctx, journey, proj, shift, 0, pastEnd, current);
  ctx.stroke();
  ctx.lineWidth = 1.8 * unit;
  strokeArcs(ctx, journey, proj, shift, 1, current.index, current);
  ctx.globalAlpha = 1;

  if (options.showStays) {
    const right = proj.originX + proj.width + 20;
    const bottom = proj.originY + proj.height + 20;
    for (const stay of journey.stays) {
      if (stay.start > current.t) break;
      const hours = (stay.end - stay.start) / 3.6e6;
      if (hours < 1) continue;
      const k = Math.min(journey.n - 1, lowerBound(journey.t, stay.start));
      const sx = proj.px(journey.x[k], shift);
      const sy = proj.py(journey.y[k]);
      if (sx < proj.originX - 20 || sy < proj.originY - 20 || sx > right || sy > bottom) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, (2 + Math.min(4.5, Math.log2(1 + hours) * 0.8)) * unit, 0, Math.PI * 2);
      ctx.fillStyle = theme.stay;
      ctx.globalAlpha = 0.35;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = unit;
      ctx.strokeStyle = theme.halo;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Comet tail behind the marker, brightest at the head.
  const tailAlpha = 1 - options.reveal;
  if (options.tail > 0 && tailAlpha > 0.01 && progress > 0) {
    const from = Math.max(0, progress - options.tail);
    const chunks = 10;
    let a = positionAt(journey, from);
    for (let c = 1; c <= chunks; c += 1) {
      const b = positionAt(journey, from + ((progress - from) * c) / chunks);
      const path = pathBetween(journey, a, b);
      const intensity = c / chunks;
      ctx.globalAlpha = tailAlpha * (0.15 + 0.85 * intensity);
      ctx.strokeStyle = theme.tail;
      ctx.lineWidth = (2 + 3 * intensity) * unit;
      ctx.beginPath();
      ctx.moveTo(proj.px(path[0], shift), proj.py(path[1]));
      for (let k = 2; k < path.length; k += 2) ctx.lineTo(proj.px(path[k], shift), proj.py(path[k + 1]));
      ctx.stroke();
      a = b;
    }
    ctx.globalAlpha = 1;
  }

  drawMarker(ctx, proj.px(current.x, shift), proj.py(current.y), current, options);
  ctx.restore();
  return current;
}

function drawMarker(ctx: CanvasRenderingContext2D, sx: number, sy: number, at: Position, options: RouteOptions): void {
  const { theme, unit } = options;
  if (at.kind !== 0 && at.kind !== SEG_GAP && at.fraction > 0 && at.fraction < 1) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(at.heading);
    const size = 9 * unit;
    ctx.beginPath();
    // A simple plane silhouette pointing along +x.
    ctx.moveTo(size * 1.2, 0);
    ctx.lineTo(size * 0.2, size * 0.25);
    ctx.lineTo(-size * 0.2, size * 1.1);
    ctx.lineTo(-size * 0.5, size * 1.1);
    ctx.lineTo(-size * 0.25, size * 0.25);
    ctx.lineTo(-size * 0.8, size * 0.25);
    ctx.lineTo(-size * 1.05, size * 0.6);
    ctx.lineTo(-size * 1.2, size * 0.6);
    ctx.lineTo(-size * 1.05, 0);
    ctx.lineTo(-size * 1.2, -size * 0.6);
    ctx.lineTo(-size * 1.05, -size * 0.6);
    ctx.lineTo(-size * 0.8, -size * 0.25);
    ctx.lineTo(-size * 0.25, -size * 0.25);
    ctx.lineTo(-size * 0.5, -size * 1.1);
    ctx.lineTo(-size * 0.2, -size * 1.1);
    ctx.lineTo(size * 0.2, -size * 0.25);
    ctx.closePath();
    ctx.fillStyle = theme.marker;
    ctx.strokeStyle = theme.halo;
    ctx.lineWidth = 1.5 * unit;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }
  const pulse = (options.clock % 1.6) / 1.6;
  ctx.beginPath();
  ctx.arc(sx, sy, (6 + 14 * pulse) * unit, 0, Math.PI * 2);
  ctx.fillStyle = theme.marker;
  ctx.globalAlpha = 0.35 * (1 - pulse);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(sx, sy, 6.5 * unit, 0, Math.PI * 2);
  ctx.fillStyle = theme.marker;
  ctx.fill();
  ctx.lineWidth = 2.5 * unit;
  ctx.strokeStyle = theme.halo;
  ctx.stroke();
}

export interface HudContent {
  title: string;
  date: string;
  place: string;
  distance: string;
  dayCounter: string;
  attribution: string;
  /** Shown in the ending instead of the live stats. */
  summary: string | null;
  summaryAlpha: number;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** HUD layout units: the safe area the camera must avoid. */
export function hudFrame(width: number, height: number): Frame {
  const u = Math.min(width, height) / 540;
  return {
    width,
    height,
    safe: { left: 22 * u, top: 112 * u, right: width - 22 * u, bottom: height - 58 * u },
  };
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  width: number,
  height: number,
  hud: HudContent,
  theme: Theme,
): void {
  const u = Math.min(width, height) / 540;
  ctx.save();
  ctx.translate(x0, y0);
  const pad = 14 * u;
  const cardWidth = Math.min(width - 32 * u, 360 * u);
  roundRect(ctx, 16 * u, 16 * u, cardWidth, 84 * u, 14 * u);
  ctx.fillStyle = theme.hudBackground;
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 12 * u;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.hudText;
  ctx.font = `700 ${19 * u}px ${FONT}`;
  ctx.fillText(fitText(ctx, hud.title, cardWidth - pad * 2), 16 * u + pad, 16 * u + 30 * u);
  ctx.font = `500 ${14.5 * u}px ${FONT}`;
  ctx.fillText(fitText(ctx, hud.date, cardWidth - pad * 2), 16 * u + pad, 16 * u + 52 * u);
  ctx.fillStyle = theme.hudMuted;
  ctx.font = `500 ${13.5 * u}px ${FONT}`;
  ctx.fillText(fitText(ctx, hud.place, cardWidth - pad * 2), 16 * u + pad, 16 * u + 72 * u);

  // Bottom pill: live stats, cross-fading into the trip summary at the end.
  const pill = (text: string, alpha: number) => {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${15 * u}px ${FONT}`;
    const fitted = fitText(ctx, text, width - 48 * u - pad * 2);
    roundRect(ctx, 16 * u, height - 50 * u, ctx.measureText(fitted).width + pad * 2, 34 * u, 17 * u);
    ctx.fillStyle = theme.hudBackground;
    ctx.fill();
    ctx.fillStyle = theme.hudText;
    ctx.fillText(fitted, 16 * u + pad, height - 28 * u);
    ctx.globalAlpha = 1;
  };
  const summaryAlpha = hud.summary ? hud.summaryAlpha : 0;
  pill(`${hud.distance}   ·   ${hud.dayCounter}`, 1 - summaryAlpha);
  if (hud.summary) pill(hud.summary, summaryAlpha);

  ctx.font = `500 ${9.5 * u}px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.hudMuted;
  ctx.fillText(hud.attribution, width - 10 * u, height - 8 * u);
  ctx.restore();
}
