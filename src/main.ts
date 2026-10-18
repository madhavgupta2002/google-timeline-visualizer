import './style.css';
import { Map as LibreMap, setWorkerUrl, type GeoJSONSource } from 'maplibre-gl';
// MapLibre 6 looks for its worker beside its own module, which bundlers cannot see.
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { analyze, summarize, type Analysis } from './analysis';
import {
  blendCameras, buildCameraTrack, cameraAt, DEFAULT_CAMERA, easeInOut, overviewCamera, totalSeconds,
  videoMoment, videoTiming, type Camera, type CameraSettings, type CameraTrack, type Frame,
} from './camera';
import { canExportVideo, exportVideo, toLngLat } from './exporter';
import { formatDistance, formatDuration, formatLocal, isoDate, type DistanceUnit } from './format';
import { clamp, lowerBound, mercatorX, mercatorY } from './geo';
import { buildJourney, positionAt, progressAtTime, type Journey } from './journey';
import { drawHud, drawRoute, hudFrame, Projector } from './overlay';
import type { Dataset } from './parse';
import { countryName, flag, loadCities, type CityIndex } from './places';
import { buildHud, defaultTitle, MAP_STYLES, placeLabel, themeFor, type MapStyleId } from './scene';
import { TimelineBar } from './timeline-bar';
import type { WorkerResponse } from './parse.worker';

const DAY_MS = 86_400_000;
setWorkerUrl(mapWorkerUrl);

// ---------- settings ----------

interface Settings {
  style: MapStyleId;
  units: DistanceUnit;
  showFuture: boolean;
  showStays: boolean;
  heatmap: boolean;
  durationSec: number;
  pace: number;
  camera: CameraSettings;
  format: string;
  fps: number;
}

const SETTINGS_KEY = 'timeline-explorer:settings';
const settings: Settings = {
  style: 'positron', units: 'km', showFuture: true, showStays: true, heatmap: false,
  durationSec: 30, pace: 1, camera: { ...DEFAULT_CAMERA }, format: '1920x1080', fps: 30,
};
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
  Object.assign(settings, saved, { camera: { ...DEFAULT_CAMERA, ...saved.camera } });
  if (!(settings.style in MAP_STYLES)) settings.style = 'positron';
} catch { /* ignore corrupt settings */ }
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

// ---------- state ----------

const state = {
  dataset: null as Dataset | null,
  analysis: null as Analysis | null,
  cities: null as CityIndex | null,
  fileLabel: '',
  selStart: 0,
  selEnd: 0,
  activeTrip: -1,
  journey: null as Journey | null,
  exploreTrack: null as CameraTrack | null,
  exploreTrackKey: '',
  previewTrack: null as CameraTrack | null,
  previewTrackKey: '',
  progress: 0,
  videoSeconds: 0,
  playing: false,
  follow: true,
  speed: 1,
  tab: 'overview' as 'overview' | 'trips' | 'video',
  clock: 0,
  /** Smoothly hands the camera over when auto camera turns on. */
  handover: null as { from: Camera; started: number } | null,
  dirty: true,
  rendering: null as AbortController | null,
};

// ---------- DOM ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');
const stage = $('stage');
const overlay = $<HTMLCanvasElement>('overlay');
const overlayCtx = overlay.getContext('2d')!;
const playButton = $<HTMLButtonElement>('play');
const followBox = $<HTMLInputElement>('follow');
const nowPill = $('now');
const loadStatus = $('load-status');

const map = new LibreMap({
  container: 'map',
  style: MAP_STYLES[settings.style].url,
  center: [10, 25],
  zoom: 1.4,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  renderWorldCopies: true,
  attributionControl: { compact: true },
  maxPitch: 0,
});
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();

const bar = new TimelineBar($<HTMLCanvasElement>('bar'), $('bar-tooltip'), {
  onSelect: (start, end) => setSelection(start, end, tripAt(start, end)),
  onScrub: (time) => scrubTo(time),
});

// ---------- helpers ----------

function tzNear(time: number): number {
  const dataset = state.dataset!;
  return dataset.tz[clamp(lowerBound(dataset.t, time), 0, dataset.count - 1)];
}

function tripAt(start: number, end: number): number {
  const trips = state.analysis?.trips ?? [];
  return trips.findIndex((trip) => Math.abs(trip.start - start) < DAY_MS && Math.abs(trip.end - end) < DAY_MS);
}

function stageSize(): [number, number] {
  return [stage.clientWidth, stage.clientHeight];
}

function exploreFrame(): Frame {
  const [width, height] = stageSize();
  return { width, height, safe: { left: 40, top: 64, right: width - 40, bottom: height - 30 } };
}

function videoSize(): [number, number] {
  const [w, h] = settings.format.split('x').map(Number);
  return [w, h];
}

/** The rectangle in the stage where the video preview is shown. */
function previewRect(): { x: number; y: number; width: number; height: number } {
  const [stageWidth, stageHeight] = stageSize();
  const [w, h] = videoSize();
  const scale = Math.min((stageWidth - 40) / w, (stageHeight - 40) / h);
  const width = w * scale;
  const height = h * scale;
  return { x: (stageWidth - width) / 2, y: (stageHeight - height) / 2, width, height };
}

function referenceVideoFrame(): Frame {
  const [w, h] = videoSize();
  const ratio = Math.min(w, h) / 540;
  return hudFrame(w / ratio, h / ratio);
}

function isVideoMode(): boolean {
  return state.tab === 'video' && state.journey !== null;
}

function getExploreTrack(): CameraTrack | null {
  if (!state.journey) return null;
  const frame = exploreFrame();
  const key = `${frame.width}x${frame.height}:${JSON.stringify(settings.camera)}`;
  if (!state.exploreTrack || state.exploreTrackKey !== key) {
    state.exploreTrack = buildCameraTrack(state.journey, frame, settings.camera);
    state.exploreTrackKey = key;
  }
  return state.exploreTrack;
}

function getPreviewTrack(): CameraTrack | null {
  if (!state.journey) return null;
  const key = `${settings.format}:${JSON.stringify(settings.camera)}`;
  if (!state.previewTrack || state.previewTrackKey !== key) {
    state.previewTrack = buildCameraTrack(state.journey, referenceVideoFrame(), settings.camera);
    state.previewTrackKey = key;
  }
  return state.previewTrack;
}

function invalidateTracks(): void {
  state.exploreTrack = null;
  state.previewTrack = null;
}

function mapCamera(): Camera {
  const center = map.getCenter();
  return { x: mercatorX(center.lng), y: mercatorY(center.lat), zoom: map.getZoom() };
}

function jumpTo(camera: Camera): void {
  map.jumpTo({ center: toLngLat(camera), zoom: camera.zoom });
}

function videoTitle(): string {
  const custom = $<HTMLInputElement>('vid-title').value.trim();
  if (custom) return custom;
  const trip = state.activeTrip >= 0 ? state.analysis?.trips[state.activeTrip] : null;
  return state.journey ? defaultTitle(state.journey, trip?.label || null) : '';
}

function timing() {
  return videoTiming(settings.durationSec);
}

function introEnd(): number {
  const t = timing();
  return t.introHold + t.introMove;
}

/** Story progress shown right now (in video mode it follows the video clock). */
function currentProgress(): number {
  if (!isVideoMode()) return state.progress;
  return clamp((state.videoSeconds - introEnd()) / settings.durationSec, 0, 1);
}

// ---------- selection & journey ----------

function setSelection(start: number, end: number, trip = -1): void {
  if (!state.dataset) return;
  state.selStart = start;
  state.selEnd = end;
  state.activeTrip = trip;
  rebuildJourney();
  bar.setSelection(start, end);
  bar.focus(start, end);
  const startTz = tzNear(start);
  $<HTMLInputElement>('sel-start').value = isoDate(start, startTz);
  $<HTMLInputElement>('sel-end').value = isoDate(end, tzNear(end));
  state.progress = 0;
  state.videoSeconds = 0;
  setPlaying(false);
  showOverview();
  renderStats();
  renderTrips();
  updateHeatmap();
  state.dirty = true;
}

function rebuildJourney(): void {
  if (!state.dataset) return;
  state.journey = buildJourney(state.dataset, state.selStart, state.selEnd, {
    durationSec: settings.durationSec,
    pace: settings.pace,
  });
  invalidateTracks();
}

function showOverview(): void {
  const journey = state.journey;
  if (!journey) return;
  if (isVideoMode()) {
    state.videoSeconds = 0;
    applyCamera(false);
    return;
  }
  const camera = overviewCamera(journey, exploreFrame(), 14);
  map.easeTo({ center: toLngLat(camera), zoom: camera.zoom, duration: 700 });
}

function scrubTo(time: number): void {
  if (!state.journey) return;
  const progress = progressAtTime(state.journey, time);
  if (isVideoMode()) state.videoSeconds = introEnd() + progress * settings.durationSec;
  else state.progress = progress;
  if (state.follow) applyCamera(false);
  state.dirty = true;
}

// ---------- camera ----------

function targetCamera(): Camera | null {
  const journey = state.journey;
  if (!journey) return null;
  if (isVideoMode()) {
    const track = getPreviewTrack()!;
    const rect = previewRect();
    const frame = hudFrame(rect.width, rect.height);
    const overview = overviewCamera(journey, frame, settings.camera.maxZoom);
    return videoMoment(state.videoSeconds, timing(), track, overview, frame).camera;
  }
  return cameraAt(getExploreTrack()!, state.progress);
}

function applyCamera(useHandover: boolean): void {
  const target = targetCamera();
  if (!target) return;
  if (useHandover && state.handover) {
    const f = (performance.now() - state.handover.started) / 900;
    if (f < 1) {
      jumpTo(blendCameras(state.handover.from, target, easeInOut(f)));
      return;
    }
    state.handover = null;
  }
  jumpTo(target);
}

function setFollow(on: boolean): void {
  state.follow = on;
  followBox.checked = on;
  if (on) {
    state.handover = { from: mapCamera(), started: performance.now() };
    state.dirty = true;
  } else {
    state.handover = null;
  }
}

map.on('movestart', (event) => {
  // Any user gesture on the map hands control back to the user.
  if ((event as { originalEvent?: Event }).originalEvent && state.follow) setFollow(false);
});
map.on('move', () => { state.dirty = true; });
map.on('style.load', () => updateHeatmap());

// ---------- playback ----------

function setPlaying(on: boolean): void {
  if (on && state.journey) {
    if (isVideoMode() && state.videoSeconds >= totalSeconds(timing()) - 0.01) state.videoSeconds = 0;
    if (!isVideoMode() && state.progress >= 1) state.progress = 0;
    if (state.follow) state.handover = { from: mapCamera(), started: performance.now() };
  }
  state.playing = on && state.journey !== null;
  playButton.textContent = state.playing ? '❚❚' : '▶';
}

let lastFrame = performance.now();
let lastDraw = 0;
function tick(now: number): void {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  state.clock += dt;
  if (state.playing && state.journey) {
    if (isVideoMode()) {
      state.videoSeconds += dt * state.speed;
      const total = totalSeconds(timing());
      if (state.videoSeconds >= total) {
        state.videoSeconds = total;
        setPlaying(false);
      }
    } else {
      state.progress += (dt * state.speed) / settings.durationSec;
      if (state.progress >= 1) {
        state.progress = 1;
        setPlaying(false);
      }
    }
    state.dirty = true;
  }
  if (state.journey && state.follow && (state.playing || state.handover)) applyCamera(true);
  // Redraw on change; otherwise ~15 fps keeps the marker pulsing cheaply.
  if (state.dirty || now - lastDraw > 66) {
    draw();
    lastDraw = now;
    state.dirty = false;
  }
  requestAnimationFrame(tick);
}

// ---------- drawing ----------

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const [width, height] = stageSize();
  if (overlay.width !== Math.round(width * dpr) || overlay.height !== Math.round(height * dpr)) {
    overlay.width = Math.round(width * dpr);
    overlay.height = Math.round(height * dpr);
  }
  const ctx = overlayCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const journey = state.journey;
  if (!journey || !state.analysis) {
    nowPill.textContent = '';
    return;
  }
  const theme = themeFor(settings.style);
  const progress = currentProgress();
  const projector = new Projector(mapCamera(), width, height);
  const video = isVideoMode();
  const rect = previewRect();
  const unit = video ? rect.width / referenceVideoFrame().width : 1;
  let outro = 0;
  if (video) {
    const t = timing();
    outro = clamp((state.videoSeconds - introEnd() - t.journey) / t.outroMove, 0, 1);
  }
  const at = drawRoute(ctx, journey, projector, progress, {
    theme,
    showFuture: !video && settings.showFuture,
    showStays: settings.showStays,
    tail: 1.4 / settings.durationSec,
    reveal: outro,
    clock: state.clock,
    unit,
  });

  const context = { analysis: state.analysis, cities: state.cities };
  if (video) {
    // Dim everything outside the video frame, then draw the HUD inside it.
    ctx.fillStyle = 'rgba(12, 16, 28, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
    const hud = buildHud(journey, context, progress, outro, {
      title: videoTitle(), unit: settings.units, style: settings.style, durationSec: settings.durationSec,
    });
    drawHud(ctx, rect.x, rect.y, rect.width, rect.height, hud, theme);
  } else {
    const tz = journey.dataset.tz[journey.i0 + Math.max(0, at.index - 1)];
    const date = formatLocal(at.t, tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const place = placeLabel(journey, context, progress, 0.5 / settings.durationSec);
    nowPill.textContent = place ? `${date}  ·  ${place.replace('📍 ', '')}` : date;
  }
  bar.setPlayhead(at.t);
  $('playhead-label').textContent = `${formatDistance(at.km, settings.units)} of ${formatDistance(journey.totalKm, settings.units)}`;
}

// ---------- heatmap ----------

function heatmapData(): GeoJSON.FeatureCollection {
  const journey = state.journey;
  const features: GeoJSON.Feature[] = [];
  if (journey) {
    const step = Math.max(1, Math.ceil(journey.n / 60_000));
    const { lat, lng } = journey.dataset;
    for (let k = 0; k < journey.n; k += step) {
      const i = journey.i0 + k;
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng[i], lat[i]] } });
    }
  }
  return { type: 'FeatureCollection', features };
}

function updateHeatmap(): void {
  if (!map.isStyleLoaded()) return;
  const source = map.getSource('heat') as GeoJSONSource | undefined;
  if (!settings.heatmap) {
    if (map.getLayer('heat')) map.removeLayer('heat');
    if (source) map.removeSource('heat');
    return;
  }
  if (source) {
    source.setData(heatmapData());
    return;
  }
  map.addSource('heat', { type: 'geojson', data: heatmapData() });
  map.addLayer({
    id: 'heat',
    type: 'heatmap',
    source: 'heat',
    paint: {
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 2, 6, 10, 18, 15, 30],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 14, 2],
      'heatmap-opacity': 0.75,
    },
  });
}

// ---------- sidebar rendering ----------

function renderStats(): void {
  const { dataset, analysis, cities, journey } = state;
  const stats = $('stats');
  const places = $('places');
  if (!dataset || !analysis) return;
  if (!journey) {
    stats.innerHTML = '<div class="stat wide"><b>No locations</b><span>in the selected dates</span></div>';
    places.innerHTML = '';
    return;
  }
  const summary = summarize(dataset, analysis, cities, state.selStart, state.selEnd);
  const flags = summary.countries.map((cc) => `<span title="${countryName(cc)}">${flag(cc)}</span>`).join(' ');
  stats.innerHTML = `
    <div class="stat"><b>${formatDistance(summary.km, settings.units)}</b><span>travelled</span></div>
    <div class="stat"><b>${summary.days}</b><span>${summary.days === 1 ? 'day' : 'days'}</span></div>
    <div class="stat"><b>${summary.places.length}</b><span>places</span></div>
    <div class="stat"><b>${summary.flights}</b><span>flights</span></div>
    ${summary.countries.length ? `<div class="stat wide"><b>${flags}</b><span>${summary.countries.length} ${summary.countries.length === 1 ? 'country' : 'countries'}</span></div>` : ''}`;
  places.innerHTML = '';
  if (!cities) {
    places.innerHTML = '<li class="muted">City names unavailable</li>';
    return;
  }
  for (const place of summary.places.slice(0, 12)) {
    const city = cities.cities[place.city];
    const li = document.createElement('li');
    li.innerHTML = `<span>${flag(city.cc)} ${city.name}<span class="muted">, ${countryName(city.cc)}</span></span><span>${formatDuration(place.hours)}</span>`;
    li.addEventListener('click', () => {
      setFollow(false);
      map.flyTo({ center: [city.lng, city.lat], zoom: 11 });
    });
    places.append(li);
  }
}

function renderTrips(): void {
  const { analysis, dataset } = state;
  const list = $('trips');
  if (!analysis || !dataset) return;
  $('trip-count').textContent = String(analysis.trips.length);
  list.innerHTML = '';
  if (analysis.trips.length === 0) {
    list.innerHTML = '<li class="muted">No trips away from home were found.</li>';
    return;
  }
  [...analysis.trips.entries()].reverse().forEach(([index, trip]) => {
    const li = document.createElement('li');
    if (index === state.activeTrip) li.classList.add('active');
    const tz = tzNear(trip.start);
    const range = `${formatLocal(trip.start, tz, { day: 'numeric', month: 'short' })} – ${formatLocal(trip.end, tzNear(trip.end), { day: 'numeric', month: 'short', year: 'numeric' })}`;
    li.innerHTML = `
      <div class="row"><div class="title">${trip.countries.map(flag).join('')} ${trip.label || 'Trip'}</div>
      <button class="ghost make" title="Make a video of this trip">🎬 Video</button></div>
      <div class="meta">${range} · ${trip.days} ${trip.days === 1 ? 'day' : 'days'} · ${formatDistance(trip.km, settings.units)}</div>`;
    li.addEventListener('click', () => selectTrip(index));
    li.querySelector('.make')!.addEventListener('click', (event) => {
      event.stopPropagation();
      selectTrip(index);
      setTab('video');
    });
    list.append(li);
  });
}

function selectTrip(index: number): void {
  const trip = state.analysis!.trips[index];
  // A few hours either side shows the departure and the return home.
  setSelection(trip.start - 3 * 3.6e6, trip.end + 3 * 3.6e6, index);
}

function setTab(tab: typeof state.tab): void {
  const wasVideo = isVideoMode();
  state.tab = tab;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  document.querySelectorAll<HTMLElement>('.panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
  app.classList.toggle('video-mode', tab === 'video');
  if (isVideoMode() !== wasVideo && state.journey) {
    // Carry the playhead across the two clocks.
    if (isVideoMode()) state.videoSeconds = state.progress > 0 ? introEnd() + state.progress * settings.durationSec : 0;
    else state.progress = currentProgressFromVideo();
    setFollow(true);
  }
  state.dirty = true;
}

function currentProgressFromVideo(): number {
  return clamp((state.videoSeconds - introEnd()) / settings.durationSec, 0, 1);
}

// ---------- controls ----------

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab as typeof state.tab));
  });
  playButton.addEventListener('click', () => setPlaying(!state.playing));
  $('restart').addEventListener('click', () => {
    state.progress = 0;
    state.videoSeconds = 0;
    if (state.follow) state.handover = { from: mapCamera(), started: performance.now() };
    state.dirty = true;
  });
  $<HTMLSelectElement>('speed').addEventListener('change', (event) => {
    state.speed = Number((event.target as HTMLSelectElement).value);
  });
  followBox.addEventListener('change', () => {
    setFollow(followBox.checked);
  });
  $('fit').addEventListener('click', () => {
    setFollow(false);
    showOverview();
  });

  const styleSelect = $<HTMLSelectElement>('opt-style');
  for (const [id, style] of Object.entries(MAP_STYLES)) styleSelect.add(new Option(style.label, id, false, id === settings.style));
  styleSelect.addEventListener('change', () => {
    settings.style = styleSelect.value as MapStyleId;
    saveSettings();
    map.setStyle(MAP_STYLES[settings.style].url);
    bar.setAccent(themeFor(settings.style).tail);
    state.dirty = true;
  });

  const checkbox = (id: string, key: 'showFuture' | 'showStays' | 'heatmap', after?: () => void) => {
    const box = $<HTMLInputElement>(id);
    box.checked = settings[key];
    box.addEventListener('change', () => {
      settings[key] = box.checked;
      saveSettings();
      after?.();
      state.dirty = true;
    });
  };
  checkbox('opt-future', 'showFuture');
  checkbox('opt-stays', 'showStays');
  checkbox('opt-heatmap', 'heatmap', updateHeatmap);

  const units = $<HTMLSelectElement>('opt-units');
  units.value = settings.units;
  units.addEventListener('change', () => {
    settings.units = units.value as DistanceUnit;
    saveSettings();
    renderStats();
    renderTrips();
  });

  const dateInput = (id: string, isEnd: boolean) => {
    $<HTMLInputElement>(id).addEventListener('change', (event) => {
      const value = (event.target as HTMLInputElement).value;
      if (!value || !state.dataset) return;
      const midnight = Date.parse(`${value}T00:00:00Z`);
      const time = midnight - tzNear(midnight) * 60_000 + (isEnd ? DAY_MS - 1 : 0);
      const start = isEnd ? Math.min(state.selStart, time - DAY_MS + 1) : time;
      const end = isEnd ? time : Math.max(state.selEnd, time + DAY_MS - 1);
      setSelection(start, end);
    });
  };
  dateInput('sel-start', false);
  dateInput('sel-end', true);

  document.querySelectorAll<HTMLButtonElement>('#quick-ranges button').forEach((button) => {
    button.addEventListener('click', () => {
      const dataset = state.dataset;
      if (!dataset) return;
      const last = dataset.t[dataset.count - 1];
      const range = button.dataset.range!;
      if (range === 'all') setSelection(dataset.t[0], last);
      else if (range === 'year') {
        const year = new Date(last + tzNear(last) * 60_000).getUTCFullYear();
        setSelection(Date.UTC(year, 0, 1) - tzNear(last) * 60_000, last);
      } else setSelection(last - Number(range) * DAY_MS, last);
    });
  });

  // Video settings.
  const format = $<HTMLSelectElement>('vid-format');
  format.value = settings.format;
  format.addEventListener('change', () => {
    settings.format = format.value;
    saveSettings();
    state.previewTrack = null;
    if (state.follow) applyCamera(false);
    state.dirty = true;
  });
  const fps = $<HTMLSelectElement>('vid-fps');
  fps.value = String(settings.fps);
  fps.addEventListener('change', () => {
    settings.fps = Number(fps.value);
    saveSettings();
  });
  const slider = (id: string, read: () => number, write: (value: number) => void, label: (value: number) => string, rebuild: 'journey' | 'track') => {
    const input = $<HTMLInputElement>(id);
    const out = $(`${id}-out`);
    input.value = String(read());
    out.textContent = label(read());
    input.addEventListener('input', () => {
      write(Number(input.value));
      out.textContent = label(Number(input.value));
    });
    input.addEventListener('change', () => {
      saveSettings();
      const progress = currentProgress();
      if (rebuild === 'journey') rebuildJourney();
      else invalidateTracks();
      if (isVideoMode()) state.videoSeconds = progress > 0 ? introEnd() + progress * settings.durationSec : state.videoSeconds;
      if (state.follow) applyCamera(false);
      state.dirty = true;
    });
  };
  slider('vid-duration', () => settings.durationSec, (v) => { settings.durationSec = v; }, (v) => `${v} s`, 'journey');
  slider('cam-maxzoom', () => settings.camera.maxZoom, (v) => { settings.camera.maxZoom = v; }, (v) => `${v}`, 'track');
  slider('pace', () => settings.pace, (v) => { settings.pace = v; }, (v) => (v < 0.4 ? 'by time' : v > 1.5 ? 'by movement' : 'balanced'), 'journey');
  const windowSelect = $<HTMLSelectElement>('cam-window');
  windowSelect.value = String(settings.camera.windowSec);
  if (windowSelect.selectedIndex < 0) windowSelect.value = '2';
  windowSelect.addEventListener('change', () => {
    settings.camera.windowSec = Number(windowSelect.value);
    saveSettings();
    invalidateTracks();
    if (state.follow) applyCamera(false);
    state.dirty = true;
  });
  $<HTMLInputElement>('vid-title').addEventListener('input', () => { state.dirty = true; });

  $('vid-preview').addEventListener('click', () => {
    if (!state.journey) return;
    setTab('video');
    state.videoSeconds = 0;
    setFollow(true);
    setPlaying(true);
  });
  $('vid-render').addEventListener('click', () => void renderVideo());
  $('vid-cancel').addEventListener('click', () => state.rendering?.abort());

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
    if (event.code === 'Space') {
      event.preventDefault();
      setPlaying(!state.playing);
    } else if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') {
      const step = (event.code === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1);
      if (isVideoMode()) state.videoSeconds = clamp(state.videoSeconds + step, 0, totalSeconds(timing()));
      else state.progress = clamp(state.progress + step / settings.durationSec, 0, 1);
      if (state.follow) applyCamera(false);
      state.dirty = true;
    }
  });

  new ResizeObserver(() => {
    map.resize();
    state.exploreTrack = null;
    state.dirty = true;
  }).observe(stage);
}

// ---------- video export ----------

async function renderVideo(): Promise<void> {
  const journey = state.journey;
  if (!journey || !state.analysis || state.rendering) return;
  const error = $('vid-error');
  error.hidden = true;
  if (!canExportVideo()) {
    error.textContent = 'This browser cannot encode video. Use a recent Chrome, Edge or Safari (16.4+).';
    error.hidden = false;
    return;
  }
  setPlaying(false);
  const controller = new AbortController();
  state.rendering = controller;
  const renderButton = $<HTMLButtonElement>('vid-render');
  renderButton.disabled = true;
  $('vid-progress').hidden = false;
  $('vid-result').hidden = true;
  const progressBar = $<HTMLProgressElement>('vid-progress-bar');
  const progressText = $('vid-progress-text');
  const [width, height] = videoSize();
  const title = videoTitle();
  const context = { analysis: state.analysis, cities: state.cities };
  try {
    const blob = await exportVideo({
      journey,
      width,
      height,
      fps: settings.fps,
      style: settings.style,
      camera: settings.camera,
      showStays: settings.showStays,
      hud: (progress, outro) => buildHud(journey, context, progress, outro, {
        title, unit: settings.units, style: settings.style, durationSec: settings.durationSec,
      }),
      onProgress: (done, total, eta) => {
        progressBar.value = done / total;
        progressText.textContent = `Frame ${done} / ${total}${eta !== null ? ` · about ${Math.ceil(eta)} s left` : ''}`;
      },
      signal: controller.signal,
    });
    const url = URL.createObjectURL(blob);
    const player = $<HTMLVideoElement>('vid-player');
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = url;
    const link = $<HTMLAnchorElement>('vid-download');
    link.href = url;
    const tz = journey.dataset.tz[journey.i0];
    link.download = `timeline-${isoDate(journey.startTime, tz)}_${isoDate(journey.endTime, tz)}.mp4`;
    link.textContent = `Download MP4 (${(blob.size / 1e6).toFixed(1)} MB)`;
    $('vid-result').hidden = false;
  } catch (failure) {
    if ((failure as Error).name !== 'AbortError') {
      error.textContent = `Video creation failed: ${(failure as Error).message}`;
      error.hidden = false;
    }
  } finally {
    state.rendering = null;
    renderButton.disabled = false;
    $('vid-progress').hidden = true;
  }
}

// ---------- loading ----------

const citiesPromise = loadCities().catch((failure) => {
  console.warn(failure);
  return null;
});

function loadFiles(files: File[]): void {
  if (files.length === 0) return;
  loadStatus.className = 'status';
  loadStatus.textContent = 'Starting…';
  app.classList.add('empty');
  const worker = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = async (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.type === 'progress') {
      loadStatus.textContent = message.message;
      return;
    }
    worker.terminate();
    if (message.type === 'error') {
      loadStatus.className = 'status error';
      loadStatus.textContent = message.message;
      return;
    }
    loadStatus.textContent = 'Finding places and trips…';
    const dataset = message.dataset;
    state.cities = await citiesPromise;
    state.dataset = dataset;
    state.analysis = analyze(dataset, state.cities);
    state.fileLabel = files.length === 1 ? files[0].name : `${files.length} files`;
    const first = formatLocal(dataset.t[0], dataset.tz[0], { month: 'short', year: 'numeric' });
    const last = formatLocal(dataset.t[dataset.count - 1], dataset.tz[dataset.count - 1], { month: 'short', year: 'numeric' });
    $('file-info').textContent = `${state.fileLabel} · ${first} – ${last} · ${dataset.count.toLocaleString()} points`;
    app.classList.remove('empty');
    loadStatus.textContent = '';
    bar.setData(dataset, state.analysis);
    bar.setAccent(themeFor(settings.style).tail);
    // Start with the most recent trip, or the last month.
    const trips = state.analysis.trips;
    const lastTime = dataset.t[dataset.count - 1];
    const recent = trips.length > 0 && lastTime - trips[trips.length - 1].end < 120 * DAY_MS ? trips.length - 1 : -1;
    if (recent >= 0) selectTrip(recent);
    else setSelection(lastTime - 30 * DAY_MS, lastTime);
    setTab('overview');
  };
  worker.postMessage({ files });
}

function bindLoading(): void {
  const input = $<HTMLInputElement>('file');
  $('choose').addEventListener('click', () => input.click());
  $('open-file').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    loadFiles([...(input.files ?? [])]);
    input.value = '';
  });
  const drop = $('drop');
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('dragging');
    app.classList.add('empty');
  });
  window.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) {
      drop.classList.remove('dragging');
      if (state.dataset) app.classList.remove('empty');
    }
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragging');
    const files = [...(event.dataTransfer?.files ?? [])].filter((file) => file.name.toLowerCase().endsWith('.json'));
    if (files.length > 0) loadFiles(files);
    else if (state.dataset) app.classList.remove('empty');
  });
}

bindControls();
bindLoading();
requestAnimationFrame(tick);
// Exposed for debugging in the console.
Object.assign(window, { timelineExplorer: { state, settings, map, positionAt } });
