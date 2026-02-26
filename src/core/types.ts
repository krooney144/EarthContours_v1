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
}

/** A lake, reservoir, or water body */
export interface WaterBody {
  id: string
  name: string
  center: LatLng
  area_km2?: number
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
  showRiverLabels: boolean
  showWaterLabels: boolean
  showTownLabels: boolean
  showContourLines: boolean
  contourAnimation: boolean
  verticalExaggeration: VerticalExaggeration

  // Appearance
  appName: 'Earth Contours' | 'EarthContours' | 'Earthscape'
  colorTheme: ColorTheme
  labelSize: LabelSize
  reduceMotion: boolean

  // Location & Sensors
  locationAccuracy: GPSAccuracy
  autoDetectRegion: boolean

  // Performance & Battery
  batteryMode: BatteryMode
  targetFPS: TargetFPS

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

// ─── SCAN Phase 2 — Skyline Precomputation ────────────────────────────────────

/**
 * Pre-computed 360° terrain skyline for the SCAN screen.
 * Produced by `skylineWorker.ts` — the worker sends this via postMessage
 * (with transferable ArrayBuffers) once per viewpoint change.
 *
 * Indexing:
 *   aziIdx = Math.round(((bearingDeg % 360 + 360) % 360) * resolution) % numAzimuths
 */
export interface SkylineData {
  /** Maximum elevation angle (radians) at each azimuth — the ridgeline silhouette */
  angles:      Float32Array
  /** Near-field max elevation angle — terrain 0–10 km */
  anglesNear:  Float32Array
  /** Mid-field max elevation angle — terrain 10–50 km */
  anglesMid:   Float32Array
  /** Far-field max elevation angle — terrain 50–250 km */
  anglesFar:   Float32Array
  /** Distance to ridgeline in metres */
  distances:   Float32Array
  /** NW-45° hill shade at ridgeline [0–1] */
  shading:     Float32Array
  /** Steps per degree — 2 means 0.5°/step (720 azimuths) */
  resolution:  number
  /** Total azimuth steps = 360 × resolution */
  numAzimuths: number
  computedAt:  { lat: number; lng: number; elev: number; timestamp: number }
}

/**
 * Message sent from the main thread to the skyline worker to start computation.
 * `meshElevations` is a copied Float32Array so both threads own independent data.
 */
export interface SkylineRequest {
  viewerLat:      number
  viewerLng:      number
  viewerElev:     number
  meshElevations: Float32Array
  meshWidth:      number
  meshHeight:     number
  meshBounds:     { north: number; south: number; east: number; west: number }
  resolution:     number
  maxRange:       number
}
