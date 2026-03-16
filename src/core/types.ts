/**
 * EarthContours — Core Type Definitions
 *
 * All TypeScript interfaces and types used throughout the app live here.
 * Centralized types mean one source of truth — if a type changes, you
 * update it once and TypeScript flags every place that's now wrong.
 *
 * Convention: Interfaces for objects, type aliases for unions/literals.
 */

// ─── Screen Navigation ───────────────────────────────────────────────────────

/** The four main screens of the app */
export type ScreenId = 'scan' | 'explore' | 'map' | 'settings'

/** Transition states used for the zoom animation between screens */
export type TransitionState = 'idle' | 'exit' | 'black' | 'enter'

// ─── Units & Formatting ───────────────────────────────────────────────────────

/** Imperial uses feet/miles, metric uses meters/km */
export type UnitSystem = 'imperial' | 'metric'

/** How GPS coordinates are displayed to the user */
export type CoordFormat = 'decimal' | 'dms' | 'utm'

/** Color theme options (ocean is the primary, others future) */
export type ColorTheme = 'ocean' | 'forest' | 'desert' | 'arctic'

/** Font size for peak/river/location labels */
export type LabelSize = 'small' | 'medium' | 'large'

/** Target frame rate for the 3D renderer */
export type TargetFPS = 'auto' | 60 | 30

/** Battery/performance mode */
export type BatteryMode = 'auto' | 'on' | 'off'

/** GPS accuracy setting */
export type GPSAccuracy = 'high' | 'medium' | 'low'

/** Data resolution for terrain tiles */
export type DataResolution = '10m' | '30m' | '90m'

/**
 * Vertical exaggeration multiplier for terrain display.
 * 1× = physically correct metres (terrain looks flat for large regions — that is real).
 * Higher values stretch Y so mountains appear taller than they really are.
 * Only verticalExaggeration ever modifies the Y (elevation) axis — nothing else.
 */
export type VerticalExaggeration = 1 | 2 | 4 | 10 | 20

// ─── Location ─────────────────────────────────────────────────────────────────

/** Geographic coordinates */
export interface LatLng {
  lat: number  // Latitude in decimal degrees (-90 to 90)
  lng: number  // Longitude in decimal degrees (-180 to 180)
}

/** Location mode — either using real GPS or an explore location set on the map */
export type LocationMode = 'gps' | 'exploring'

/** GPS permission state from the browser Geolocation API */
export type GPSPermission = 'unknown' | 'granted' | 'denied' | 'unavailable'

// ─── Terrain Data ─────────────────────────────────────────────────────────────

/** A named peak/summit */
export interface Peak {
  id: string
  name: string
  lat: number
  lng: number
  elevation_m: number   // Always stored in meters internally
  isHighPoint?: boolean // Is this the highest point in the dataset?
}

/** A river or stream */
export interface River {
  id: string
  name: string
  points: LatLng[]      // Path of the river
  isStream?: boolean    // true for waterway=stream (smaller waterways)
  scalerank?: number    // Natural Earth importance rank (0 = most important)
}

/** A lake, reservoir, or water body polygon */
export interface WaterBody {
  id: string
  name: string
  type: 'lake' | 'reservoir' | 'pond' | 'water' | 'alkaline'
  center: LatLng
  polygon: LatLng[]
  innerRings?: LatLng[][]  // Island/hole polygons for multipolygon relations
  scalerank?: number       // Natural Earth importance rank (0 = most important)
}

/** Glacier classification based on Natural Earth scalerank */
export type GlacierType = 'ice_sheet' | 'ice_cap' | 'glacier'

/** A glaciated area polygon from Natural Earth */
export interface Glacier {
  id: string
  name: string
  type: GlacierType
  center: LatLng
  polygon: LatLng[]
  innerRings?: LatLng[][]  // Nunatak/hole polygons
  scalerank: number        // Natural Earth importance rank (0 = most important)
}

/** A coastline segment from Natural Earth */
export interface Coastline {
  id: string
  points: LatLng[]
  scalerank: number
}

/** A terrain region (Colorado Rockies, Anchorage, etc.) */
export interface Region {
  id: string
  name: string
  center: LatLng
  bounds: {
    north: number
    south: number
    east: number
    west: number
  }
  description: string
}

/**
 * Raw terrain mesh data.
 * For the MVP this is generated procedurally — in Session 2, it
 * will come from Copernicus GLO-10 elevation tiles.
 */
export interface TerrainMeshData {
  /** Width of the grid in samples */
  width: number
  /** Height of the grid in samples */
  height: number
  /** Flat array of elevation values in meters, row by row */
  elevations: Float32Array
  /** Min elevation in the dataset (meters) */
  minElevation_m: number
  /** Max elevation in the dataset (meters) */
  maxElevation_m: number
  /** Real-world width in kilometers */
  worldWidth_km: number
  /** Real-world depth in kilometers */
  worldDepth_km: number
  /**
   * Geographic bounds of this mesh — required for the ray-height-field
   * renderer to convert lat/lng to grid coordinates.
   * Added for real elevation support; simulated terrain fills this from
   * the region definition.
   */
  bounds: {
    north: number
    south: number
    east: number
    west: number
  }
}

/** Loading state for async data operations */
export type LoadingState = 'idle' | 'loading' | 'success' | 'error'

// ─── Camera / Viewport ────────────────────────────────────────────────────────

/**
 * SCAN screen camera — first-person perspective.
 * Imagine standing on a hillside looking at mountains.
 */
export interface ARCameraState {
  heading_deg: number   // Which direction you're facing (0=N, 90=E, 180=S, 270=W)
  pitch_deg: number     // Up/down tilt (-90=straight down, 0=horizon, 90=straight up)
  height_m: number      // Your eye height above the ground in meters
  fov: number           // Field of view in degrees (typically 60-90)
}

/**
 * EXPLORE screen camera — orbiting a 3D scene.
 * Imagine circling around a terrain model on a table.
 */
export interface OrbitCameraState {
  theta: number         // Horizontal rotation angle in radians (0 to 2π)
  phi: number           // Vertical angle in radians (0=top, π/2=side)
  radius: number        // Distance from the center of the terrain
}

// ─── Sensor Data ──────────────────────────────────────────────────────────────

/**
 * Device sensor readings.
 * In Session 3 these will come from real device sensors via
 * DeviceOrientationEvent and DeviceMotionEvent APIs.
 */
export interface SensorData {
  compassHeading?: number   // True heading from magnetometer (degrees)
  deviceTilt?: number       // Device pitch from accelerometer (degrees)
  accuracy?: number         // Compass accuracy in degrees
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/** All persisted user settings — stored in localStorage via Zustand persist */
export interface AppSettings {
  // Units & Measurements
  units: UnitSystem
  coordFormat: CoordFormat

  // Map & Terrain Display
  showPeakLabels: boolean
  showRivers: boolean
  showLakes: boolean
  showGlaciers: boolean
  showCoastlines: boolean
  showTownLabels: boolean
  showContourLines: boolean
  showBandLines: boolean
  showFill: boolean
  solidTerrain: boolean
  contourAnimation: boolean
  verticalExaggeration: VerticalExaggeration

  // Appearance
  colorTheme: ColorTheme
  labelSize: LabelSize
  reduceMotion: boolean

  // Location & Sensors
  locationAccuracy: GPSAccuracy
  autoDetectRegion: boolean

  // Performance & Battery
  batteryMode: BatteryMode
  targetFPS: TargetFPS

  // Debug & Developer
  showDebugPanel: boolean

  // Data & Downloads
  downloadOnWifiOnly: boolean
  dataResolution: DataResolution
  defaultRegionId: string
}

// ─── Error Types ──────────────────────────────────────────────────────────────

/** Structured error information for display */
export interface AppError {
  code: string
  message: string
  details?: string
  recoverable: boolean
  timestamp: number
}

// ─── Event Types ──────────────────────────────────────────────────────────────

/** Touch/mouse drag event data */
export interface DragState {
  isDragging: boolean
  startX: number
  startY: number
  lastX: number
  lastY: number
}

/** Map tile coordinates */
export interface TileCoord {
  z: number   // Zoom level
  x: number   // Tile X (column)
  y: number   // Tile Y (row)
}

/** A contour line (for EXPLORE screen rendering) */
export interface ContourLine {
  elevation_m: number
  points: Array<{ x: number; y: number; z: number }>  // 3D world space points
}

// ─── SCAN — Depth Band Configuration ──────────────────────────────────────────

/**
 * Distance thresholds for depth bands.  Bands are drawn far→near (painter's order).
 * Each band stores per-azimuth raw elevation + distance so the main thread can
 * re-project angles when AGL changes without a worker round-trip.
 *
 * Overlaps are scaled by distance (0.5 km close, 1 km mid, 2 km far) to prevent
 * seams at boundaries where a ridge straddles the cutoff.  Painter's order
 * (far drawn first, near on top) handles the visual overlap.
 */
export interface DepthBandConfig {
  /** Unique label for debugging */
  label:  string
  /** Minimum distance (metres, inclusive) */
  minDist: number
  /** Maximum distance (metres, inclusive) */
  maxDist: number
  /** Azimuth resolution for this band (steps per degree). If omitted, uses the global resolution. */
  resolution?: number
}

/** 6-band configuration: ultra-near through far, with scaled overlaps.
 *  Bands 0–2 are high-res (8 steps/°, 2880 azimuths).
 *  Bands 3–5 are standard-res (4 steps/°, 1440 azimuths). */
export const DEPTH_BANDS: DepthBandConfig[] = [
  { label: 'ultra-near', minDist: 0,       maxDist: 4_500,   resolution: 8 },  // 0–4.5 km   (0.125°, 2880 az) — 0.5 km overlap into near
  { label: 'near',       minDist: 4_000,   maxDist: 10_500,  resolution: 8 },  // 4–10.5 km  (0.125°, 2880 az) — 0.5 km overlap into mid-near
  { label: 'mid-near',   minDist: 10_000,  maxDist: 31_000,  resolution: 8 },  // 10–31 km   (0.125°, 2880 az) — 1 km overlap into mid
  { label: 'mid',        minDist: 30_000,  maxDist: 81_000  },                  // 30–81 km   (0.25°, 1440 az)  — 1 km overlap into med-far
  { label: 'mid-far',    minDist: 80_000,  maxDist: 152_000 },                  // 80–152 km  (0.25°, 1440 az)  — 2 km overlap into far
  { label: 'far',        minDist: 150_000, maxDist: 400_000 },                  // 150–400 km (0.25°, 1440 az)
]

/**
 * Per-azimuth data for a single depth band.
 * Stores raw world data (elevation + distance) so angles can be re-projected
 * on the main thread when viewer elevation (AGL) changes.
 */
export interface SkylineBand {
  /** Raw ground elevation (metres) at the ridgeline point for each azimuth.
   *  -Infinity sentinel means no ridge in this band at this azimuth. */
  elevations: Float32Array
  /** Distance to the ridgeline point (metres) */
  distances:  Float32Array
  /** GPS latitude of the ridgeline point for each azimuth (for peak matching) */
  ridgeLats:  Float32Array
  /** GPS longitude of the ridgeline point for each azimuth (for peak matching) */
  ridgeLngs:  Float32Array
  /** Contour crossings: packed [elevation, distance, lat, lng, direction] per crossing.
   *  direction: +1.0 = terrain rises outward (up-crossing), -1.0 = falls (down-crossing).
   *  All azimuths concatenated — use crossingOffsets to index. */
  crossingData:    Float32Array
  /** Per-azimuth offset into crossingData (length = numAzimuths + 1).
   *  Azimuth ai's crossings are at indices crossingOffsets[ai]..crossingOffsets[ai+1].
   *  Each crossing occupies 5 floats: [elevation_m, distance_m, lat, lng, direction]. */
  crossingOffsets: Uint32Array
  /** Azimuth resolution for this band (steps per degree). Defaults to SkylineData.resolution. */
  resolution: number
  /** Number of azimuth samples in this band's arrays = 360 × resolution */
  numAzimuths: number
}

// ─── SCAN — Refined Arc (Dense Peak Ridgeline Data) ─────────────────────────

/**
 * A refined arc is a dense ray-march around a visible peak, using higher-zoom
 * tiles than the standard skyline pass.  Where standard band data uses
 * 0.125°–0.25° azimuth spacing, refined arcs use ~0.05° steps, giving
 * ~5× higher angular resolution around peaks.
 *
 * Each arc stores raw world data (elevation + distance + GPS) per sample
 * so angles can be re-projected when AGL changes — same pattern as bands.
 *
 * Computed via two-pass protocol: main thread sends visible peak positions
 * to the worker ('refine-peaks'), worker fetches higher-zoom tiles and does
 * dense ray-march, sends back 'refined-arcs' response.
 */
export interface RefinedArc {
  /** Center bearing of this arc (degrees, 0=N, 90=E) */
  centerBearing: number
  /** Angular half-width of this arc (degrees) */
  halfWidth: number
  /** Number of azimuth samples across the full arc width */
  numSamples: number
  /** Azimuth step size (degrees per sample) — typically ~0.05° */
  stepDeg: number
  /** Per-sample raw ground elevation (metres). -Infinity = no ridge at this sample. */
  elevations: Float32Array
  /** Per-sample distance to ridge point (metres) */
  distances: Float32Array
  /** Per-sample GPS latitude of the ridge point */
  ridgeLats: Float32Array
  /** Per-sample GPS longitude of the ridge point */
  ridgeLngs: Float32Array
  /** Depth band index this arc's feature was detected in */
  bandIndex: number
  /** Distance from viewer to the feature (metres) */
  featureDist: number
  /** Elevation of the feature's ridgeline peak (metres) */
  featureElev: number
  /** Bearing of the detected ridgeline peak (degrees) — may differ slightly from centerBearing */
  featureBearing: number
}

/**
 * A peak to refine — sent from main thread to worker in 'refine-peaks' message.
 * Main thread determines visible peaks + their bearing/distance/band,
 * worker fetches higher-zoom tiles and does dense ray-march around each.
 */
export interface PeakRefineItem {
  /** Peak bearing from viewer (degrees, 0=N, 90=E) */
  bearing: number
  /** Distance from viewer to peak (metres) */
  distance: number
  /** Which depth band this peak was matched to */
  bandIndex: number
  /** Peak name (for debug logging) */
  name: string
}

// ─── SCAN — Skyline Precomputation ────────────────────────────────────────────

/**
 * Pre-computed 360° terrain skyline for the SCAN screen.
 * Produced by `skylineWorker.ts` — the worker sends this via postMessage
 * (with transferable ArrayBuffers) once per viewpoint change.
 *
 * v2 adds depth bands: per-band raw elevation/distance data for layered rendering
 * and AGL re-projection without worker round-trip.
 *
 * Indexing:
 *   aziIdx = Math.round(((bearingDeg % 360 + 360) % 360) * resolution) % numAzimuths
 */
export interface SkylineData {
  /** Maximum elevation angle (radians) at each azimuth — the overall ridgeline silhouette */
  angles:      Float32Array
  /** Distance to ridgeline in metres */
  distances:   Float32Array
  /** NW-45° hill shade at ridgeline [0–1] */
  shading:     Float32Array
  /** Per-depth-band raw world data (near/mid/far). Array index matches DEPTH_BANDS. */
  bands:       SkylineBand[]
  /** Refined arcs — dense ray-march data around detected ridgeline features.
   *  Used for high-resolution peak ridgeline rendering. Empty if no features detected. */
  refinedArcs: RefinedArc[]
  /** Steps per degree — 2 means 0.5°/step (720 azimuths) */
  resolution:  number
  /** Total azimuth steps = 360 × resolution */
  numAzimuths: number
  computedAt:  { lat: number; lng: number; elev: number; groundElev: number; timestamp: number }
}

/**
 * Message sent from the main thread to the skyline worker to start computation.
 * `meshElevations` is a copied Float32Array so both threads own independent data.
 */
export interface SkylineRequest {
  viewerLat:      number
  viewerLng:      number
  /** Eye height above ground in metres (AGL). Worker resolves ground elevation from tiles. */
  viewerHeightM:  number
  resolution:     number
  maxRange:       number
}
