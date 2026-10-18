import { summarize, type Analysis, type SelectionSummary } from './analysis';
import { formatDistance, formatLocal, type DistanceUnit } from './format';
import { lowerBound, upperBound } from './geo';
import { positionAt, type Journey } from './journey';
import { THEMES, type HudContent, type Theme } from './overlay';
import { SEG_FLIGHT } from './parse';
import { countryName, flag, type CityIndex } from './places';

export type MapStyleId = 'positron' | 'voyager' | 'dark-matter' | 'liberty';

export const MAP_STYLES: Record<MapStyleId, { label: string; url: string; theme: 'light' | 'dark'; attribution: string }> = {
  positron: {
    label: 'Light',
    url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    theme: 'light',
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  voyager: {
    label: 'Voyager',
    url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    theme: 'light',
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  'dark-matter': {
    label: 'Dark',
    url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    theme: 'dark',
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  liberty: {
    label: 'Liberty (OpenFreeMap)',
    url: 'https://tiles.openfreemap.org/styles/liberty',
    theme: 'light',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
};

export function themeFor(style: MapStyleId): Theme {
  return THEMES[MAP_STYLES[style].theme];
}

export interface PlaceContext {
  analysis: Analysis;
  cities: CityIndex | null;
}

function cityName(context: PlaceContext, datasetIndex: number, withCountry: boolean): string | null {
  const city = context.analysis.cityOf?.[datasetIndex] ?? -1;
  if (city < 0 || !context.cities) return null;
  const info = context.cities.cities[city];
  return withCountry ? `${info.name}, ${countryName(info.cc)} ${flag(info.cc)}` : info.name;
}

/**
 * The place shown in the HUD: the city you spent the most story time in
 * within a short window, so the label does not flicker between suburbs. While
 * flying it shows "origin → destination".
 */
export function placeLabel(journey: Journey, context: PlaceContext, progress: number, windowProgress: number): string {
  const at = positionAt(journey, progress);
  if (at.kind === SEG_FLIGHT && at.fraction > 0 && at.fraction < 1) {
    // Name the ends of the whole flight, not GPS fixes recorded mid-air.
    let first = at.index;
    while (first > 1 && journey.kind[first - 1] === SEG_FLIGHT) first -= 1;
    let last = at.index;
    while (last + 1 < journey.n && journey.kind[last + 1] === SEG_FLIGHT) last += 1;
    const from = cityName(context, journey.i0 + first - 1, false) ?? 'Departure';
    const to = cityName(context, journey.i0 + last, false) ?? 'Arrival';
    return `✈  ${from} → ${to}`;
  }
  const cityOf = context.analysis.cityOf;
  if (!cityOf || !context.cities) return '';
  const lo = Math.max(0, lowerBound(journey.p, progress - windowProgress) - 1);
  const hi = Math.min(journey.n - 1, upperBound(journey.p, progress + windowProgress));
  const weights = new Map<number, number>();
  for (let k = lo; k <= hi; k += 1) {
    const city = cityOf[journey.i0 + k];
    if (city < 0) continue;
    const weight = (k + 1 < journey.n ? journey.p[k + 1] - journey.p[k] : 0) + 1e-9;
    weights.set(city, (weights.get(city) ?? 0) + weight);
  }
  let best = -1;
  let bestWeight = 0;
  for (const [city, weight] of weights) {
    if (weight > bestWeight) {
      best = city;
      bestWeight = weight;
    }
  }
  if (best < 0) return '';
  const info = context.cities.cities[best];
  return `📍 ${info.name}, ${countryName(info.cc)} ${flag(info.cc)}`;
}

const summaries = new WeakMap<Journey, SelectionSummary>();

/** Same numbers as the sidebar, computed once per journey. */
function selectionSummary(journey: Journey, context: PlaceContext): SelectionSummary {
  let summary = summaries.get(journey);
  if (!summary) {
    summary = summarize(journey.dataset, context.analysis, context.cities, journey.startTime, journey.endTime);
    summaries.set(journey, summary);
  }
  return summary;
}

export interface HudOptions {
  title: string;
  unit: DistanceUnit;
  style: MapStyleId;
  durationSec: number;
}

export function buildHud(
  journey: Journey,
  context: PlaceContext,
  progress: number,
  outro: number,
  options: HudOptions,
): HudContent {
  const at = positionAt(journey, progress);
  const tz = journey.dataset.tz[journey.i0 + Math.max(0, at.index - 1)];
  const startTz = journey.dataset.tz[journey.i0];
  const dayMs = 86_400_000;
  const dayNumber = Math.floor((at.t + tz * 60_000) / dayMs) - Math.floor((journey.startTime + startTz * 60_000) / dayMs) + 1;
  const endTz = journey.dataset.tz[journey.i0 + journey.n - 1];
  const totalDays = Math.floor((journey.endTime + endTz * 60_000) / dayMs) - Math.floor((journey.startTime + startTz * 60_000) / dayMs) + 1;
  let summary: string | null = null;
  if (outro > 0) {
    const stats = selectionSummary(journey, context);
    const parts = [formatDistance(journey.totalKm, options.unit), `${totalDays} ${totalDays === 1 ? 'day' : 'days'}`];
    if (stats.places.length > 0) parts.push(`${stats.places.length} ${stats.places.length === 1 ? 'place' : 'places'}`);
    if (stats.countries.length > 1) parts.push(`${stats.countries.length} countries`);
    if (journey.flightCount > 0) parts.push(`${journey.flightCount} ${journey.flightCount === 1 ? 'flight' : 'flights'}`);
    summary = parts.join('  ·  ');
  }
  return {
    title: options.title,
    date: formatLocal(at.t, tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    place: outro > 0 ? '' : placeLabel(journey, context, progress, 0.5 / Math.max(1, options.durationSec)),
    distance: formatDistance(at.km, options.unit),
    dayCounter: `Day ${Math.min(totalDays, Math.max(1, dayNumber))} of ${totalDays}`,
    attribution: MAP_STYLES[options.style].attribution,
    summary,
    summaryAlpha: Math.min(1, outro * 1.5),
  };
}

export function defaultTitle(journey: Journey, label: string | null): string {
  const tz = journey.dataset.tz[journey.i0];
  const start = formatLocal(journey.startTime, tz, { day: 'numeric', month: 'short', year: 'numeric' });
  const end = formatLocal(journey.endTime, journey.dataset.tz[journey.i0 + journey.n - 1], { day: 'numeric', month: 'short', year: 'numeric' });
  const range = start === end ? start : `${start} – ${end}`;
  return label ? `${label} · ${range}` : range;
}
