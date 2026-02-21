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

/** Maximum eye height in meters (2000ft ≈ 610m) */
export const MAX_HEIGHT_M = 609.6

/** Minimum eye height in meters (10ft ≈ 3m) */
export const MIN_HEIGHT_M = 3.048

/** Default field of view in degrees */
export const DEFAULT_FOV = 70

/** Starting heading (degrees) — due North */
export const DEFAULT_HEADING = 0

/** Starting pitch (degrees) — looking at horizon */
export const DEFAULT_PITCH = 0

/** Default orbit camera distance from center */
export const DEFAULT_ORBIT_RADIUS = 5

// ─── Map Defaults ─────────────────────────────────────────────────────────────

/** Default map center — Colorado Rockies */
export const DEFAULT_MAP_CENTER = { lat: 39.7, lng: -105.5 }

/** Default map zoom level */
export const DEFAULT_MAP_ZOOM = 9

/** OpenTopoMap tile URL template — {a|b|c} are subdomains for parallel tile loading */
export const TOPO_TILE_URL = 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'

/** OpenTopoMap subdomain servers (rotate between them to parallelize tile loading) */
export const TOPO_TILE_SUBDOMAINS = ['a', 'b', 'c'] as const

/** Map tile size in pixels */
export const TILE_SIZE = 256

/** Min and max zoom levels for the map */
export const MAP_MIN_ZOOM = 4
export const MAP_MAX_ZOOM = 16

// ─── Terrain ──────────────────────────────────────────────────────────────────

/** Default vertical exaggeration */
export const DEFAULT_VERTICAL_EXAGGERATION = 1.5

/** Grid resolution for simulated terrain (samples per axis) */
export const TERRAIN_GRID_SIZE = 128

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
