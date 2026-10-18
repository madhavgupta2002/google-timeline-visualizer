import { haversineKm } from './geo';

export interface City {
  name: string;
  cc: string;
  lat: number;
  lng: number;
  pop: number;
}

export type CityRow = [string, string, number, number, number];

const CELL = 0.5;
const PREFERRED_RADIUS_KM = 30;
const FALLBACK_RADIUS_KM = 60;

function cellKey(latCell: number, lngCell: number): number {
  return (latCell + 400) * 1000 + (((lngCell % 720) + 720) % 720);
}

/** Offline nearest-city lookup over the GeoNames cities15000 dataset. */
export class CityIndex {
  private readonly grid = new Map<number, number[]>();
  private readonly cache = new Map<number, number>();

  constructor(readonly cities: City[]) {
    cities.forEach((city, index) => {
      const key = cellKey(Math.floor(city.lat / CELL), Math.floor(city.lng / CELL));
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(index);
      else this.grid.set(key, [index]);
    });
  }

  static fromRows(rows: CityRow[]): CityIndex {
    return new CityIndex(rows.map(([name, cc, lat, lng, pop]) => ({ name, cc, lat, lng, pop })));
  }

  /**
   * Returns the index of the city that best describes this location, or -1.
   * Larger cities win over nearby boroughs (the Bronx -> New York City), but a
   * real town you are standing in still beats a metropolis ~30 km away.
   */
  lookup(lat: number, lng: number): number {
    const cacheKey = Math.round(lat * 50) * 100_000 + Math.round(lng * 50);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const latCell = Math.floor(lat / CELL);
    const lngCell = Math.floor(lng / CELL);
    const lngReach = Math.min(6, Math.ceil(FALLBACK_RADIUS_KM / (111 * CELL * Math.max(0.15, Math.cos(lat * Math.PI / 180)))));
    let best = -1;
    let bestScore = -Infinity;
    let nearest = -1;
    let nearestKm = Infinity;
    for (let dLat = -2; dLat <= 2; dLat += 1) {
      for (let dLng = -lngReach; dLng <= lngReach; dLng += 1) {
        const bucket = this.grid.get(cellKey(latCell + dLat, lngCell + dLng));
        if (!bucket) continue;
        for (const index of bucket) {
          const city = this.cities[index];
          const km = haversineKm(lat, lng, city.lat, city.lng);
          if (km < nearestKm) {
            nearestKm = km;
            nearest = index;
          }
          if (km > PREFERRED_RADIUS_KM) continue;
          const score = Math.log10(Math.max(10, city.pop)) - km / 25;
          if (score > bestScore) {
            bestScore = score;
            best = index;
          }
        }
      }
    }
    const result = best >= 0 ? best : nearestKm <= FALLBACK_RADIUS_KM ? nearest : -1;
    if (this.cache.size > 200_000) this.cache.clear();
    this.cache.set(cacheKey, result);
    return result;
  }
}

let regionNames: Intl.DisplayNames | null = null;

export function countryName(cc: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(cc) ?? cc;
  } catch {
    return cc;
  }
}

export function flag(cc: string): string {
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export async function loadCities(url = `${import.meta.env.BASE_URL}cities.json`): Promise<CityIndex> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load city names (${response.status}).`);
  return CityIndex.fromRows(await response.json() as CityRow[]);
}
