import { haversineKm, lowerBound } from './geo';
import { SEG_FLIGHT, SEG_GAP, type Dataset } from './parse';
import type { CityIndex } from './places';

const DAY_MS = 86_400_000;

export interface Day {
  /** Days since the epoch, in local time. */
  index: number;
  /** Dataset index range [first, last] of points recorded that day; first = -1 when empty. */
  first: number;
  last: number;
  km: number;
  away: boolean;
  trip: number;
}

export interface Trip {
  start: number;
  end: number;
  days: number;
  km: number;
  label: string;
  countries: string[];
  farthestKm: number;
}

export interface Analysis {
  days: Day[];
  trips: Trip[];
  homeCity: number;
  /** City index per dataset point, or -1. */
  cityOf: Int32Array | null;
}

export function localDayIndex(t: number, tzMinutes: number): number {
  return Math.floor((t + tzMinutes * 60_000) / DAY_MS);
}

export function dayLabel(index: number, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  return new Date(index * DAY_MS).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

export function assignCities(dataset: Dataset, cities: CityIndex): Int32Array {
  const out = new Int32Array(dataset.count);
  for (let i = 0; i < dataset.count; i += 1) out[i] = cities.lookup(dataset.lat[i], dataset.lng[i]);
  return out;
}

/** Hours spent per city in dataset range [from, to], skipping flights and gaps. */
export function cityHours(dataset: Dataset, cityOf: Int32Array, from: number, to: number): Map<number, number> {
  const hours = new Map<number, number>();
  for (let i = Math.max(from, 0); i < Math.min(to, dataset.count - 1); i += 1) {
    const city = cityOf[i];
    if (city < 0 || dataset.kind[i + 1] === SEG_FLIGHT || dataset.kind[i + 1] === SEG_GAP) continue;
    const h = Math.min(8, (dataset.t[i + 1] - dataset.t[i]) / 3.6e6);
    hours.set(city, (hours.get(city) ?? 0) + h);
  }
  return hours;
}

function gridKey(lat: number, lng: number): number {
  return Math.round(lat * 5) * 10_000 + Math.round(lng * 5);
}

export function analyze(dataset: Dataset, cities: CityIndex | null): Analysis {
  const cityOf = cities ? assignCities(dataset, cities) : null;
  if (dataset.count === 0) return { days: [], trips: [], homeCity: -1, cityOf };
  const firstDay = localDayIndex(dataset.t[0], dataset.tz[0]);
  const lastDay = localDayIndex(dataset.t[dataset.count - 1], dataset.tz[dataset.count - 1]);
  const days: Day[] = [];
  for (let d = firstDay; d <= lastDay; d += 1) days.push({ index: d, first: -1, last: -1, km: 0, away: false, trip: -1 });

  for (let i = 0; i < dataset.count; i += 1) {
    const d = localDayIndex(dataset.t[i], dataset.tz[i]) - firstDay;
    const day = days[Math.max(0, Math.min(days.length - 1, d))];
    if (day.first < 0) day.first = i;
    day.last = i;
    if (i > 0 && dataset.kind[i] !== SEG_GAP) {
      day.km += haversineKm(dataset.lat[i - 1], dataset.lng[i - 1], dataset.lat[i], dataset.lng[i]);
    }
  }

  // Home = the most common overnight location within ±60 days, so moving house is handled.
  const nightKeys = days.map((day) => (day.first < 0 ? null : gridKey(dataset.lat[day.last], dataset.lng[day.last])));
  const homeIndex = new Int32Array(days.length).fill(-1);
  const counts = new Map<number, number>();
  const reach = 60;
  const add = (d: number, delta: number) => {
    const key = nightKeys[d];
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + delta);
  };
  for (let d = 0; d < Math.min(days.length, reach); d += 1) add(d, 1);
  for (let d = 0; d < days.length; d += 1) {
    if (d + reach < days.length) add(d + reach, 1);
    if (d - reach - 1 >= 0) add(d - reach - 1, -1);
    let bestKey = -1;
    let bestCount = 0;
    for (const [key, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestKey = key;
      }
    }
    if (bestCount === 0) continue;
    // Representative point: the nearest night in that cell.
    for (let offset = 0; offset <= reach; offset += 1) {
      const candidates = [d - offset, d + offset];
      const hit = candidates.find((c) => c >= 0 && c < days.length && nightKeys[c] === bestKey);
      if (hit !== undefined) {
        homeIndex[d] = days[hit].last;
        break;
      }
    }
  }

  const farthest = new Float64Array(days.length);
  for (let d = 0; d < days.length; d += 1) {
    const day = days[d];
    const home = homeIndex[d];
    if (day.first < 0 || home < 0) continue;
    let far = 0;
    for (let i = day.first; i <= day.last; i += 1) {
      far = Math.max(far, haversineKm(dataset.lat[i], dataset.lng[i], dataset.lat[home], dataset.lng[home]));
    }
    const nightKm = haversineKm(dataset.lat[day.last], dataset.lng[day.last], dataset.lat[home], dataset.lng[home]);
    farthest[d] = far;
    day.away = nightKm > 50 || far > 100;
  }

  // Bridge short gaps without data between away days.
  for (let d = 1; d < days.length; d += 1) {
    if (days[d].first >= 0 || !days[d - 1].away) continue;
    let e = d;
    while (e < days.length && days[e].first < 0) e += 1;
    if (e < days.length && e - d <= 3 && days[e].away) for (let k = d; k < e; k += 1) days[k].away = true;
  }

  let homeCity = -1;
  if (cityOf) {
    const homeVotes = new Map<number, number>();
    for (let d = 0; d < days.length; d += 1) {
      const city = homeIndex[d] >= 0 ? cityOf[homeIndex[d]] : -1;
      if (city >= 0) homeVotes.set(city, (homeVotes.get(city) ?? 0) + 1);
    }
    homeCity = [...homeVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
  }

  const trips: Trip[] = [];
  for (let d = 0; d < days.length; d += 1) {
    if (!days[d].away) continue;
    let e = d;
    while (e + 1 < days.length && days[e + 1].away) e += 1;
    const dataDays = days.slice(d, e + 1).filter((day) => day.first >= 0);
    if (dataDays.length > 0) {
      const from = dataDays[0].first;
      const to = dataDays[dataDays.length - 1].last;
      const homeAtStart = homeIndex[d] >= 0 ? cityOf?.[homeIndex[d]] ?? -1 : -1;
      const trip: Trip = {
        start: dataset.t[from],
        end: dataset.t[to],
        days: e - d + 1,
        km: dataDays.reduce((sum, day) => sum + day.km, 0),
        label: '',
        countries: [],
        farthestKm: Math.max(...Array.from(farthest.subarray(d, e + 1))),
      };
      if (cities && cityOf) {
        const hours = cityHours(dataset, cityOf, from, to);
        const ranked = [...hours.entries()]
          .filter(([city, h]) => city !== homeAtStart && h >= 0.5)
          .sort((a, b) => b[1] - a[1]);
        trip.label = ranked.slice(0, 3).map(([city]) => cities.cities[city].name).join(', ');
        trip.countries = [...new Set(ranked.map(([city]) => cities.cities[city].cc))];
      }
      for (let k = d; k <= e; k += 1) days[k].trip = trips.length;
      trips.push(trip);
    }
    d = e;
  }
  return { days, trips, homeCity, cityOf };
}

export interface SelectionSummary {
  km: number;
  days: number;
  flights: number;
  places: { city: number; hours: number }[];
  countries: string[];
}

export function summarize(
  dataset: Dataset,
  analysis: Analysis,
  cities: CityIndex | null,
  start: number,
  end: number,
): SelectionSummary {
  const from = lowerBound(dataset.t, start);
  const to = lowerBound(dataset.t, end + 1) - 1;
  let km = 0;
  let flights = 0;
  for (let i = from + 1; i <= to; i += 1) {
    if (dataset.kind[i] === SEG_GAP) continue;
    if (dataset.kind[i] === SEG_FLIGHT && (i === from + 1 || dataset.kind[i - 1] !== SEG_FLIGHT)) flights += 1;
    km += haversineKm(dataset.lat[i - 1], dataset.lng[i - 1], dataset.lat[i], dataset.lng[i]);
  }
  const days = to >= from
    ? localDayIndex(dataset.t[to], dataset.tz[to]) - localDayIndex(dataset.t[from], dataset.tz[from]) + 1
    : 0;
  if (!cities || !analysis.cityOf || to < from) return { km, days, flights, places: [], countries: [] };
  const hours = cityHours(dataset, analysis.cityOf, from, to);
  const places = [...hours.entries()]
    .filter(([, h]) => h >= 0.25)
    .sort((a, b) => b[1] - a[1])
    .map(([city, h]) => ({ city, hours: h }));
  const countries = [...new Set(places.filter((place) => place.hours >= 1).map((place) => cities.cities[place.city].cc))];
  return { km, days, flights, places, countries };
}
