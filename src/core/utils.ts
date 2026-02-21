/**
 * EarthContours — Utility Functions
 *
 * Pure functions used across the app. "Pure" means: given the same inputs,
 * always returns the same output, with no side effects.
 * These are easy to test and reason about.
 */

import type { UnitSystem, CoordFormat, LatLng, TileCoord } from './types'
import { TILE_SIZE } from './constants'

// ─── Unit Conversion ──────────────────────────────────────────────────────────

/** Convert meters to feet */
export function metersToFeet(m: number): number {
  return m * 3.28084
}

/** Convert feet to meters */
export function feetToMeters(ft: number): number {
  return ft / 3.28084
}

/** Convert meters to miles */
export function metersToMiles(m: number): number {
  return m / 1609.344
}

/** Convert km to miles */
export function kmToMiles(km: number): number {
  return km * 0.621371
}

/**
 * Format an elevation value according to user's unit preference.
 * @param elevation_m - Elevation in meters (always stored as meters internally)
 * @param units - User's unit preference
 * @returns Formatted string like "14,433 ft" or "4,399 m"
 */
export function formatElevation(elevation_m: number, units: UnitSystem): string {
  if (units === 'imperial') {
    const feet = Math.round(metersToFeet(elevation_m))
    return `${feet.toLocaleString()} ft`
  }
  const meters = Math.round(elevation_m)
  return `${meters.toLocaleString()} m`
}

/**
 * Format a distance value according to user's unit preference.
 * @param distance_km - Distance in kilometers
 */
export function formatDistance(distance_km: number, units: UnitSystem): string {
  if (units === 'imperial') {
    const miles = kmToMiles(distance_km)
    if (miles < 0.1) return `${Math.round(miles * 5280)} ft`
    return `${miles.toFixed(1)} mi`
  }
  if (distance_km < 1) return `${Math.round(distance_km * 1000)} m`
  return `${distance_km.toFixed(1)} km`
}

// ─── Coordinate Formatting ────────────────────────────────────────────────────

/**
 * Format a decimal coordinate as Degrees°Minutes'Seconds".
 * @param decimal - Decimal degrees (positive = N or E, negative = S or W)
 * @param isLat - True for latitude (N/S), false for longitude (E/W)
 */
export function decimalToDMS(decimal: number, isLat: boolean): string {
  const abs = Math.abs(decimal)
  const deg = Math.floor(abs)
  const minFloat = (abs - deg) * 60
  const min = Math.floor(minFloat)
  const sec = ((minFloat - min) * 60).toFixed(1)

  const dir = isLat
    ? (decimal >= 0 ? 'N' : 'S')
    : (decimal >= 0 ? 'E' : 'W')

  return `${deg}°${min}'${sec}"${dir}`
}

/**
 * Format coordinates according to the user's preferred format.
 */
export function formatCoordinates(
  lat: number,
  lng: number,
  format: CoordFormat,
): string {
  switch (format) {
    case 'decimal':
      return `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`
    case 'dms':
      return `${decimalToDMS(lat, true)} ${decimalToDMS(lng, false)}`
    case 'utm':
      // UTM conversion is complex — simplified placeholder for MVP
      return `UTM: ${formatUTMPlaceholder(lat, lng)}`
    default:
      return `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`
  }
}

/** Simplified UTM display — full conversion in Session 2 */
function formatUTMPlaceholder(lat: number, lng: number): string {
  // UTM zone calculation: zone = floor((lng + 180) / 6) + 1
  const zone = Math.floor((lng + 180) / 6) + 1
  const band = lat >= 0 ? 'N' : 'S'
  return `${zone}${band} (full UTM in v2)`
}

// ─── Heading & Direction ─────────────────────────────────────────────────────

/**
 * Convert a heading in degrees to a compass direction abbreviation.
 * @param heading - 0 to 360 degrees (0/360 = N, 90 = E, etc.)
 */
export function headingToCompass(heading: number): string {
  const directions = [
    'N', 'NNE', 'NE', 'ENE',
    'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW',
  ]
  // Each direction covers 360/16 = 22.5 degrees
  const index = Math.round(heading / 22.5) % 16
  return directions[index]
}

/**
 * Calculate the bearing FROM one point TO another.
 * Uses the haversine formula for great-circle bearing.
 * @returns Bearing in degrees (0-360, clockwise from North)
 */
export function calculateBearing(from: LatLng, to: LatLng): number {
  const toRad = (deg: number) => deg * (Math.PI / 180)
  const lat1 = toRad(from.lat)
  const lat2 = toRad(to.lat)
  const dLng = toRad(to.lng - from.lng)

  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  const bearingRad = Math.atan2(y, x)
  // Convert to degrees and normalize to 0-360
  return ((bearingRad * 180) / Math.PI + 360) % 360
}

/**
 * Calculate distance between two coordinates using the Haversine formula.
 * @returns Distance in kilometers
 */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const R = 6371 // Earth radius in km
  const toRad = (deg: number) => deg * (Math.PI / 180)
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinDLat = Math.sin(dLat / 2)
  const sinDLng = Math.sin(dLng / 2)
  const a2 = sinDLat * sinDLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng
  return R * 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2))
}

// ─── Map Tile Calculations ────────────────────────────────────────────────────

/**
 * Convert lat/lng/zoom to tile X,Y coordinates.
 * This is the standard Web Mercator tile math used by OpenStreetMap and derivatives.
 * See: https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames
 */
export function latLngToTile(lat: number, lng: number, zoom: number): TileCoord {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom))
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      Math.pow(2, zoom),
  )
  return { z: zoom, x, y }
}

/**
 * Convert tile coordinates back to lat/lng of the tile's top-left corner.
 */
export function tileToLatLng(x: number, y: number, zoom: number): LatLng {
  const n = Math.pow(2, zoom)
  const lng = (x / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  const lat = (latRad * 180) / Math.PI
  return { lat, lng }
}

/**
 * Convert a lat/lng coordinate to pixel position on the map canvas.
 * @param lat - Latitude
 * @param lng - Longitude
 * @param centerLat - Map center latitude
 * @param centerLng - Map center longitude
 * @param zoom - Current zoom level
 * @param canvasWidth - Canvas width in pixels
 * @param canvasHeight - Canvas height in pixels
 * @returns Pixel coordinates {x, y} relative to the canvas top-left
 */
export function latLngToPixel(
  lat: number, lng: number,
  centerLat: number, centerLng: number,
  zoom: number,
  canvasWidth: number, canvasHeight: number,
): { x: number; y: number } {
  const scale = Math.pow(2, zoom)

  // Convert both the center and target to world pixel coordinates
  const worldX = (lng + 180) / 360 * TILE_SIZE * scale
  const latRad = (lat * Math.PI) / 180
  const worldY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * TILE_SIZE * scale

  const centerLatRad = (centerLat * Math.PI) / 180
  const centerWorldX = (centerLng + 180) / 360 * TILE_SIZE * scale
  const centerWorldY = (1 - Math.log(Math.tan(centerLatRad) + 1 / Math.cos(centerLatRad)) / Math.PI) / 2 * TILE_SIZE * scale

  return {
    x: canvasWidth / 2 + (worldX - centerWorldX),
    y: canvasHeight / 2 + (worldY - centerWorldY),
  }
}

/**
 * Convert a canvas pixel position back to lat/lng.
 */
export function pixelToLatLng(
  pixelX: number, pixelY: number,
  centerLat: number, centerLng: number,
  zoom: number,
  canvasWidth: number, canvasHeight: number,
): LatLng {
  const scale = Math.pow(2, zoom)

  const centerLatRad = (centerLat * Math.PI) / 180
  const centerWorldX = (centerLng + 180) / 360 * TILE_SIZE * scale
  const centerWorldY = (1 - Math.log(Math.tan(centerLatRad) + 1 / Math.cos(centerLatRad)) / Math.PI) / 2 * TILE_SIZE * scale

  const worldX = centerWorldX + (pixelX - canvasWidth / 2)
  const worldY = centerWorldY + (pixelY - canvasHeight / 2)

  const lng = (worldX / (TILE_SIZE * scale)) * 360 - 180
  const n = Math.PI - (2 * Math.PI * worldY) / (TILE_SIZE * scale)
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))

  return { lat, lng }
}

// ─── Clamp & Math ─────────────────────────────────────────────────────────────

/** Clamp a value between min and max */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Linear interpolation between a and b by t (0-1) */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Normalize an angle to the range [0, 360) */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Convert degrees to radians */
export function degToRad(deg: number): number {
  return deg * (Math.PI / 180)
}

/** Convert radians to degrees */
export function radToDeg(rad: number): number {
  return rad * (180 / Math.PI)
}

// ─── Color Utilities ──────────────────────────────────────────────────────────

/**
 * Linearly interpolate between two hex colors.
 * Used for elevation-based color gradients.
 * @param t - Progress from 0 (low) to 1 (high)
 */
export function lerpColor(colorA: string, colorB: string, t: number): string {
  const a = hexToRgb(colorA)
  const b = hexToRgb(colorB)
  if (!a || !b) return colorA

  const r = Math.round(lerp(a.r, b.r, t))
  const g = Math.round(lerp(a.g, b.g, t))
  const bl = Math.round(lerp(a.b, b.b, t))
  return `rgb(${r}, ${g}, ${bl})`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  } : null
}

// ─── Device Detection ─────────────────────────────────────────────────────────

/** Check if we're running on a touch device (mobile/tablet) */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0
}

/** Check if WebGL is available (needed for Three.js renderer) */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return !!(
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')
    )
  } catch {
    return false
  }
}
