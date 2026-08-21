"use client";

import { isPlausibleDuvalPoint, latLonToTile, osmLink, tileUrl, TILE_SIZE } from "@/lib/geo";

/**
 * A 3x3 grid of OpenStreetMap raster tiles with a marker at the parcel centroid.
 *
 * No mapping library and no tile server of our own: the tile URLs are computed
 * from the same slippy map arithmetic Leaflet would use. That keeps the page
 * light and keeps the zero standing cost claim intact.
 */
export function MapThumb({
  latitude,
  longitude,
  zoom = 16,
  size = 300,
}: {
  latitude: number | null;
  longitude: number | null;
  zoom?: number;
  size?: number;
}) {
  if (latitude === null || longitude === null) {
    return (
      <div className="card flex h-[220px] items-center justify-center text-[12.5px] text-faint">
        No coordinates published for this parcel.
      </div>
    );
  }

  const centre = latLonToTile(latitude, longitude, zoom);
  const grid = 3;
  const canvas = TILE_SIZE * grid;
  // Where the point sits inside the 3x3 canvas.
  const markerX = TILE_SIZE + centre.offsetX;
  const markerY = TILE_SIZE + centre.offsetY;
  const scale = size / canvas;
  const plausible = isPlausibleDuvalPoint(latitude, longitude);

  const tiles = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      tiles.push({ dx, dy, x: centre.x + dx, y: centre.y + dy });
    }
  }

  return (
    <div>
      <div
        className="relative overflow-hidden rounded-md border border-border bg-sunken"
        style={{ width: size, height: size }}
      >
        <div
          style={{
            width: canvas,
            height: canvas,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            position: "absolute",
            left: 0,
            top: 0,
          }}
        >
          {tiles.map((tile) => (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              key={`${tile.dx}:${tile.dy}`}
              src={tileUrl(tile.x, tile.y, zoom)}
              alt=""
              width={TILE_SIZE}
              height={TILE_SIZE}
              loading="lazy"
              style={{
                position: "absolute",
                left: (tile.dx + 1) * TILE_SIZE,
                top: (tile.dy + 1) * TILE_SIZE,
              }}
            />
          ))}
          <div
            style={{
              position: "absolute",
              left: markerX - 9,
              top: markerY - 18,
              width: 18,
              height: 18,
            }}
          >
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
              <path
                d="M9 17 C 9 17 15.5 10.5 15.5 6.6 A 6.5 6.5 0 1 0 2.5 6.6 C 2.5 10.5 9 17 9 17 Z"
                fill="#97231f"
                stroke="#ffffff"
                strokeWidth="1.4"
              />
              <circle cx="9" cy="6.6" r="2.1" fill="#ffffff" />
            </svg>
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-faint">
        <span className="mono">
          {latitude.toFixed(6)}, {longitude.toFixed(6)}
        </span>
        <a href={osmLink(latitude, longitude)} target="_blank" rel="noreferrer">
          open in OpenStreetMap
        </a>
        <span>tiles (c) OpenStreetMap contributors</span>
      </div>

      {!plausible ? (
        <p className="mt-1 text-[11.5px] text-warn">
          These coordinates fall outside the Duval County bounding box. Treat the location as
          unverified.
        </p>
      ) : null}
    </div>
  );
}
