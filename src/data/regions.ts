/**
 * EarthContours — Predefined Terrain Regions
 *
 * Philosophy
 * ----------
 * Regions are hand-tuned geographic chunks sized for visual quality in the
 * EXPLORE screen, NOT based on political borders.  Rules of thumb:
 *
 *   • Target ~150–300 km per side.  Small enough that the ENU flat-earth
 *     approximation has < 0.2 % error; large enough to show a whole range.
 *   • Regions MAY overlap — a peak near a border appears in both chunks.
 *   • Each region has a stable `id` used as the IndexedDB cache key.
 *     Never rename an id once shipped — add a new entry instead.
 *
 * Coordinate system (EXPLORE screen)
 * ------------------------------------
 * Every world coordinate in EXPLORE is in a local ENU (East-North-Up) frame
 * centred on the region's geographic centre (lat0, lon0):
 *
 *   lat0 = (bounds.north + bounds.south) / 2
 *   lon0 = (bounds.east  + bounds.west ) / 2
 *
 *   MPD_LAT = 111 132 m/°            (nearly constant pole-to-pole)
 *   MPD_LON = 111 320 × cos(lat0°)   (shrinks toward poles)
 *
 *   x_m = (lng − lon0) × MPD_LON     east / west in metres
 *   z_m = (lat − lat0) × MPD_LAT     north / south in metres
 *   y_m = elevation_m × verticalExaggeration   ← ONLY thing that modifies Y
 *
 * Flat-earth error by region size:
 *   50 km  → < 1 m error   (negligible)
 *   150 km → < 10 m error  (fine)
 *   300 km → < 50 m error  (acceptable for visualisation)
 *   600 km → < 200 m error (starts to be noticeable at 1× exaggeration)
 *
 * Adding regions
 * --------------
 * 1. Pick bounds roughly square, ≤ 300 km/side for best accuracy.
 * 2. Add an entry to REGIONS below with a unique snake-case id.
 * 3. Update DEFAULT_REGION_ID in constants.ts if you want it as the default.
 * 4. No code changes required elsewhere — the loader uses region.bounds.
 *
 * IndexedDB tile cache is keyed by tile z/x/y, so overlapping regions
 * automatically share any previously-cached tiles.
 */

import type { Region } from '../core/types'

// ─── Region Definitions ───────────────────────────────────────────────────────

export const REGIONS: Region[] = [
  /**
   * Central Colorado Rockies — highest concentration of 14ers in the US.
   * Mount Elbert (4399 m), Mount Massive (4396 m), La Plata Peak (4372 m).
   * ~220 km wide × ~250 km tall.  Elevation range ≈ 1800–4400 m.
   *
   * Verification: Mount Elbert at 39.118°N, 106.445°W should render at
   * ~4400 m (14 440 ft).  Use console filter "ELEVATION LOAD" to check.
   */
  {
    id: 'colorado-rockies',
    name: 'Colorado Rockies',
    description: 'Home of 53 fourteeners — peaks above 14 000 ft. ' +
      'Mount Elbert, Mount Massive, Pikes Peak, and the Continental Divide.',
    center: { lat: 39.1, lng: -106.4 },
    bounds: {
      north: 40.3,
      south: 38.0,
      east:  -104.9,
      west:  -107.9,
    },
  },

  /**
   * Alaska Range — Denali and surrounding summits.
   * Denali (6190 m) is the highest peak in North America.
   * ~255 km wide × ~220 km tall at lat 63°N (MPD_LON ≈ 50 500 m/°).
   * Elevation range ≈ 300–6190 m.
   */
  {
    id: 'alaska-range',
    name: 'Alaska Range — Denali',
    description: 'Denali (6 190 m / 20 310 ft), the highest peak in ' +
      'North America.  Alaska Range and Kichatna Spires.',
    center: { lat: 63.0, lng: -151.0 },
    bounds: {
      north: 64.1,
      south: 62.0,
      east:  -148.5,
      west:  -153.5,
    },
  },

]

// ─── Lookup Helpers ───────────────────────────────────────────────────────────

/** O(1) region lookup by id. */
export const REGION_MAP: Record<string, Region> =
  Object.fromEntries(REGIONS.map((r) => [r.id, r]))
