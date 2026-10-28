const MILES_PER_DEG_LAT = 69.0;

export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Flat projection in miles from a center point (fine at county scale).
export function toMiles(center: { lat: number; lng: number }, lat: number, lng: number) {
  const x = (lng - center.lng) * Math.cos((center.lat * Math.PI) / 180) * MILES_PER_DEG_LAT;
  const y = (lat - center.lat) * MILES_PER_DEG_LAT;
  return { x, y };
}
