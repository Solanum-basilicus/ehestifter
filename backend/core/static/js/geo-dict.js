// Lightweight loader & helpers around a shared countries/cities dictionary.
// The file is expected at /static/data/geo.sample.json (you can replace with a full dataset later).
// Shape:
// {
//   "countries": [ { "name": "Germany", "code": "DE", "priority": true }, ... , { "name": "European Union", "code": "EU", "priority": true } ],
//   "cities": { "DE": ["Berlin","Munich",...], "FR": ["Paris", ...], "EU": ["Brussels","Luxembourg","Strasbourg"] }
// }

let GEO = null;

export async function loadGeoDict(path = "/static/data/geo.sample8.json") {
  if (GEO) return GEO;
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`Failed to load geo dict: HTTP ${r.status}`);
  GEO = await r.json();
  return GEO;
}

export function countryLookup(input) {
  if (!GEO) return null;
  const raw = (input || "").trim();
  if (!raw) return null;
  // Accept "Name (CC)", "CC", or "Name"
  const m = raw.match(/\((\w{2})\)\s*$/i);
  if (m) {
    const cc = m[1].toUpperCase();
    return GEO.countries.find(c => c.code === cc) || null;
  }
  const byCode = GEO.countries.find(c => c.code.toLowerCase() === raw.toLowerCase());
  if (byCode) return byCode;
  const byName = GEO.countries.find(c => c.name.toLowerCase() === raw.toLowerCase());
  if (byName) return byName;
  const starts = GEO.countries.find(c => c.name.toLowerCase().startsWith(raw.toLowerCase()));
  return starts || null;
}

export function prioritizedCountries() {
  if (!GEO) return [];
  const pri = GEO.countries.filter(c => !!c.priority);
  const rest = GEO.countries.filter(c => !c.priority).sort((a,b) => a.name.localeCompare(b.name));
  return [...pri, ...rest];
}

export function citiesByCountry(cc) {
  if (!GEO) return [];
  const key = (cc || "").toUpperCase();
  return GEO.cities[key] || [];
}

// Return countries whose name/code starts with the given prefix (case-insensitive).
export function countryMatches(prefix) {
  if (!GEO) return [];
  const p = (prefix || "").trim().toLowerCase();
  if (!p) return [];
  return prioritizedCountries().filter(
    c => c.name.toLowerCase().startsWith(p) || c.code.toLowerCase().startsWith(p)
  );
}

// Also expose for templates that don't import everything explicitly.
if (typeof window !== "undefined") {
  window.countryMatches = countryMatches;
}