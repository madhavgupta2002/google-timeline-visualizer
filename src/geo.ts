const EARTH_RADIUS_KM = 6371.0088;
const MAX_LAT = 85.05112878;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Web Mercator x in [0, 1), west to east. */
export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/** Web Mercator y in [0, 1], north to south. */
export function mercatorY(lat: number): number {
  const sin = Math.sin(clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

export function lngFromX(x: number): number {
  let lng = x * 360 - 180;
  lng = ((lng + 180) % 360 + 360) % 360 - 180;
  return lng;
}

export function latFromY(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}

/** Returns `x` shifted by whole worlds so that it lies within half a world of `reference`. */
export function unwrapNear(x: number, reference: number): number {
  return x - Math.round(x - reference);
}

export function lowerBound(values: ArrayLike<number>, target: number, from = 0, to = values.length): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function upperBound(values: ArrayLike<number>, target: number, from = 0, to = values.length): number {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}
