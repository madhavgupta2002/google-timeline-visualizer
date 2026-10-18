import type { Analysis } from './analysis';
import { clamp } from './geo';
import type { Dataset } from './parse';

const DAY_MS = 86_400_000;
const HANDLE_PX = 7;

type DragMode = 'create' | 'left' | 'right' | 'scrub' | 'pan';

export interface TimelineBarEvents {
  /** Selection finished changing (pointer released). */
  onSelect: (start: number, end: number) => void;
  /** Playhead dragged to a time inside the selection. */
  onScrub: (time: number) => void;
}

/**
 * The bottom timeline: a per-day activity histogram you can zoom (wheel),
 * pan (shift-drag or horizontal scroll), brush to select a range, and scrub.
 */
export class TimelineBar {
  private dataset: Dataset | null = null;
  private analysis: Analysis | null = null;
  private dayStart: Float64Array = new Float64Array(0);
  private maxKm = 1;
  private min = 0;
  private max = 1;
  private viewStart = 0;
  private viewEnd = 1;
  private selStart = 0;
  private selEnd = 0;
  private playhead = Number.NaN;
  private hoverX = Number.NaN;
  private drag: { mode: DragMode; anchor: number; startX: number; moved: boolean; viewStart: number; viewEnd: number } | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private pending = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly tooltip: HTMLElement,
    private readonly events: TimelineBarEvents,
    private accent = '#ff5a1f',
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = Number.NaN;
      this.tooltip.hidden = true;
      this.draw();
    });
    canvas.addEventListener('wheel', (event) => this.wheel(event), { passive: false });
    canvas.addEventListener('dblclick', () => this.resetView());
  }

  setData(dataset: Dataset, analysis: Analysis): void {
    this.dataset = dataset;
    this.analysis = analysis;
    this.dayStart = new Float64Array(analysis.days.length);
    let tz = dataset.tz[0];
    analysis.days.forEach((day, d) => {
      if (day.first >= 0) tz = dataset.tz[day.first];
      this.dayStart[d] = day.index * DAY_MS - tz * 60_000;
    });
    this.maxKm = Math.max(1, ...analysis.days.map((day) => day.km));
    this.min = this.dayStart[0] ?? dataset.t[0];
    this.max = (this.dayStart[this.dayStart.length - 1] ?? dataset.t[dataset.count - 1]) + DAY_MS;
    this.resetView();
  }

  setSelection(start: number, end: number): void {
    this.selStart = start;
    this.selEnd = end;
    this.requestDraw();
  }

  setPlayhead(time: number): void {
    this.playhead = time;
    this.requestDraw();
  }

  setAccent(color: string): void {
    this.accent = color;
    this.requestDraw();
  }

  resetView(): void {
    const pad = (this.max - this.min) * 0.01;
    this.viewStart = this.min - pad;
    this.viewEnd = this.max + pad;
    this.requestDraw();
  }

  /** Zooms the timeline to show a range with some context around it. */
  focus(start: number, end: number): void {
    const span = Math.max(DAY_MS * 3, end - start);
    if (start >= this.viewStart && end <= this.viewEnd && span > (this.viewEnd - this.viewStart) * 0.05) return;
    const pad = (this.max - this.min) * 0.01;
    this.viewStart = Math.max(this.min - pad, start - span * 1.5);
    this.viewEnd = Math.min(this.max + pad, end + span * 1.5);
    this.requestDraw();
  }

  private requestDraw(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  private timeAt(x: number): number {
    const width = this.canvas.clientWidth;
    return this.viewStart + (x / Math.max(1, width)) * (this.viewEnd - this.viewStart);
  }

  private xAt(time: number): number {
    return ((time - this.viewStart) / (this.viewEnd - this.viewStart)) * this.canvas.clientWidth;
  }

  private snapDay(time: number, roundUp: boolean): number {
    const days = this.dayStart;
    if (days.length === 0) return time;
    let lo = 0;
    let hi = days.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (days[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return roundUp ? days[lo] + DAY_MS - 1 : days[lo];
  }

  private dayAt(time: number): number {
    const days = this.dayStart;
    let lo = 0;
    let hi = days.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (days[mid] <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private pointerDown(event: PointerEvent): void {
    if (!this.dataset) return;
    this.canvas.setPointerCapture(event.pointerId);
    const x = event.offsetX;
    const time = this.timeAt(x);
    const left = this.xAt(this.selStart);
    const right = this.xAt(this.selEnd);
    let mode: DragMode = 'create';
    if (event.shiftKey || event.button === 1) mode = 'pan';
    else if (Math.abs(x - left) <= HANDLE_PX) mode = 'left';
    else if (Math.abs(x - right) <= HANDLE_PX) mode = 'right';
    else if (x > left && x < right) mode = 'scrub';
    this.drag = { mode, anchor: time, startX: x, moved: false, viewStart: this.viewStart, viewEnd: this.viewEnd };
    if (mode === 'scrub') this.events.onScrub(time);
  }

  private pointerMove(event: PointerEvent): void {
    const x = event.offsetX;
    this.hoverX = x;
    this.updateTooltip(x);
    const drag = this.drag;
    if (!drag) {
      const left = this.xAt(this.selStart);
      const right = this.xAt(this.selEnd);
      this.canvas.style.cursor = Math.abs(x - left) <= HANDLE_PX || Math.abs(x - right) <= HANDLE_PX
        ? 'ew-resize' : x > left && x < right ? 'pointer' : 'crosshair';
      this.requestDraw();
      return;
    }
    if (Math.abs(x - drag.startX) > 3) drag.moved = true;
    const time = this.timeAt(x);
    switch (drag.mode) {
      case 'pan': {
        const shift = ((drag.startX - x) / this.canvas.clientWidth) * (drag.viewEnd - drag.viewStart);
        this.viewStart = drag.viewStart + shift;
        this.viewEnd = drag.viewEnd + shift;
        break;
      }
      case 'left':
        this.selStart = Math.min(this.snapDay(time, false), this.selEnd - DAY_MS / 2);
        break;
      case 'right':
        this.selEnd = Math.max(this.snapDay(time, true), this.selStart + DAY_MS / 2);
        break;
      case 'create':
        if (drag.moved) {
          this.selStart = this.snapDay(Math.min(drag.anchor, time), false);
          this.selEnd = this.snapDay(Math.max(drag.anchor, time), true);
        }
        break;
      case 'scrub':
        this.events.onScrub(clamp(time, this.selStart, this.selEnd));
        break;
    }
    this.requestDraw();
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag || !this.analysis) return;
    this.canvas.releasePointerCapture(event.pointerId);
    if (drag.mode === 'left' || drag.mode === 'right' || (drag.mode === 'create' && drag.moved)) {
      this.events.onSelect(this.selStart, this.selEnd);
    } else if (drag.mode === 'create') {
      // A click selects the trip under the cursor, or that single day.
      const d = this.dayAt(drag.anchor);
      const trip = this.analysis.days[d]?.trip ?? -1;
      if (trip >= 0) {
        const t = this.analysis.trips[trip];
        this.events.onSelect(this.snapDay(t.start, false), this.snapDay(t.end, true));
      } else {
        this.events.onSelect(this.dayStart[d], this.dayStart[d] + DAY_MS - 1);
      }
    }
  }

  private wheel(event: WheelEvent): void {
    event.preventDefault();
    const span = this.viewEnd - this.viewStart;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      const shift = (event.deltaX / this.canvas.clientWidth) * span;
      this.viewStart += shift;
      this.viewEnd += shift;
    } else {
      const factor = Math.exp(event.deltaY * 0.002);
      const pivot = this.timeAt(event.offsetX);
      const newSpan = clamp(span * factor, DAY_MS * 4, (this.max - this.min) * 1.2);
      const ratio = (pivot - this.viewStart) / span;
      this.viewStart = pivot - ratio * newSpan;
      this.viewEnd = this.viewStart + newSpan;
    }
    this.requestDraw();
  }

  private updateTooltip(x: number): void {
    if (!this.analysis || this.dayStart.length === 0) return;
    const d = this.dayAt(this.timeAt(x));
    const day = this.analysis.days[d];
    if (!day) return;
    const date = new Date(day.index * DAY_MS).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const trip = day.trip >= 0 ? this.analysis.trips[day.trip] : null;
    this.tooltip.textContent = `${date} · ${day.first < 0 ? 'no data' : `${Math.round(day.km)} km`}${trip?.label ? ` · ${trip.label}` : ''}`;
    this.tooltip.hidden = false;
    const width = this.canvas.clientWidth;
    this.tooltip.style.left = `${clamp(x, 80, width - 80)}px`;
  }

  draw(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!this.analysis || this.dayStart.length === 0) return;
    const top = 6;
    const axis = height - 18;
    const barHeight = axis - top;
    const span = this.viewEnd - this.viewStart;
    const pxPerDay = (width * DAY_MS) / span;
    const style = getComputedStyle(this.canvas);
    const muted = style.getPropertyValue('--muted').trim() || '#8892a6';
    const bar = style.getPropertyValue('--bar').trim() || '#7c8db5';

    // Histogram (aggregated when days are narrower than 2 px).
    const days = this.analysis.days;
    const group = Math.max(1, Math.ceil(2 / pxPerDay));
    const firstDay = Math.max(0, this.dayAt(this.viewStart) - group);
    const lastDay = Math.min(days.length - 1, this.dayAt(this.viewEnd) + group);
    const logMax = Math.log1p(this.maxKm);
    for (let d = firstDay - (firstDay % group); d <= lastDay; d += group) {
      let km = 0;
      let hasData = false;
      let trip = false;
      for (let k = d; k < Math.min(days.length, d + group); k += 1) {
        km = Math.max(km, days[k].km);
        hasData ||= days[k].first >= 0;
        trip ||= days[k].trip >= 0;
      }
      if (!hasData) continue;
      const x0 = this.xAt(this.dayStart[d]);
      const x1 = this.xAt(this.dayStart[Math.min(days.length - 1, d + group - 1)] + DAY_MS);
      const h = Math.max(2, (Math.log1p(km) / logMax) * barHeight);
      ctx.fillStyle = trip ? this.accent : bar;
      ctx.globalAlpha = trip ? 0.85 : 0.6;
      ctx.fillRect(x0, axis - h, Math.max(1, x1 - x0 - (pxPerDay > 4 ? 1 : 0)), h);
    }
    ctx.globalAlpha = 1;

    // Axis ticks.
    ctx.fillStyle = muted;
    ctx.strokeStyle = muted;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const ticks = this.ticks(span, width);
    for (const tick of ticks) {
      const x = this.xAt(tick.time);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x, axis, 1, 4);
      ctx.globalAlpha = 1;
      ctx.fillText(tick.label, x + 3, axis + 4);
    }

    // Selection.
    const left = this.xAt(this.selStart);
    const right = this.xAt(this.selEnd);
    if (right > left) {
      ctx.fillStyle = 'rgba(64, 120, 255, 0.14)';
      ctx.fillRect(left, 0, right - left, axis);
      ctx.fillStyle = '#3d6bff';
      ctx.fillRect(left - 1.5, 0, 3, axis);
      ctx.fillRect(right - 1.5, 0, 3, axis);
      ctx.beginPath();
      ctx.roundRect(left - 4, axis / 2 - 10, 8, 20, 3);
      ctx.roundRect(right - 4, axis / 2 - 10, 8, 20, 3);
      ctx.fill();
    }

    if (Number.isFinite(this.playhead)) {
      const x = this.xAt(this.playhead);
      ctx.fillStyle = '#ff2d55';
      ctx.fillRect(x - 1, 0, 2, axis);
      ctx.beginPath();
      ctx.arc(x, 4, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (Number.isFinite(this.hoverX) && !this.drag) {
      ctx.fillStyle = muted;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(this.hoverX, 0, 1, axis);
      ctx.globalAlpha = 1;
    }
  }

  private ticks(span: number, width: number): { time: number; label: string }[] {
    const start = new Date(this.viewStart);
    const out: { time: number; label: string }[] = [];
    const daysVisible = span / DAY_MS;
    const maxTicks = Math.max(2, Math.floor(width / 70));
    if (daysVisible / 365 > maxTicks / 2) {
      const step = Math.ceil(daysVisible / 365 / maxTicks);
      for (let y = start.getUTCFullYear(); ; y += 1) {
        const time = Date.UTC(y, 0, 1);
        if (time > this.viewEnd) break;
        if (time >= this.viewStart && y % step === 0) out.push({ time, label: String(y) });
      }
    } else if (daysVisible > maxTicks * 1.5) {
      const step = Math.max(1, Math.ceil(daysVisible / 30 / maxTicks));
      for (let m = start.getUTCFullYear() * 12 + start.getUTCMonth(); ; m += 1) {
        const time = Date.UTC(Math.floor(m / 12), m % 12, 1);
        if (time > this.viewEnd) break;
        if (time < this.viewStart || m % step !== 0) continue;
        const date = new Date(time);
        out.push({
          time,
          label: date.getUTCMonth() === 0
            ? String(date.getUTCFullYear())
            : date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
        });
      }
    } else {
      const step = Math.max(1, Math.ceil(daysVisible / maxTicks));
      for (let d = Math.floor(this.viewStart / DAY_MS); d * DAY_MS <= this.viewEnd; d += 1) {
        if (d % step !== 0) continue;
        const time = d * DAY_MS;
        if (time < this.viewStart) continue;
        out.push({ time, label: new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) });
      }
    }
    return out;
  }
}
