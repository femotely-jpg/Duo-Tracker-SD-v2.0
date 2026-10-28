// Everything San Diego specific lives in this file.

export type Model = {
  part: string; // Apple part number, e.g. "MXXX3LL/A"
  label: string; // What you see in the app
  buyUrl?: string; // Optional exact buy page; defaults to apple.com/shop/product/<part>
};

// US iPhone Duo part numbers (A3447). One part number covers unlocked and carrier,
// since the US model is eSIM only. Delete any line you don't want to watch.
export const MODELS: Model[] = [
  { part: "MK1F4LL/A", label: "Night Sky, 256GB" },
  { part: "MK1E4LL/A", label: "Star White, 256GB" },
  { part: "MK1H4LL/A", label: "Night Sky, 512GB" },
  { part: "MK1G4LL/A", label: "Star White, 512GB" },
  { part: "MK1L4LL/A", label: "Night Sky, 1TB" },
  { part: "MK1J4LL/A", label: "Star White, 1TB" },
  { part: "MK1R4LL/A", label: "Night Sky, 2TB" },
  { part: "MK1Q4LL/A", label: "Star White, 2TB" },
];

export const isConfigured = (m: Model) => !m.part.startsWith("REPLACE");
export const buyUrlFor = (m: Model) =>
  m.buyUrl ?? `https://www.apple.com/shop/product/${encodeURIComponent(m.part)}`;

// Map center: Mission Valley.
export const CENTER = { lat: 32.7713, lng: -117.1625, label: "Mission Valley" };

// ZIPs Apple is asked about. Each returns the stores nearest to it; results are merged.
// 92108 covers central and south county, 92008 (Carlsbad) makes sure north county is included.
export const ZIPS = ["92108", "92008"];

// Only stores in San Diego County are shown. Apple reports each store's city;
// a store counts if its city is on this list (all 18 county cities plus common
// community names Apple uses for addresses).
export const COUNTY_CITIES = [
  "san diego", "la jolla", "carlsbad", "escondido", "chula vista", "oceanside",
  "el cajon", "vista", "san marcos", "encinitas", "national city", "la mesa",
  "santee", "poway", "imperial beach", "lemon grove", "coronado", "solana beach",
  "del mar", "rancho bernardo", "carmel valley", "mission valley", "otay ranch",
  "rancho santa fe", "spring valley", "fallbrook", "ramona", "alpine",
];
export const inCounty = (city: string) => COUNTY_CITIES.includes(city.trim().toLowerCase());

// Safety net: ignore anything farther than this from CENTER even if the city matches.
export const RADIUS_MILES = 60;
export const RINGS = [10, 20, 30];
export const POLL_MS = 5000;
export const TIME_ZONE = "America/Los_Angeles";

// Map decoration (lat, lng).
export const PLACES: { name: string; lat: number; lng: number }[] = [
  { name: "La Jolla", lat: 32.85, lng: -117.205 },
  { name: "North County", lat: 33.14, lng: -117.17 },
  { name: "South Bay", lat: 32.575, lng: -117.08 },
  { name: "East County", lat: 32.8, lng: -116.93 },
  { name: "Pacific", lat: 32.98, lng: -117.45 },
];

// Rough coastline, north to south, used to shade the ocean.
export const COAST: [number, number][] = [
  [33.75, -118.0], [33.6, -117.88], [33.46, -117.69], [33.39, -117.59],
  [33.2, -117.39], [33.05, -117.29], [32.95, -117.26], [32.85, -117.27],
  [32.8, -117.25], [32.75, -117.25], [32.68, -117.18], [32.6, -117.13],
  [32.53, -117.12], [32.4, -117.1],
];
