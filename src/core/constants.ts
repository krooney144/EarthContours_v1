/**
 * EarthContours — App Constants
 *
 * Magic numbers collected here instead of scattered through the codebase.
 * If you need to change a value (like the splash duration), change it once here
 * and every place that uses SPLASH_DURATION_MS updates automatically.
 */

// ─── Timing ───────────────────────────────────────────────────────────────────

/** How long the splash screen shows before entering the app (ms) */
export const SPLASH_DURATION_MS = 2400

/**
 * Screen transition timing (ms).
 * The transition is: 300ms exit → 100ms black → 300ms enter = 700ms total
 */
export const TRANSITION_EXIT_MS = 300
export const TRANSITION_BLACK_MS = 100
export const TRANSITION_ENTER_MS = 300
export const TRANSITION_TOTAL_MS = TRANSITION_EXIT_MS + TRANSITION_BLACK_MS + TRANSITION_ENTER_MS

/** Auto-rotate starts after this many ms of inactivity on EXPLORE screen */
export const AUTO_ROTATE_DELAY_MS = 3000

/** Auto-rotate speed in radians per second */
export const AUTO_ROTATE_SPEED = 0.003

// ─── Layout ───────────────────────────────────────────────────────────────────

/** Window width (px) above which desktop preview mode is shown */
export const PREVIEW_BREAKPOINT_PX = 900

// ─── Camera Defaults ─────────────────────────────────────────────────────────

/** Default eye height above ground in meters (300ft ≈ 91m) */
export const DEFAULT_HEIGHT_M = 91.44

/** Maximum eye height in meters (10000ft ≈ 3048m) */
export const MAX_HEIGHT_M = 3048

/** Minimum eye height in meters (10ft ≈ 3m) */
export const MIN_HEIGHT_M = 3.048

/** Default field of view in degrees */
export const DEFAULT_FOV = 70

/** Starting heading (degrees) — due North */
export const DEFAULT_HEADING = 0

/** Starting pitch (degrees) — looking at horizon */
export const DEFAULT_PITCH = 0

/**
 * ENU (East-North-Up) projection constants.
 * These convert decimal-degree lat/lng offsets to metres.
 * lat0 is always the centre of the loaded region.
 *
 *   x_m = (lng - lng0) * ENU_M_PER_DEG_LON(lat0)
 *   z_m = (lat - lat0) * ENU_M_PER_DEG_LAT
 *   y_m = elevation_m * verticalExaggeration   ← only scaling that touches Y
 */
export const ENU_M_PER_DEG_LAT = 111_132          // metres per degree latitude (nearly constant)
export const ENU_M_PER_DEG_LON_AT_LAT = (lat0Deg: number): number =>
  111_320 * Math.cos(lat0Deg * Math.PI / 180)     // shrinks toward poles

/**
 * Orbit camera zoom limits in metres.
 * MIN = ~500 m above terrain (close-up of a single peak).
 * MAX = 2 000 km (enough to see any single-region chunk from orbit).
 */
export const ORBIT_RADIUS_MIN_M = 500
export const ORBIT_RADIUS_MAX_M = 2_000_000

/**
 * Default orbit radius is set dynamically from terrain bounds via
 * cameraStore.initOrbitCamera(terrainWidth_m).  This fallback is only used
 * before the first terrain loads (e.g. on first render).
 */
export const ORBIT_RADIUS_FALLBACK_M = 80_000

// ─── Map Defaults ─────────────────────────────────────────────────────────────

/** Default map center — Colorado Rockies */
export const DEFAULT_MAP_CENTER = { lat: 39.7, lng: -105.5 }

/** Default map zoom level */
export const DEFAULT_MAP_ZOOM = 9

/** Tile subdomains for Carto — rotate through a/b/c/d for parallel requests */
export const MAP_TILE_SUBDOMAINS = ['a', 'b', 'c', 'd'] as const

/**
 * Carto dark_only_labels — transparent tiles, white place/road labels only.
 * Drawn on top of the DEM overlay to show towns, cities, roads.
 * Free, no API key. {r} = '@2x' retina suffix.
 */
export const MAP_LABEL_TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png'

export const MAP_ATTRIBUTION = '© Mapzen / AWS Terrain Tiles · © OpenStreetMap · © CARTO'

// Legacy aliases kept so nothing else breaks
export const MAP_TILE_URL = MAP_LABEL_TILE_URL
export const TOPO_TILE_URL = MAP_LABEL_TILE_URL
export const TOPO_TILE_SUBDOMAINS = MAP_TILE_SUBDOMAINS

/** Map tile size in pixels */
export const TILE_SIZE = 256

/** Min and max zoom levels for the map */
export const MAP_MIN_ZOOM = 1
export const MAP_MAX_ZOOM = 16

// ─── Terrain ──────────────────────────────────────────────────────────────────

/** Default vertical exaggeration */
export const DEFAULT_VERTICAL_EXAGGERATION = 1.5

/**
 * Grid resolution for terrain elevation (samples per axis).
 * 256 → ~156m/sample over a 40km region — fine enough for 100m contours.
 * (was 128 → ~312m/sample, too coarse for sub-200m contour intervals)
 */
export const TERRAIN_GRID_SIZE = 256

/** World size of the terrain in km */
export const TERRAIN_WORLD_KM = 40

// ─── Default Settings ─────────────────────────────────────────────────────────

/** Default region when app first loads */
export const DEFAULT_REGION_ID = 'colorado-rockies'

// ─── Colors (matches CSS palette) ────────────────────────────────────────────

export const PALETTE = {
  void:  '#000810',
  abyss: '#0E3951',
  deep:  '#124B6B',
  navy:  '#215C79',
  ocean: '#2F6D87',
  mid:   '#4B8EA3',
  reef:  '#68B0BF',
  glow:  '#84D1DB',
  foam:  '#A7DDE5',
  white: '#F0F8FF',
} as const

/** Background color for screens (medium slate blue-grey, NOT pure black) */
export const SCREEN_BG = '#0d1e2e'

// ─── Compass ──────────────────────────────────────────────────────────────────

/** The 16 compass directions in clockwise order */
export const COMPASS_DIRECTIONS = [
  'N', 'NNE', 'NE', 'ENE',
  'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW',
  'W', 'WNW', 'NW', 'NNW',
] as const

/** Pixel spacing between each compass direction in the strip */
export const COMPASS_ITEM_WIDTH = 56
