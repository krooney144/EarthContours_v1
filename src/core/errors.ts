/**
 * EarthContours — Custom Error Classes
 *
 * WHY custom errors instead of plain Error objects?
 * 1. Typed: you can use instanceof to check exactly what went wrong
 * 2. Structured: each error carries relevant context (e.g., which region failed to load)
 * 3. Recoverable flag: UI can decide whether to show "retry" or "fatal error"
 * 4. Code field: easier to log and filter in analytics
 *
 * Error handling philosophy:
 * - GPS failure is NON-FATAL — app continues with simulated position
 * - Terrain load failure is RECOVERABLE — show retry button
 * - React crashes are ISOLATED — Error Boundaries catch per-screen
 */

import { createLogger } from './logger'

const log = createLogger('CORE:ERRORS')

// ─── Base Error Class ─────────────────────────────────────────────────────────

/**
 * Base class for all EarthContours errors.
 * Adds a code (string identifier) and recoverable flag.
 */
export class EarthContoursError extends Error {
  /** Machine-readable error code for logging/analytics */
  readonly code: string
  /** If true, the UI should offer a retry option rather than a fatal screen */
  readonly recoverable: boolean
  /** Additional context data to help debugging */
  readonly context?: unknown

  constructor(
    message: string,
    code: string,
    recoverable: boolean,
    context?: unknown,
  ) {
    // Call the parent Error constructor with the message
    super(message)
    // Ensure instanceof checks work correctly in TypeScript with extends Error
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = new.target.name
    this.code = code
    this.recoverable = recoverable
    this.context = context

    // Log all errors when they're created — extreme logging requirement
    if (recoverable) {
      log.warn(`[${code}] ${message}`, context)
    } else {
      log.error(`[${code}] ${message}`, context)
    }
  }
}

// ─── GPS / Location Errors ────────────────────────────────────────────────────

/**
 * Thrown when GPS/geolocation fails.
 * ALWAYS recoverable — app falls back to simulated position.
 */
export class GPSError extends EarthContoursError {
  constructor(message: string, context?: unknown) {
    super(message, 'GPS_ERROR', true, context)
  }
}

/** Thrown when location permission is denied */
export class LocationPermissionError extends EarthContoursError {
  constructor() {
    super(
      'Location permission was denied by the user',
      'GPS_PERMISSION_DENIED',
      true,  // Recoverable — use simulated position
    )
  }
}

// ─── Terrain / Data Errors ────────────────────────────────────────────────────

/**
 * Thrown when terrain data fails to load.
 * Recoverable — show retry button.
 */
export class TerrainLoadError extends EarthContoursError {
  constructor(regionId: string, cause?: unknown) {
    super(
      `Failed to load terrain data for region: ${regionId}`,
      'TERRAIN_LOAD_ERROR',
      true,  // Recoverable — user can retry
      { regionId, cause },
    )
  }
}

/** Thrown when terrain data is malformed/corrupt */
export class TerrainDataError extends EarthContoursError {
  constructor(message: string, context?: unknown) {
    super(message, 'TERRAIN_DATA_ERROR', false, context)  // Not recoverable — bad data
  }
}

// ─── Renderer Errors ──────────────────────────────────────────────────────────

/**
 * Thrown when Three.js renderer fails to initialize.
 * Could happen on very old hardware with no WebGL support.
 */
export class RendererError extends EarthContoursError {
  constructor(message: string, context?: unknown) {
    super(message, 'RENDERER_ERROR', false, context)
  }
}

/** Thrown when a shader fails to compile */
export class ShaderError extends EarthContoursError {
  constructor(shaderName: string, log_output: string) {
    super(
      `Shader compilation failed: ${shaderName}`,
      'SHADER_ERROR',
      false,
      { shaderName, log_output },
    )
  }
}

// ─── Map Errors ───────────────────────────────────────────────────────────────

/** Thrown when a map tile fails to load (e.g., network error) */
export class TileLoadError extends EarthContoursError {
  constructor(tileUrl: string, cause?: unknown) {
    super(
      `Failed to load map tile: ${tileUrl}`,
      'TILE_LOAD_ERROR',
      true,  // Recoverable — retry the tile
      { tileUrl, cause },
    )
  }
}

// ─── Settings Errors ──────────────────────────────────────────────────────────

/** Thrown when localStorage is unavailable (e.g., private browsing mode) */
export class StorageError extends EarthContoursError {
  constructor(cause?: unknown) {
    super(
      'localStorage is unavailable — settings will not persist',
      'STORAGE_ERROR',
      true,  // Recoverable — use defaults in memory
      { cause },
    )
  }
}

// ─── Error Utilities ──────────────────────────────────────────────────────────

/**
 * Convert any unknown error to a structured EarthContoursError.
 * Useful in catch blocks where the error type is unknown.
 *
 * @example
 * try { ... }
 * catch (err) {
 *   const appError = normalizeError(err)
 *   log.error('Something failed', appError)
 * }
 */
export function normalizeError(err: unknown): EarthContoursError {
  if (err instanceof EarthContoursError) return err

  if (err instanceof Error) {
    return new EarthContoursError(err.message, 'UNKNOWN_ERROR', true, {
      name: err.name,
      stack: err.stack,
    })
  }

  return new EarthContoursError(
    String(err),
    'UNKNOWN_ERROR',
    true,
    { originalError: err },
  )
}

/**
 * Check if a GeolocationPositionError is a permission denial.
 * The GeolocationPositionError.PERMISSION_DENIED code is 1.
 */
export function isPermissionDenied(err: GeolocationPositionError): boolean {
  return err.code === 1
}
