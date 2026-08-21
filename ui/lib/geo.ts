/**
 * Slippy map tile arithmetic and great circle distance.
 *
 * The property map thumbnail is a 3x3 grid of OpenStreetMap raster tiles with a
 * marker positioned by the same maths. That keeps a real map on the page with no
 * mapping library, no API key and no tile server of our own.
 */

export const TILE_SIZE = 256;

export interface TilePosition {
  /** Tile column and row containing the point. */
  x: number;
  y: number;
  z: number;
  /** Pixel offset of the point inside that tile, 0..255. */
  offsetX: number;
  offsetY: number;
}

export function latLonToTile(lat: number, lon: number, zoom: number): TilePosition {
  const clampedLat = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const n = 2 ** zoom;
  const xFloat = ((lon + 180) / 360) * n;
  const latRad = (clampedLat * Math.PI) / 180;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(xFloat);
  const y = Math.floor(yFloat);
  return {
    x,
    y,
    z: zoom,
    offsetX: (xFloat - x) * TILE_SIZE,
    offsetY: (yFloat - y) * TILE_SIZE,
  };
}

export function tileUrl(x: number, y: number, z: number): string {
  const n = 2 ** z;
  const wrappedX = ((x % n) + n) % n;
  return `https://tile.openstreetmap.org/${z}/${wrappedX}/${y}.png`;
}

export function osmLink(lat: number, lon: number, zoom = 17): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;
}

const EARTH_RADIUS_M = 6371008.8;

/** Great circle distance in metres, the same formula the pipeline uses. */
export function haversineMetres(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Duval County bounding box, used to sanity check coordinates. */
export const DUVAL_BBOX = {
  minLat: 30.1,
  maxLat: 30.6,
  minLon: -82.1,
  maxLon: -81.3,
} as const;

export function isPlausibleDuvalPoint(lat: number | null, lon: number | null): boolean {
  if (lat === null || lon === null) return false;
  return (
    lat >= DUVAL_BBOX.minLat &&
    lat <= DUVAL_BBOX.maxLat &&
    lon >= DUVAL_BBOX.minLon &&
    lon <= DUVAL_BBOX.maxLon
  );
}
