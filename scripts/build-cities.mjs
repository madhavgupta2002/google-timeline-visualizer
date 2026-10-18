// Converts GeoNames cities15000.txt into a compact public/cities.json.
// Usage: node scripts/build-cities.mjs /path/to/cities15000.txt
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/build-cities.mjs cities15000.txt');
  process.exit(1);
}
const rows = [];
for (const line of readFileSync(input, 'utf8').split('\n')) {
  const f = line.split('\t');
  if (f.length < 15) continue;
  // Skip city sections (PPLX, e.g. "Rohini" in Delhi) and historical/abandoned places.
  if (['PPLX', 'PPLH', 'PPLQ', 'PPLW'].includes(f[7])) continue;
  const lat = Number(f[4]);
  const lng = Number(f[5]);
  const pop = Number(f[14]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  rows.push([f[1], f[8], Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4, pop || 0]);
}
rows.sort((a, b) => b[4] - a[4]);
writeFileSync(new URL('../public/cities.json', import.meta.url), JSON.stringify(rows));
console.log(`wrote ${rows.length} cities`);
