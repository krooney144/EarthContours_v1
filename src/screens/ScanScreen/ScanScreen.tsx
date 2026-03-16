/**
 * EarthContours — SCAN Screen  (v2.2)
 *
 * First-person terrain panorama with depth-layered ridgeline rendering.
 *
 * ── Architecture (3 layers) ──────────────────────────────────────────────────
 *
 *  Layer 1 — THE CAMERA (pure math, no drawing):
 *    project(bearingDeg, elevAngleRad, cam) → {x, y}
 *    Single source of truth for all bearing/elevation → screen conversions.
 *    Ridgeline, peak dots, peak labels all call this ONE function.
 *
 *  Layer 2 — SCENE DATA (what exists in the world):
 *    Worker produces SkylineData with 6 depth bands
 *    (ultra-near/near/mid-near/mid/mid-far/far).
 *    Each band stores raw elevation + distance per azimuth.
 *    Main-thread reprojectBands() re-derives angles when AGL changes
 *    — no worker round-trip needed.
 *
 *  Layer 3 — THE RENDERER (draws the scene in painter's order):
 *    renderTerrain() draws bands far→near with depth cues:
 *      - Far: thin lines (1px), low opacity (0.15), light fill
 *      - Mid: medium lines (2.5px), mid opacity (0.4), medium fill
 *      - Near: thick lines (4.5px), high opacity (0.8), dark fill
 *      - Ultra-near: thickest lines (5px), vivid opacity (0.9), deep fill
 *    Adding bands = pushing to DEPTH_BANDS array; renderer auto-scales.
 *
 * ── Painter's order ─────────────────────────────────────────────────────────
 *   1  Sky gradient + stars
 *   2  Far band fill + stroke
 *   3  Mid band fill + stroke
 *   4  Near band fill + stroke
 *   5  Horizon glow
 *   6  Peak dots (snapped to ridgeline via project())
 *   7  Peak label cards (HTML overlay)
 *
 * ── Peak visibility ──────────────────────────────────────────────────────────
 *   isPeakVisible() compares peak elevation angle against the ridgeline.
 *   Dots snap to the max per-band ridgeline angle at the peak's bearing,
 *   ensuring they match exactly what's drawn on screen.  Snap is upward-only:
 *   if the peak's true angle is above all bands, its real position is kept.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useCameraStore, useLocationStore, useTerrainStore, useSettingsStore,
} from '../../store'
import { createLogger } from '../../core/logger'
import {
  COMPASS_DIRECTIONS, COMPASS_ITEM_WIDTH,
  MAX_HEIGHT_M, MIN_HEIGHT_M,
} from '../../core/constants'
import {
  formatElevation, calculateBearing,
  headingToCompass, clamp, metersToFeet,
} from '../../core/utils'
import { fetchPeaksNear }                from '../../data/peakLoader'
import type { Peak, SkylineData, SkylineBand, SkylineRequest, RefinedArc, PeakRefineItem } from '../../core/types'
import { DEPTH_BANDS } from '../../core/types'
import styles from './ScanScreen.module.css'

const log = createLogger('SCREEN:SCAN')

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_DIST          = 400_000     // Maximum render distance (m) — extended for high-AGL viewing
const MAX_PEAK_DIST     = 400_000     // Max distance for peak label display (m)
const EARTH_R           = 6_371_000  // Earth radius (m)
const REFRACTION_K      = 0.13       // Atmospheric refraction coefficient
const DEG_TO_RAD        = Math.PI / 180
const OCEAN_ELEV_M      = 5         // Elevations below this are ocean (matches worker threshold)
const SKYLINE_RESOLUTION = 4         // 0.25° per step = 1440 azimuths for full 360°

// ─── Re-Projection (AGL changes without worker round-trip) ────────────────────

/**
 * Per-band projected elevation angles — computed on the main thread from
 * the worker's raw elevation/distance data whenever viewerElev changes.
 * This avoids a ~2s worker recompute when the user drags the AGL slider.
 */
interface ProjectedBands {
  /** Per-band elevation angles (radians) at each azimuth. Index matches DEPTH_BANDS. */
  bandAngles: Float32Array[]
  /** Overall max angle per azimuth (across all bands) — replaces skylineData.angles for rendering */
  overallAngles: Float32Array
  /** The viewer elevation these were computed for (used to detect staleness) */
  viewerElev: number
}

/**
 * Re-project band elevation angles from raw world data for a new viewer elevation.
 * Handles per-band resolution (high-res near bands have more azimuth samples).
 * Sub-millisecond even with mixed resolutions.
 */
function reprojectBands(
  skyline: SkylineData,
  viewerElev: number,
): ProjectedBands {
  const { numAzimuths, bands } = skyline
  const bandAngles: Float32Array[] = []
  const overallAngles = new Float32Array(numAzimuths)
  overallAngles.fill(-Math.PI / 2)

  for (let bi = 0; bi < bands.length; bi++) {
    const band = bands[bi]
    const bandAz = band.numAzimuths
    const bandRes = band.resolution
    const angles = new Float32Array(bandAz)

    for (let ai = 0; ai < bandAz; ai++) {
      const elev = band.elevations[ai]
      const dist = band.distances[ai]

      if (elev === -Infinity || elev < OCEAN_ELEV_M || dist <= 0) {
        angles[ai] = -Math.PI / 2
        continue
      }

      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effElev  = elev - curvDrop
      angles[ai] = Math.atan2(effElev - viewerElev, dist)

      // Map this high-res azimuth back to the standard-res overall array
      // For standard-res bands (same resolution), this is 1:1
      // For high-res bands, multiple high-res samples map to one standard sample
      const overallIdx = Math.round((ai / bandRes) * skyline.resolution) % numAzimuths
      if (angles[ai] > overallAngles[overallIdx]) {
        overallAngles[overallIdx] = angles[ai]
      }
    }

    bandAngles.push(angles)
  }

  return { bandAngles, overallAngles, viewerElev }
}

// ─── Refined Arc Re-Projection ──────────────────────────────────────────────

/**
 * Pre-computed elevation angles for each refined arc sample.
 * Recomputed on the main thread when AGL changes, same as band re-projection.
 */
interface ProjectedRefinedArc {
  /** Elevation angles (radians) per sample, re-projected for current viewerElev */
  angles: Float32Array
  /** Reference to the source arc (for bearing/distance/GPS lookups) */
  arc: RefinedArc
}

/**
 * Re-project refined arc angles from raw world data for a new viewer elevation.
 * Each arc has ~240 samples — 20 arcs = ~4,800 atan2 calls, sub-millisecond.
 */
function reprojectRefinedArcs(
  arcs: RefinedArc[],
  viewerElev: number,
): ProjectedRefinedArc[] {
  return arcs.map(arc => {
    const angles = new Float32Array(arc.numSamples)
    for (let i = 0; i < arc.numSamples; i++) {
      const elev = arc.elevations[i]
      const dist = arc.distances[i]
      if (elev === -Infinity || dist <= 0) {
        angles[i] = -Math.PI / 2
        continue
      }
      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      angles[i] = Math.atan2(elev - curvDrop - viewerElev, dist)
    }
    return { angles, arc }
  })
}

// ─── Contour Strand Precomputation ────────────────────────────────────────────

/** Contour interval in metres for each depth band index.
 *  Progressive density: ultra-near = 50ft, near = 100ft, mid-near = 200ft,
 *  mid = 500ft, mid-far = 1000ft, far = 2000ft. */
const CONTOUR_INTERVALS_M: number[] = [15.24, 30.48, 60.96, 152.4, 304.8, 609.6]

/** A pre-built contour strand — world-space data ready for per-frame projection. */
interface PrebuiltContourStrand {
  level:    number   // Contour elevation (m), snapped to interval grid
  bandIdx:  number   // Depth band index (for line width/opacity)
  interval: number   // Contour interval for this band (m) — used for major/minor detection
  /** Per-point bearing + elevation angle + distance. Angle is precomputed for the current viewerElev. */
  points:   Array<{ bearingDeg: number; elevAngleRad: number; dist: number }>
}

/**
 * Build contour strands from crossing data across all 360° azimuths.
 * Runs once when skyline data arrives or AGL changes — NOT per frame.
 *
 * For each band: iterates all azimuths, runs occlusion sweep, then
 * strand-tracks by level + direction + distance proximity. Contour levels
 * are snapped to the band's interval grid to eliminate floating point drift.
 */
function buildContourStrands(
  skyline: SkylineData,
  viewerElev: number,
): PrebuiltContourStrand[] {
  const completed: PrebuiltContourStrand[] = []

  for (let bi = skyline.bands.length - 1; bi >= 0; bi--) {
    const band = skyline.bands[bi]
    const bandAz = band.numAzimuths
    const bandRes = band.resolution
    const offsets = band.crossingOffsets
    const data = band.crossingData
    const interval = CONTOUR_INTERVALS_M[bi] || 152.4

    if (!data || data.length === 0) continue

    const maxAzGap = Math.ceil(bandRes * 2)  // Max 2° gap before expiring strand

    // Active strands keyed by snapped-level + direction
    const activeStrands = new Map<string, Array<{
      lastAi:   number
      lastDist: number
      level:    number
      points:   Array<{ bearingDeg: number; elevAngleRad: number; dist: number }>
    }>>()

    for (let ai = 0; ai < bandAz; ai++) {
      const start = offsets[ai]
      const end = offsets[ai + 1]
      const bearingDeg = ai / bandRes

      if (start < end) {
        // Collect crossings, sort near-first for occlusion sweep
        const azCrossings: Array<{ elev: number; dist: number; dir: number }> = []
        for (let j = start; j < end; j += 5) {
          azCrossings.push({ elev: data[j], dist: data[j + 1], dir: data[j + 4] })
        }
        azCrossings.sort((a, b) => a.dist - b.dist)

        // Occlusion sweep: skip crossings hidden behind nearer terrain.
        // For near bands (0–2), disable within-band occlusion — these bands span
        // wide depth ranges (e.g. 0–4.5km) where a hillside at 200m would wrongly
        // occlude all contours out to 4.5km. Painter's order rendering handles
        // visual overlap correctly without data-level occlusion.
        // For far bands (3+), within-band occlusion remains useful since crossings
        // are at similar depths where true occlusion is meaningful.
        let runningMaxAngle = -Math.PI / 2
        const useOcclusion = bi >= 3  // Only occlude within mid/mid-far/far bands
        for (const c of azCrossings) {
          const curvDrop = (c.dist * c.dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
          const angle = Math.atan2(c.elev - curvDrop - viewerElev, c.dist)

          if (useOcclusion && angle <= runningMaxAngle) continue
          if (useOcclusion) runningMaxAngle = angle

          // Skip ocean / near-sea-level elevation — avoids coastline artifacts
          if (c.elev < OCEAN_ELEV_M) continue

          // Snap level to nearest interval — eliminates floating point drift
          const snappedLevel = Math.round(c.elev / interval) * interval
          const levelKey = `${snappedLevel}_${c.dir > 0 ? 'u' : 'd'}`

          let strands = activeStrands.get(levelKey)
          if (!strands) {
            strands = []
            activeStrands.set(levelKey, strands)
          }

          // Match to closest strand by distance proximity
          // Per-band tolerance: tight for close bands (prevents jumpy connections),
          // looser for far bands where large gaps are natural
          const maxDistDiff = bi <= 1
            ? Math.max(10, c.dist * 0.02)   // ultra-near + near: 2%, floor 10m
            : bi === 2
            ? Math.max(50, c.dist * 0.03)   // mid-near: 3%, floor 50m
            : Math.max(200, c.dist * 0.05)  // mid/mid-far/far: 5%, floor 200m (original)
          let bestIdx = -1
          let bestDiff = Infinity
          for (let si = 0; si < strands.length; si++) {
            const s = strands[si]
            if (s.lastAi === ai) continue          // Already matched this azimuth
            if (ai - s.lastAi > maxAzGap) continue // Too old
            const diff = Math.abs(c.dist - s.lastDist)
            if (diff < bestDiff && diff < maxDistDiff) {
              bestIdx = si
              bestDiff = diff
            }
          }

          if (bestIdx >= 0) {
            strands[bestIdx].lastAi = ai
            strands[bestIdx].lastDist = c.dist
            strands[bestIdx].points.push({ bearingDeg, elevAngleRad: angle, dist: c.dist })
          } else {
            strands.push({
              lastAi: ai,
              lastDist: c.dist,
              level: snappedLevel,
              points: [{ bearingDeg, elevAngleRad: angle, dist: c.dist }],
            })
          }
        }
      }

      // Expire old strands periodically (amortized)
      if (ai % maxAzGap === 0) {
        for (const [key, strands] of activeStrands) {
          const remaining: typeof strands = []
          for (const s of strands) {
            if (ai - s.lastAi > maxAzGap) {
              if (s.points.length >= 2) {
                completed.push({ level: s.level, bandIdx: bi, interval, points: s.points })
              }
            } else {
              remaining.push(s)
            }
          }
          if (remaining.length === 0) activeStrands.delete(key)
          else activeStrands.set(key, remaining)
        }
      }
    }

    // Flush remaining active strands
    for (const [, strands] of activeStrands) {
      for (const s of strands) {
        if (s.points.length >= 2) {
          completed.push({ level: s.level, bandIdx: bi, interval, points: s.points })
        }
      }
    }
  }

  return completed
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface DragState {
  isDragging: boolean
  lastX: number
  lastY: number
}

interface PinchState {
  isPinching:  boolean
  lastDist:    number
  startFov:    number
}

interface PeakScreenPos {
  id:          string
  name:        string
  elevation_m: number
  dist_km:     number
  bearing:     number
  lat:         number
  lng:         number
  screenX:     number
  screenY:     number
}

// ─── The Camera — Single Source of Truth ──────────────────────────────────────
//
// Every bearing/elevation → screen pixel conversion goes through this one function.
// Ridgeline renderer, peak dots, peak labels — all call project(). If this changes,
// everything moves together. Alignment bugs become structurally impossible.

interface CameraParams {
  heading_deg: number
  pitch_deg:   number
  hfov:        number
  W:           number   // Physical pixels (canvas.width)
  H:           number   // Physical pixels (canvas.height)
}

/**
 * Project a bearing (degrees) and elevation angle (radians) to physical-pixel
 * canvas coordinates.  This is the ONLY function that performs this conversion.
 *
 * bearingDeg: absolute compass bearing (0=N, 90=E, …)
 * elevAngleRad: elevation angle in radians (0=horizon, +up, −down)
 */
function project(
  bearingDeg: number,
  elevAngleRad: number,
  cam: CameraParams,
): { x: number; y: number } {
  const hfovRad  = cam.hfov * DEG_TO_RAD
  const pitchRad = cam.pitch_deg * DEG_TO_RAD

  // Uniform pixels-per-radian: horizontal FOV drives both axes.
  // This gives real camera zoom behaviour — zooming in magnifies equally
  // in both directions, like binoculars.
  const pxPerRad = cam.W / hfovRad

  // Bearing offset from camera center, wrapped to [-180, 180]
  let dBearing = bearingDeg - cam.heading_deg
  if (dBearing > 180) dBearing -= 360
  if (dBearing < -180) dBearing += 360
  const dBearingRad = dBearing * DEG_TO_RAD

  const horizonY = cam.H * 0.5 - pitchRad * pxPerRad

  return {
    x: cam.W * 0.5 + dBearingRad * pxPerRad,
    y: horizonY - elevAngleRad * pxPerRad,
  }
}

/**
 * Compute the horizonY for the current camera (convenience for sky/glow drawing).
 */
function getHorizonY(cam: CameraParams): number {
  const pxPerRad = cam.W / (cam.hfov * DEG_TO_RAD)
  const pitchRad = cam.pitch_deg * DEG_TO_RAD
  return cam.H * 0.5 - pitchRad * pxPerRad
}

// ─── First-Person Projection ──────────────────────────────────────────────────

/**
 * Compute bearing (degrees) and elevation angle (radians) from viewer to a
 * world-space point.  Returns null if the point is behind the viewer.
 * Includes Earth curvature + atmospheric refraction correction.
 */
function worldToBearingElev(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
): { bearingDeg: number; elevAngleRad: number; horizDist: number } | null {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)

  const dx_east  = (lng - viewerLng) * 111_320 * cosLat
  const dy_north = (lat - viewerLat) * 111_132

  const horizDist = Math.sqrt(dx_east * dx_east + dy_north * dy_north)
  if (horizDist < 10) return null

  // Bearing in degrees (0=N, 90=E)
  const bearingDeg = ((Math.atan2(dx_east, dy_north) * 180 / Math.PI) + 360) % 360

  // Earth curvature + refraction correction — same formula as ray march
  const curvDrop     = (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const corrElev     = elev - curvDrop
  const dz_up        = corrElev - viewerElev
  const elevAngleRad = Math.atan2(dz_up, horizDist)

  return { bearingDeg, elevAngleRad, horizDist }
}

/**
 * Project a world-space point into first-person screen space.
 * Uses worldToBearingElev → project() pipeline (single camera).
 */
function projectFirstPerson(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
  cam: CameraParams,
): { screenX: number; screenY: number; horizDist: number } | null {
  const world = worldToBearingElev(lat, lng, elev, viewerLat, viewerLng, viewerElev)
  if (!world) return null

  const { x, y } = project(world.bearingDeg, world.elevAngleRad, cam)
  return { screenX: x, screenY: y, horizDist: world.horizDist }
}


// ─── Peak Visibility Check ────────────────────────────────────────────────────

/** Distance threshold for "near" peaks — shown if they have line-of-sight
 *  regardless of whether they poke above the skyline. */
const NEAR_PEAK_DIST = 50_000  // 50 km

/**
 * Two-tier peak visibility:
 *  1. Skyline peaks (any distance): visible if peak angle ≥ ridgeline angle.
 *  2. Near peaks (< 50 km): visible if not fully occluded by terrain between
 *     viewer and peak — approximated by checking the peak's angle against
 *     the per-band ridgeline for bands closer than the peak's distance.
 *
 * FOV check uses the full horizontal FOV (not the 60% margin from before)
 * so peaks significantly off-center still appear when they're in-frame.
 */
function isPeakVisible(
  peak: Peak,
  viewerLat: number, viewerLng: number, viewerElev: number,
  heading_deg: number, hfov: number,
  skyline: SkylineData,
  projected: ProjectedBands | null,
): boolean {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)
  const dx = (peak.lng - viewerLng) * 111_320 * cosLat
  const dy = (peak.lat - viewerLat) * 111_132
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist > MAX_PEAK_DIST || dist < 100) return false

  // Bearing from viewer to peak
  const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

  // Full-FOV check — show peaks anywhere in the camera frustum
  let angleDiff = bearing - heading_deg
  if (angleDiff > 180) angleDiff -= 360
  if (angleDiff < -180) angleDiff += 360
  if (Math.abs(angleDiff) > hfov * 0.5) return false

  // Earth curvature correction
  const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const peakAngle = Math.atan2(peak.elevation_m - curvDrop - viewerElev, dist)

  // Ridgeline angle — uses re-projected angles (AGL-aware)
  const ridgeAngle = skylineAngleAt(skyline, bearing, projected)
  const tolerance = 0.15 * DEG_TO_RAD

  // Tier 1: skyline peak — above the overall ridgeline
  if (peakAngle >= ridgeAngle - tolerance) return true

  // Tier 2: near-ground peak — within 50 km, check if closer terrain occludes it.
  // Only bands whose maxDist < peak distance can occlude; if the peak's angle is
  // above all those closer-band ridgelines, it has line-of-sight.
  if (dist <= NEAR_PEAK_DIST) {
    let occluded = false
    for (let bi = 0; bi < skyline.bands.length; bi++) {
      const bandCfg = DEPTH_BANDS[bi]
      if (!bandCfg || bandCfg.minDist >= dist) continue  // band is farther than peak
      const bandAngle = bandAngleAt(skyline, bi, bearing, projected)
      if (bandAngle > -Math.PI / 2 + 0.001 && peakAngle < bandAngle - tolerance) {
        occluded = true
        break
      }
    }
    if (!occluded) return true
  }

  return false
}

// ─── Quick Render (SkylineData) ───────────────────────────────────────────────

/**
 * Look up the ridgeline elevation angle for a given bearing.
 * Uses re-projected overall angles when available (AGL-aware), falls back to
 * worker-baked angles.  Linearly interpolates between adjacent azimuth samples
 * to eliminate stair-stepping artifacts.
 */
function skylineAngleAt(
  skyline: SkylineData,
  bearingDeg: number,
  projected: ProjectedBands | null = null,
): number {
  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * skyline.resolution
  const idx0 = Math.floor(fracIdx) % skyline.numAzimuths
  const idx1 = (idx0 + 1) % skyline.numAzimuths
  const t = fracIdx - Math.floor(fracIdx)

  const arr = projected ? projected.overallAngles : skyline.angles
  return arr[idx0] * (1 - t) + arr[idx1] * t
}

/**
 * Look up the per-band elevation angle for a given bearing and band index.
 * Uses the band's own resolution (high-res near bands have finer azimuth spacing).
 * Linearly interpolates between adjacent azimuth samples for smooth ridgelines.
 * Returns -PI/2 if no ridge in this band at this azimuth.
 */
function bandAngleAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
  projected: ProjectedBands | null,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const SENTINEL = -Math.PI / 2 + 0.001

  if (projected) {
    const arr = projected.bandAngles[bandIndex]
    const a0 = arr[idx0], a1 = arr[idx1]
    if (a0 <= SENTINEL && a1 <= SENTINEL) return -Math.PI / 2
    if (a0 <= SENTINEL) return a1
    if (a1 <= SENTINEL) return a0
    return a0 * (1 - t) + a1 * t
  }

  // Fallback: compute from raw data with interpolation
  if ((band.elevations[idx0] === -Infinity || band.elevations[idx0] < OCEAN_ELEV_M) &&
      (band.elevations[idx1] === -Infinity || band.elevations[idx1] < OCEAN_ELEV_M)) return -Math.PI / 2

  const computeAngle = (idx: number) => {
    if (band.elevations[idx] === -Infinity || band.elevations[idx] < OCEAN_ELEV_M) return -Math.PI / 2
    const dist = band.distances[idx]
    const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
    return Math.atan2(band.elevations[idx] - curvDrop - skyline.computedAt.elev, dist)
  }

  const a0 = computeAngle(idx0), a1 = computeAngle(idx1)
  if (a0 <= SENTINEL && a1 <= SENTINEL) return -Math.PI / 2
  if (a0 <= SENTINEL) return a1
  if (a1 <= SENTINEL) return a0
  return a0 * (1 - t) + a1 * t
}

/** Interpolated raw elevation at a fractional bearing for a given band. */
function bandElevAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const e0 = band.elevations[idx0]
  const e1 = band.elevations[idx1]
  if (e0 === -Infinity && e1 === -Infinity) return -Infinity
  if (e0 === -Infinity) return e1
  if (e1 === -Infinity) return e0
  return e0 * (1 - t) + e1 * t
}

/** Interpolated distance at a fractional bearing for a given band. */
function bandDistAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): number {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  const d0 = band.distances[idx0]
  const d1 = band.distances[idx1]
  // If either sample has no ridge (-Infinity elevation), return the other
  if (band.elevations[idx0] === -Infinity && band.elevations[idx1] === -Infinity) return 0
  if (band.elevations[idx0] === -Infinity) return d1
  if (band.elevations[idx1] === -Infinity) return d0
  return d0 * (1 - t) + d1 * t
}

/** Interpolated GPS coords of the ridgeline point at a fractional bearing for a given band.
 *  Returns null if no ridge at this azimuth. */
function bandGpsAt(
  skyline: SkylineData,
  bandIndex: number,
  bearingDeg: number,
): { lat: number; lng: number } | null {
  const band = skyline.bands[bandIndex]
  const bandRes = band.resolution
  const bandAz  = band.numAzimuths

  const normBearing = ((bearingDeg % 360) + 360) % 360
  const fracIdx = normBearing * bandRes
  const idx0 = Math.floor(fracIdx) % bandAz
  const idx1 = (idx0 + 1) % bandAz
  const t = fracIdx - Math.floor(fracIdx)

  if (band.elevations[idx0] === -Infinity && band.elevations[idx1] === -Infinity) return null
  if (band.elevations[idx0] === -Infinity) return { lat: band.ridgeLats[idx1], lng: band.ridgeLngs[idx1] }
  if (band.elevations[idx1] === -Infinity) return { lat: band.ridgeLats[idx0], lng: band.ridgeLngs[idx0] }

  return {
    lat: band.ridgeLats[idx0] * (1 - t) + band.ridgeLats[idx1] * t,
    lng: band.ridgeLngs[idx0] * (1 - t) + band.ridgeLngs[idx1] * t,
  }
}

/** GPS proximity radius (metres) per depth band — peaks must own the ridgeline within this radius.
 *  Near terrain has tight radius (ridge points are close together),
 *  far terrain needs wider radius (ridge points are spread far apart). */
const BAND_GPS_RADIUS: number[] = [
  500,     // ultra-near: 0.5 km
  2_000,   // near:       2 km
  5_000,   // mid-near:   5 km
  10_000,  // mid:        10 km
  10_000,  // mid-far:    10 km
  15_000,  // far:        15 km
]

// ─── Elevation → Palette Color ────────────────────────────────────────────────
//
// Maps a normalized elevation (0–1) through the ocean-depth palette stops.
// Low ridgelines = abyss (dark), high peaks = reef (bright).
// Palette: abyss → deep → navy → ocean → mid → reef

const RIDGE_PALETTE: [number, number, number][] = [
  [14,  57,  81],   // abyss  #0E3951  t=0.0
  [18,  75, 107],   // deep   #124B6B  t=0.2
  [33,  92, 121],   // navy   #215C79  t=0.4
  [47, 109, 135],   // ocean  #2F6D87  t=0.6
  [75, 142, 163],   // mid    #4B8EA3  t=0.8
  [104, 176, 191],  // reef   #68B0BF  t=1.0
]

function elevToRidgeColor(tElev: number): string {
  const t = Math.max(0, Math.min(1, tElev))
  const maxIdx = RIDGE_PALETTE.length - 1
  const scaled = t * maxIdx
  const i0 = Math.floor(scaled)
  const i1 = Math.min(i0 + 1, maxIdx)
  const frac = scaled - i0
  const [r0, g0, b0] = RIDGE_PALETTE[i0]
  const [r1, g1, b1] = RIDGE_PALETTE[i1]
  const r = Math.round(r0 + (r1 - r0) * frac)
  const g = Math.round(g0 + (g1 - g0) * frac)
  const b = Math.round(b0 + (b1 - b0) * frac)
  return `rgb(${r},${g},${b})`
}

// ─── Depth Band Visual Parameters ─────────────────────────────────────────────
//
// Driven by band index as a fraction of total bands.  Adding bands later means
// these interpolate automatically — no hardcoded per-band style blocks.

interface BandStyle {
  fillColor:      string   // Terrain fill below ridgeline
  strokeColor:    string   // Ridgeline stroke RGBA (fallback)
  lineWidthNear:  number   // Ridgeline thickness at band's near edge (px)
  lineWidthFar:   number   // Ridgeline thickness at band's far edge (px)
}

/** Per-band line widths: edges match at boundaries so adjacent bands are seamless.
 *  ultra-near 5→4.5, near 4.5→3.5, mid-near 3.5→3, mid 3→2.5, mid-far 2.5→2, far 2→1.
 *  Thinner lines let elevation color and terrain shape show through. */
const BAND_LINE_WIDTHS: [number, number][] = [
  [5, 4.5],  // ultra-near: 5px at 0km → 4.5px at 4.5km
  [4.5, 3.5],// near:       4.5px at 4km → 3.5px at 10.5km
  [3.5, 3],  // mid-near:   3.5px at 10km → 3px at 31km
  [3, 2.5],  // mid:        3px at 30km → 2.5px at 81km
  [2.5, 2],  // mid-far:    2.5px at 80km → 2px at 152km
  [2, 1],    // far:        2px at 150km → 1px at 400km
]

function bandStyleForIndex(bandIndex: number, bandCount: number): BandStyle {
  // t = 0 (far) → 1 (near)
  const t = bandCount <= 1 ? 1 : 1 - bandIndex / (bandCount - 1)

  // Fill: void (#000810) → deep (#124B6B), on the ocean-depth palette
  const FILL_COLORS: [number, number, number][] = [
    [2,  12, 20],   // ultra-near — near void
    [5,  24, 38],   // near — 20% toward deep
    [8,  36, 56],   // mid-near — 40% toward deep
    [11, 48, 74],   // mid — 60% toward deep
    [14, 62, 90],   // mid-far — 80% toward deep
    [18, 75, 107],  // far — exactly ec-deep
  ]
  const bandIdx = bandCount <= 1 ? 0 : Math.round((1 - t) * (FILL_COLORS.length - 1))
  const [fillR, fillG, fillB] = FILL_COLORS[Math.min(bandIdx, FILL_COLORS.length - 1)]
  const fillColor = `rgb(${fillR},${fillG},${fillB})`

  const strokeColor = `rgba(132, 209, 219, ${(0.15 + t * 0.65).toFixed(2)})`

  const widths = BAND_LINE_WIDTHS[bandIndex] || [1 + t * 4, 1 + t * 4]

  return { fillColor, strokeColor, lineWidthNear: widths[0], lineWidthFar: widths[1] }
}

/**
 * Layered terrain renderer — draws depth bands in painter's order (far→near).
 * Each band gets its own fill (flat) + ridgeline stroke with:
 *   - Distance-based line width (edges match at band boundaries)
 *   - Per-azimuth color from elevation (high=reef/bright → low=abyss/dark)
 *   - All bands render all segments (no fill gaps)
 * All projection goes through project() — single camera source of truth.
 */
function renderTerrain(
  ctx: CanvasRenderingContext2D,
  skyline: SkylineData,
  cam: CameraParams,
  projected: ProjectedBands | null,
  showBandLines: boolean = true,
  showFill: boolean = true,
): void {
  const { W, H } = cam
  const numBands = skyline.bands.length

  // ── Global elevation range for color normalization ───────────────────────
  let globalElevMin = Infinity
  let globalElevMax = -Infinity
  for (let bi = 0; bi < numBands; bi++) {
    const elev = skyline.bands[bi].elevations
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] === -Infinity || elev[i] < OCEAN_ELEV_M) continue
      if (elev[i] < globalElevMin) globalElevMin = elev[i]
      if (elev[i] > globalElevMax) globalElevMax = elev[i]
    }
  }
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1  // Avoid division by zero

  // Per-band segment size: near bands update color/width frequently,
  // far bands use long segments to avoid dotty appearance from stroke gaps
  const SEGMENT_SIZES = [3, 4, 6, 12, 24, 48]  // ultra-near → far

  // Draw bands far→near (painter's order: far gets painted first, near overlaps)
  // Reverse iteration: DEPTH_BANDS[0]=near, [1]=mid, [2]=far → draw [2],[1],[0]
  for (let bi = numBands - 1; bi >= 0; bi--) {
    const style = bandStyleForIndex(bi, numBands)
    const bandCfg = DEPTH_BANDS[bi]
    const segSize = SEGMENT_SIZES[bi] ?? 24

    // Line width interpolation helper
    const lwMin = bandCfg ? bandCfg.minDist : 0
    const lwMax = bandCfg ? bandCfg.maxDist : 1
    const lwRange = lwMax - lwMin

    // ── Fill below this band's ridgeline ───────────────────────────────────
    ctx.beginPath()
    ctx.moveTo(0, H)
    let hasVisiblePixels = false

    for (let col = 0; col < W; col++) {
      const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
      const angle = bandAngleAt(skyline, bi, bearingDeg, projected)

      // Skip columns where this band has no data (sentinel -PI/2)
      if (angle <= -Math.PI / 2 + 0.001) {
        ctx.lineTo(col, H)
        continue
      }

      hasVisiblePixels = true
      const { y } = project(bearingDeg, angle, cam)
      const screenY = Math.round(y)
      ctx.lineTo(col, Math.min(H, Math.max(0, screenY)))
    }

    ctx.lineTo(W, H)
    ctx.closePath()
    if (hasVisiblePixels && showFill) {
      ctx.fillStyle = style.fillColor
      ctx.fill()
    }

    // ── Ridgeline stroke — continuous paths with periodic color updates ──
    if (hasVisiblePixels && showBandLines) {
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'round'

      let segStartCol = -1

      for (let col = 0; col < W; col++) {
        const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
        const angle = bandAngleAt(skyline, bi, bearingDeg, projected)

        if (angle <= -Math.PI / 2 + 0.001) {
          if (segStartCol >= 0) ctx.stroke()
          segStartCol = -1
          continue
        }

        const { y } = project(bearingDeg, angle, cam)
        const screenY = Math.round(y)

        if (screenY >= H) {
          if (segStartCol >= 0) ctx.stroke()
          segStartCol = -1
          continue
        }

        const clampedY = Math.max(0, screenY)

        if (segStartCol < 0) {
          // Start a new segment — compute color + distance-based line width
          const elev = bandElevAt(skyline, bi, bearingDeg)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange
            : 0.5
          const dist = bandDistAt(skyline, bi, bearingDeg)
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          ctx.lineWidth = style.lineWidthNear + tDist * (style.lineWidthFar - style.lineWidthNear)
          ctx.beginPath()
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(col, clampedY)
          segStartCol = col
        } else if (col - segStartCol >= segSize) {
          // Flush current segment, start new one with updated color + width.
          // Overlap by 1px: lineTo then moveTo at same point prevents gaps.
          ctx.lineTo(col, clampedY)
          ctx.stroke()

          const elev = bandElevAt(skyline, bi, bearingDeg)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange
            : 0.5
          const dist = bandDistAt(skyline, bi, bearingDeg)
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          ctx.lineWidth = style.lineWidthNear + tDist * (style.lineWidthFar - style.lineWidthNear)
          ctx.beginPath()
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(col, clampedY)
          segStartCol = col
        } else {
          ctx.lineTo(col, clampedY)
        }
      }

      // Flush final segment
      if (segStartCol >= 0) ctx.stroke()
    }
  }
}

// ─── Contour Line Renderer ────────────────────────────────────────────────────

/**
 * Renders pre-built contour strands by projecting them to screen space.
 *
 * Depth cues:
 *   - Per-point distance-based line width: thick near (5px), thin far (0.5px)
 *     using compressed power curve: width = 0.5 + 4.5 × (1 - (d/maxDist)^0.2)
 *   - Per-band opacity (near=vivid, far=faint)
 *
 * Strands are drawn as continuous paths, flushing only when line width changes
 * by more than 20% to avoid the dotty appearance of per-segment strokes.
 */
function renderContours(
  ctx: CanvasRenderingContext2D,
  strands: PrebuiltContourStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  skyline?: SkylineData,
  projected?: ProjectedBands | null,
): void {
  const { W, H } = cam
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  // Distance-based width: 0.5px at 400km, 5px at ~0m
  const MAX_DIST = 400_000
  const WIDTH_MIN = 0.5
  const WIDTH_MAX = 5
  const WIDTH_RANGE = WIDTH_MAX - WIDTH_MIN
  const WIDTH_POWER = 0.2

  // Per-band opacity (near=vivid, far=faint)
  const CONTOUR_OPACITIES = [0.65, 0.55, 0.45, 0.35, 0.25, 0.15]

  // Width change threshold: flush path when width differs by >20%
  const WIDTH_FLUSH_RATIO = 0.2

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const strand of strands) {
    if (strand.points.length < 2) continue

    const bi = strand.bandIdx
    const opacity = CONTOUR_OPACITIES[bi] ?? 0.15

    const tElev = hasElevRange
      ? Math.max(0, Math.min(1, (strand.level - globalElevMin) / elevRange))
      : 0.5
    const baseColor = elevToRidgeColor(tElev)
    const rgbMatch = baseColor.match(/\d+/g)
    if (!rgbMatch) continue

    ctx.strokeStyle = `rgba(${rgbMatch[0]},${rgbMatch[1]},${rgbMatch[2]},${opacity})`

    // Draw as continuous path, flushing only on significant width change or gap
    let pathStarted = false
    let currentWidth = 0

    for (let i = 0; i < strand.points.length; i++) {
      const pt = strand.points[i]

      // ── Occlusion check: skip points hidden behind nearer bands ──
      // For each strand point, check if any band closer than this strand's band
      // has a ridgeline angle above this point's angle at this bearing.
      // This works at all AGL values because projected band angles are already
      // re-projected for the current viewer elevation.
      if (skyline && bi > 0) {
        let occluded = false
        for (let nearerBi = 0; nearerBi < bi; nearerBi++) {
          const nearerAngle = bandAngleAt(skyline, nearerBi, pt.bearingDeg, projected ?? null)
          if (nearerAngle > -Math.PI / 2 + 0.001 && nearerAngle >= pt.elevAngleRad) {
            occluded = true
            break
          }
        }
        if (occluded) {
          if (pathStarted) { ctx.stroke(); pathStarted = false }
          continue
        }
      }

      const { x, y } = project(pt.bearingDeg, pt.elevAngleRad, cam)
      const onScreen = x >= -10 && x <= W + 10 && y >= 0 && y < H

      if (!onScreen) {
        // Off-screen: flush and reset
        if (pathStarted) { ctx.stroke(); pathStarted = false }
        continue
      }

      // Compute width for this point
      const tDist = Math.min(1, pt.dist / MAX_DIST)
      const lw = WIDTH_MIN + WIDTH_RANGE * (1 - Math.pow(tDist, WIDTH_POWER))

      if (!pathStarted) {
        // Start new path
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
        pathStarted = true
      } else if (Math.abs(lw - currentWidth) > currentWidth * WIDTH_FLUSH_RATIO) {
        // Width changed significantly — flush and start new sub-path from same point
        ctx.lineTo(x, y)
        ctx.stroke()
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }

    if (pathStarted) ctx.stroke()
  }
}

// ─── Peak Ridgeline Profiles ──────────────────────────────────────────────────
//
// For each visible peak, draw the ridgeline from the single depth band that
// contains the peak's distance.  A GPS proximity check per azimuth ensures the
// highlight only covers azimuths where the peak actually owns the ridgeline
// (i.e. the ridge point is close to the peak, not some unrelated terrain).
// Proximity radius varies by band: near ~1km, mid ~10km, far ~15km.
// Alpha fades smoothly to transparent at the arc edges for a natural appearance.

/** Angular half-width of the peak ridgeline arc (degrees). */
const PEAK_ARC_HALF_FAR  = 5    // ±5° for peaks ≥ 10 km
const PEAK_ARC_HALF_NEAR = 10   // ±10° for peaks < 10 km (linearly interpolated)
const PEAK_ARC_NEAR_DIST = 10_000  // Distance (m) below which arc widens

/** Bearing step size for sampling the ridgeline within the arc (degrees). */
const PEAK_ARC_STEP = 0.25

/** Flat-earth distance² between two GPS points (metres²). Fast approximation valid within ~300km. */
function gpsDistSq(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dy = (lat2 - lat1) * 111_132
  const cosLat = Math.cos(lat1 * Math.PI / 180)
  const dx = (lng2 - lng1) * 111_320 * cosLat
  return dx * dx + dy * dy
}

function renderPeakRidgelines(
  ctx: CanvasRenderingContext2D,
  skyline: SkylineData,
  projected: ProjectedBands | null,
  peakPositions: PeakScreenPos[],
  cam: CameraParams,
  projectedArcs: ProjectedRefinedArc[] | null,
): void {
  const { W, H } = cam
  const numBands = skyline.bands.length

  // Global elevation range for color normalization (same as renderTerrain)
  let globalElevMin = Infinity
  let globalElevMax = -Infinity
  for (let bi = 0; bi < numBands; bi++) {
    const elev = skyline.bands[bi].elevations
    for (let i = 0; i < elev.length; i++) {
      if (elev[i] === -Infinity || elev[i] < OCEAN_ELEV_M) continue
      if (elev[i] < globalElevMin) globalElevMin = elev[i]
      if (elev[i] > globalElevMax) globalElevMax = elev[i]
    }
  }
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const pos of peakPositions) {
    const peakBearing = pos.bearing
    const peakDist_m  = pos.dist_km * 1000

    // Find the single band whose distance range contains this peak.
    // If the peak falls in an overlap zone, pick the higher-resolution (lower index) band.
    let bestBand = -1
    for (let bi = 0; bi < numBands; bi++) {
      const cfg = DEPTH_BANDS[bi]
      if (cfg && peakDist_m >= cfg.minDist && peakDist_m <= cfg.maxDist) {
        bestBand = bi
        break
      }
    }
    if (bestBand < 0) continue  // Peak outside all band ranges

    const gpsRadius_m = BAND_GPS_RADIUS[bestBand] ?? 10_000
    const gpsRadiusSq = gpsRadius_m * gpsRadius_m

    // Determine arc half-width: wider for nearby peaks, narrower for far
    const distT = Math.max(0, Math.min(1, peakDist_m / PEAK_ARC_NEAR_DIST))
    const arcHalf = PEAK_ARC_HALF_NEAR + distT * (PEAK_ARC_HALF_FAR - PEAK_ARC_HALF_NEAR)

    // Inherit band's distance-based line width + small boost so it stands out
    const lw = BAND_LINE_WIDTHS[bestBand] ?? BAND_LINE_WIDTHS[BAND_LINE_WIDTHS.length - 1]
    const bandCfg = DEPTH_BANDS[bestBand]
    const lwMin = bandCfg?.minDist ?? 0
    const lwMax = bandCfg?.maxDist ?? MAX_DIST
    const lwRange = lwMax - lwMin
    const lwT = lwRange > 0 ? Math.max(0, Math.min(1, (peakDist_m - lwMin) / lwRange)) : 0
    const bandLineWidth = lw[0] + lwT * (lw[1] - lw[0])
    const lineWidth = bandLineWidth + 1  // slight boost over band line
    const baseAlpha = 0.75
    ctx.lineWidth = lineWidth

    // ── Try refined arc first (5× denser sampling around detected features) ──
    // Find a refined arc whose bearing range covers this peak's bearing.
    // The arc must also be in the same band as the peak for correct depth matching.
    let matchedArc: ProjectedRefinedArc | null = null
    if (projectedArcs) {
      for (const pa of projectedArcs) {
        if (pa.arc.bandIndex !== bestBand) continue
        let dBearing = peakBearing - pa.arc.centerBearing
        if (dBearing > 180) dBearing -= 360
        if (dBearing < -180) dBearing += 360
        if (Math.abs(dBearing) <= pa.arc.halfWidth) {
          matchedArc = pa
          break
        }
      }
    }

    if (matchedArc) {
      // ── Render using refined arc data (high-res path) ─────────────────────
      // Walk the arc's dense samples, using pre-projected angles and raw GPS
      // for the proximity check.  Gives ~5× smoother ridgeline profile than
      // band data around peaks.
      const { arc, angles: arcAngles } = matchedArc
      const BATCH_SIZE = 8
      let segCount = 0
      let pathStarted = false

      for (let si = 0; si < arc.numSamples; si++) {
        const bearingOffset = -arc.halfWidth + si * arc.stepDeg
        const bearing = arc.centerBearing + bearingOffset

        // Only render within the peak's arc half-width (with edge fade)
        let dBearing = bearing - peakBearing
        if (dBearing > 180) dBearing -= 360
        if (dBearing < -180) dBearing += 360
        if (Math.abs(dBearing) > arcHalf) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        // GPS proximity check: does the peak own the ridgeline at this sample?
        if (arc.elevations[si] === -Infinity) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }
        const ridgeDistSq = gpsDistSq(pos.lat, pos.lng, arc.ridgeLats[si], arc.ridgeLngs[si])
        if (ridgeDistSq > gpsRadiusSq) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const angle = arcAngles[si]
        if (angle <= -Math.PI / 2 + 0.001) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const { x, y } = project(bearing, angle, cam)
        if (x < -50 || x > W + 50 || y < 0 || y > H) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        // Edge fade: alpha falls off smoothly toward arc edges (cosine curve)
        const edgeT = Math.abs(dBearing) / arcHalf  // 0 at center, 1 at edge
        const edgeFade = Math.cos(edgeT * Math.PI * 0.5) // 1 at center, 0 at edge
        const alpha = baseAlpha * edgeFade
        if (alpha < 0.01) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        if (!pathStarted) {
          const tElev = hasElevRange && arc.elevations[si] > -Infinity
            ? (arc.elevations[si] - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) continue
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)
          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          pathStarted = true
          segCount = 0
        } else if (segCount >= BATCH_SIZE) {
          ctx.lineTo(x, y)
          ctx.stroke()
          const tElev = hasElevRange && arc.elevations[si] > -Infinity
            ? (arc.elevations[si] - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) { pathStarted = false; segCount = 0; continue }
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)
          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          segCount = 0
        } else {
          ctx.lineTo(x, y)
          segCount++
        }
      }
      if (pathStarted) ctx.stroke()

    } else {
      // ── Fallback: render using band data (original path) ──────────────────
      const totalSteps = Math.ceil(arcHalf * 2 / PEAK_ARC_STEP)
      const BATCH_SIZE = 6
      let segCount = 0
      let pathStarted = false

      for (let s = 0; s <= totalSteps; s++) {
        const bearingOffset = -arcHalf + (s / (totalSteps || 1)) * arcHalf * 2
        const bearing = peakBearing + bearingOffset

        // GPS proximity check: does the peak own the ridgeline at this azimuth?
        const ridgeGps = bandGpsAt(skyline, bestBand, bearing)
        if (!ridgeGps || gpsDistSq(pos.lat, pos.lng, ridgeGps.lat, ridgeGps.lng) > gpsRadiusSq) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const angle = bandAngleAt(skyline, bestBand, bearing, projected)
        if (angle <= -Math.PI / 2 + 0.001) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        const { x, y } = project(bearing, angle, cam)
        if (x < -50 || x > W + 50 || y < 0 || y > H) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        // Edge fade: alpha falls off smoothly toward arc edges (cosine curve)
        const edgeT = Math.abs(bearingOffset) / arcHalf  // 0 at center, 1 at edge
        const edgeFade = Math.cos(edgeT * Math.PI * 0.5) // 1 at center, 0 at edge
        const alpha = baseAlpha * edgeFade
        if (alpha < 0.01) {
          if (pathStarted) ctx.stroke()
          pathStarted = false
          segCount = 0
          continue
        }

        if (!pathStarted) {
          const elev = bandElevAt(skyline, bestBand, bearing)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) continue
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)

          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          pathStarted = true
          segCount = 0
        } else if (segCount >= BATCH_SIZE) {
          ctx.lineTo(x, y)
          ctx.stroke()

          const elev = bandElevAt(skyline, bestBand, bearing)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange : 0.5
          const color = elevToRidgeColor(tElev)
          const rgbMatch = color.match(/\d+/g)
          if (!rgbMatch) { pathStarted = false; segCount = 0; continue }
          const r = parseInt(rgbMatch[0]), g = parseInt(rgbMatch[1]), b = parseInt(rgbMatch[2])
          const cr = Math.round(r + (255 - r) * 0.15)
          const cg = Math.round(g + (255 - g) * 0.15)
          const cb = Math.round(b + (255 - b) * 0.15)

          ctx.beginPath()
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(3)})`
          ctx.moveTo(x, y)
          segCount = 0
        } else {
          ctx.lineTo(x, y)
          segCount++
        }
      }

      if (pathStarted) ctx.stroke()
    }
  }

  ctx.restore()
}

// ─── Full Canvas Draw ─────────────────────────────────────────────────────────

function drawScanCanvas(
  canvas: HTMLCanvasElement,
  peaks: Peak[],
  heading_deg: number,
  pitch_deg: number,
  eyeHeight_m: number,
  activeLat: number,
  activeLng: number,
  hfov: number,
  skylineData: SkylineData | null,
  projectedBands: ProjectedBands | null,
  contourStrands: PrebuiltContourStrand[],
  projectedArcs: ProjectedRefinedArc[] | null,
  showBandLines: boolean = true,
  showFill: boolean = true,
  showPeakLabels: boolean = true,
): PeakScreenPos[] {
  const ctx = canvas.getContext('2d')
  if (!ctx) return []

  const W = canvas.width
  const H = canvas.height

  // Use the worker's z15-corrected ground elevation. Before skyline is ready,
  // we can't draw terrain anyway so groundElev = 0 is fine for initial frame.
  const groundElev = skylineData
    ? skylineData.computedAt.groundElev
    : 0
  const eyeElev    = groundElev + eyeHeight_m

  // Single camera params — shared by every projection call this frame
  const cam: CameraParams = { heading_deg, pitch_deg, hfov, W, H }
  const horizonY = getHorizonY(cam)

  // ── 1. Sky gradient ─────────────────────────────────────────────────────────
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0,    '#000810')
  skyGrad.addColorStop(0.20, '#020c18')
  skyGrad.addColorStop(0.50, '#051520')
  skyGrad.addColorStop(0.78, '#071a2a')
  skyGrad.addColorStop(0.90, '#0c2235')
  skyGrad.addColorStop(1.0,  '#0f2c42')
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

  // Subtle star field
  ctx.save()
  ctx.globalAlpha = 0.35
  const starRng = { seed: 42 }
  const rand = () => { starRng.seed = (starRng.seed * 16807 + 0) & 0x7fffffff; return starRng.seed / 0x7fffffff }
  const starLimit = Math.round(H * 0.45)
  for (let s = 0; s < 80; s++) {
    const sx = rand() * W
    const sy = rand() * starLimit
    const sr = rand() * 0.8 + 0.3
    ctx.fillStyle = `rgba(167, 221, 229, ${0.3 + rand() * 0.5})`
    ctx.beginPath()
    ctx.arc(sx, sy, sr, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  // ── 2. Terrain — depth-layered rendering (far→near painter's order) ─────────
  if (skylineData) {
    renderTerrain(ctx, skylineData, cam, projectedBands, showBandLines, showFill)
  }

  // ── 2b. Contour lines — pre-built strands projected to screen ───────────────
  if (contourStrands.length > 0 && skylineData) {
    // Compute global elevation range (same as renderTerrain uses)
    let cElevMin = Infinity, cElevMax = -Infinity
    for (let bi = 0; bi < skylineData.bands.length; bi++) {
      const elev = skylineData.bands[bi].elevations
      for (let i = 0; i < elev.length; i++) {
        if (elev[i] === -Infinity) continue
        if (elev[i] < cElevMin) cElevMin = elev[i]
        if (elev[i] > cElevMax) cElevMax = elev[i]
      }
    }
    renderContours(ctx, contourStrands, cam, cElevMin, cElevMax, skylineData, projectedBands)
  }

  // ── 3. Horizon glow ──────────────────────────────────────────────────────────
  const glowGrad = ctx.createLinearGradient(0, horizonY - 12, 0, horizonY + 12)
  glowGrad.addColorStop(0,   'rgba(132, 209, 219, 0)')
  glowGrad.addColorStop(0.5, 'rgba(132, 209, 219, 0.22)')
  glowGrad.addColorStop(1,   'rgba(132, 209, 219, 0)')
  ctx.fillStyle = glowGrad
  ctx.fillRect(0, Math.round(horizonY - 12), W, 24)

  ctx.fillStyle = 'rgba(132, 209, 219, 0.18)'
  ctx.fillRect(0, Math.round(horizonY), W, 1)

  // ── 4. Peak placement — all through project() ─────────────────────────────

  const peakPositions: PeakScreenPos[] = []

  const visiblePeaks = skylineData
    ? peaks.filter(p => isPeakVisible(p, activeLat, activeLng, eyeElev, heading_deg, hfov, skylineData, projectedBands))
    : peaks.filter(p => {
        const cosLat = Math.cos(activeLat * DEG_TO_RAD)
        const dx = (p.lng - activeLng) * 111_320 * cosLat
        const dy = (p.lat - activeLat) * 111_132
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist > MAX_PEAK_DIST || dist < 100) return false
        const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360
        let angleDiff = bearing - heading_deg
        if (angleDiff > 180) angleDiff -= 360
        if (angleDiff < -180) angleDiff += 360
        return Math.abs(angleDiff) <= hfov * 0.5
      })

  const topPeaks = visiblePeaks
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 15)

  for (const peak of topPeaks) {
    const projected = projectFirstPerson(
      peak.lat, peak.lng, peak.elevation_m,
      activeLat, activeLng, eyeElev, cam,
    )
    if (!projected) continue

    let { screenX, screenY, horizDist } = projected
    if (screenX < -50 || screenX > W + 50) continue
    if (horizDist > MAX_PEAK_DIST) continue

    // Snap skyline peaks to the ridgeline so dots sit exactly on the drawn line.
    // Near-ground peaks (below ridge) keep their true projected position.
    if (skylineData) {
      const bearing = calculateBearing(
        { lat: activeLat, lng: activeLng },
        { lat: peak.lat, lng: peak.lng },
      )
      const curvDrop = (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const peakAngle = Math.atan2(peak.elevation_m - curvDrop - eyeElev, horizDist)
      const ridgeAngle = skylineAngleAt(skylineData, bearing, projectedBands)

      // Only snap if peak is at/above the ridgeline (skyline peak)
      if (ridgeAngle > -Math.PI / 2 + 0.001 && peakAngle >= ridgeAngle - 0.003) {
        const ridgePos = project(bearing, ridgeAngle, cam)
        screenY = Math.min(screenY, ridgePos.y)
      }
    }

    const minSpacing = W * 0.06
    if (peakPositions.some(p => Math.abs(p.screenX - screenX) < minSpacing)) continue

    peakPositions.push({
      id:          peak.id,
      name:        peak.name,
      elevation_m: peak.elevation_m,
      dist_km:     horizDist / 1000,
      bearing:     calculateBearing({ lat: activeLat, lng: activeLng }, { lat: peak.lat, lng: peak.lng }),
      lat:         peak.lat,
      lng:         peak.lng,
      screenX,
      screenY,
    })
  }

  // ── 5. Peak ridgeline profiles — wedge-shaped terrain profiles around peaks ──
  if (showPeakLabels && peakPositions.length > 0 && skylineData) {
    renderPeakRidgelines(ctx, skylineData, projectedBands, peakPositions, cam, projectedArcs)
  }

  log.debug('Scan canvas drawn', {
    heading:      heading_deg.toFixed(1),
    pitch:        pitch_deg.toFixed(1),
    hfov:         hfov.toFixed(1),
    mode:         skylineData ? 'quick/skyline' : 'loading',
    visiblePeaks: peakPositions.length,
  })

  return peakPositions
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ScanScreen: React.FC = () => {
  const {
    heading_deg, pitch_deg, height_m, fov,
    applyARDrag, setHeightFromSlider, applyFovScale, setFov,
  } = useCameraStore()
  const { activeLat, activeLng }               = useLocationStore()
  const { peaks } = useTerrainStore()
  const { units, showPeakLabels, showBandLines, showFill, showDebugPanel } = useSettingsStore()

  const viewportRef      = useRef<HTMLDivElement>(null)
  const terrainCanvasRef = useRef<HTMLCanvasElement>(null)
  const dragState        = useRef<DragState>({ isDragging: false, lastX: 0, lastY: 0 })
  const pinchState       = useRef<PinchState>({ isPinching: false, lastDist: 0, startFov: fov })
  const sliderRef        = useRef<HTMLDivElement>(null)
  const sliderDragRef    = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })
  const zoomSliderRef    = useRef<HTMLDivElement>(null)
  const zoomDragRef      = useRef<{ isDragging: boolean; startY: number; startFov: number }>({
    isDragging: false, startY: 0, startFov: fov,
  })

  // Phase 2 infrastructure
  const skylineWorker  = useRef<Worker | null>(null)
  const rafRef         = useRef<number>(0)
  // Ref mirror of skylineData — lets the location-change effect read the latest
  // skyline without adding it to the dependency array (avoids re-triggering on completion).
  const skylineDataRef = useRef<SkylineData | null>(null)

  const [showDragHint, setShowDragHint]       = useState(true)
  const [peakPositions, setPeakPositions]     = useState<PeakScreenPos[]>([])
  const [canvasCSSSize, setCanvasCSSSize]     = useState({ w: 0, h: 0 })
  const [skylineData, setSkylineData]         = useState<SkylineData | null>(null)
  const [osmPeaks, setOsmPeaks]               = useState<Peak[]>([])
  const [isSkylineComputing, setIsSkylineComputing] = useState(false)
  const [skylineProgress, setSkylineProgress] = useState(0)
  // Refined arcs from second-pass peak refinement (separate from skylineData)
  const [refinedArcs, setRefinedArcs] = useState<RefinedArc[]>([])
  // Refinement progress: null = not refining, string = status message
  const [refineStatus, setRefineStatus] = useState<string | null>(null)

  // ── Gyroscope mode ──────────────────────────────────────────────────────
  // When active, DeviceOrientationEvent drives heading + pitch.
  // Drag gesture disables gyro (user must tap button to re-enable).
  // TODO: Use gyroscope heading as compass truth for AR overlay.
  // TODO: Smooth gyro input with low-pass filter to reduce jitter.
  // TODO: Handle iOS 13+ permission prompt (DeviceOrientationEvent.requestPermission).
  // TODO: Show brief toast when gyro is activated/deactivated.
  const [isGyroActive, setIsGyroActive] = useState(false)
  const gyroListenerRef = useRef<((e: DeviceOrientationEvent) => void) | null>(null)

  // ── Active peak set: OSM peaks when available, fallback to hardcoded ────────
  const activePeaks: Peak[] = osmPeaks.length > 0 ? osmPeaks : peaks

  // ── Re-project band angles when AGL changes (no worker round-trip) ────────
  // Recomputes ~2160 atan2 calls — sub-millisecond.
  // Uses the worker's z15-corrected ground elevation so angles match exactly.
  const projectedBands = useMemo<ProjectedBands | null>(() => {
    if (!skylineData) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectBands(skylineData, viewerElev)
  }, [skylineData, height_m])

  // ── Pre-build contour strands (full 360°, one-time on data/AGL change) ────
  // Uses the worker's z15-corrected ground elevation so contour angles match ridgelines.
  const contourStrands = useMemo<PrebuiltContourStrand[]>(() => {
    if (!skylineData) return []
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return buildContourStrands(skylineData, viewerElev)
  }, [skylineData, height_m])

  // ── Re-project refined arc angles when AGL changes ─────────────────────────
  // Uses separate refinedArcs state (from second-pass 'refine-peaks' response).
  // ~4,800 atan2 calls for 20 arcs — sub-millisecond.
  const projectedArcs = useMemo<ProjectedRefinedArc[] | null>(() => {
    if (!skylineData || refinedArcs.length === 0) return null
    const viewerElev = skylineData.computedAt.groundElev + height_m
    return reprojectRefinedArcs(refinedArcs, viewerElev)
  }, [skylineData, refinedArcs, height_m])

  // ── Initialise Web Worker ─────────────────────────────────────────────────

  useEffect(() => {
    const worker = new Worker(
      new URL('../../workers/skylineWorker.ts', import.meta.url),
      { type: 'module' },
    )

    worker.onmessage = (e: MessageEvent) => {
      const { type, phase, progress, skyline } = e.data
      if (type === 'progress') {
        if (phase === 'tiles') {
          setSkylineProgress(progress * 0.4)  // tiles = first 40%
        } else if (phase === 'skyline') {
          setSkylineProgress(0.4 + progress * 0.6)  // skyline = next 60%
        }
      } else if (type === 'complete') {
        log.info('Skyline precomputed', {
          azimuths: skyline.numAzimuths,
          lat: skyline.computedAt.lat.toFixed(4),
          lng: skyline.computedAt.lng.toFixed(4),
        })
        const newSkyline = skyline as SkylineData
        setSkylineData(newSkyline)
        skylineDataRef.current = newSkyline   // keep ref in sync for Option 2 distance check
        setIsSkylineComputing(false)
        setSkylineProgress(1)
        // Clear old refined arcs — new ones will arrive via 'refined-arcs' after peak refinement
        setRefinedArcs([])
      } else if (type === 'refine-progress') {
        // Progress from second-pass peak refinement
        const { phase: rPhase, total, done } = e.data as { phase: string; total: number; done: number }
        if (rPhase === 'tiles') {
          setRefineStatus(`Fetching detail tiles for ${total} peaks…`)
        } else {
          setRefineStatus(`Refining peaks… ${done}/${total}`)
        }
      } else if (type === 'refined-arcs') {
        // Second pass complete — worker sent back dense arc data for visible peaks
        const arcs = e.data.refinedArcs as RefinedArc[]
        log.info('Refined arcs received', {
          count: arcs.length,
          totalSamples: arcs.reduce((s: number, a: RefinedArc) => s + a.numSamples, 0),
        })
        setRefinedArcs(arcs)
        setRefineStatus(null)
      }
    }

    worker.onerror = (err) => {
      log.warn('Skyline worker error', { err: err.message })
      setIsSkylineComputing(false)
    }

    skylineWorker.current = worker
    return () => { worker.terminate() }
  }, [])

  // ── Skyline computation on location change ────────────────────────────────
  // Only the worker fetches tiles — main thread shows loading state until done.

  useEffect(() => {
    // ── Skip recompute for tiny moves (< 1.5 km) ─────────────────────────────
    // The ridgeline is virtually identical within 1.5 km, no need to re-ray-march.
    const prev = skylineDataRef.current
    if (prev) {
      const cosLat = Math.cos(activeLat * DEG_TO_RAD)
      const dx = (activeLng - prev.computedAt.lng) * 111_320 * cosLat
      const dy = (activeLat - prev.computedAt.lat) * 111_132
      if (Math.sqrt(dx * dx + dy * dy) < 1500) {
        log.debug('Skyline recompute skipped — move < 1.5 km')
        return
      }
    }

    // ── Stale-while-revalidate ────────────────────────────────────────────────
    // DO NOT clear skylineData here — old panorama stays visible while the worker
    // recomputes in background. Progress bar still shows; canvas swaps on completion.
    setSkylineProgress(0)

    const worker = skylineWorker.current
    if (!worker) return

    setIsSkylineComputing(true)

    const request: SkylineRequest = {
      viewerLat:      activeLat,
      viewerLng:      activeLng,
      viewerHeightM:  height_m,
      resolution:     SKYLINE_RESOLUTION,
      maxRange:       MAX_DIST,
    }

    worker.postMessage(request)

  }, [activeLat, activeLng])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── OSM peak fetch on location change ────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    fetchPeaksNear(activeLat, activeLng, 400)
      .then(fetched => {
        if (!cancelled) {
          setOsmPeaks(fetched)
          log.info('OSM peaks loaded', { count: fetched.length })
        }
      })
      .catch(err => log.warn('OSM peak fetch failed', { err: String(err) }))
    return () => { cancelled = true }
  }, [activeLat, activeLng])

  // ── Gyroscope: DeviceOrientation listener ────────────────────────────────
  // When gyro mode is active, listens for device orientation events and
  // updates heading + pitch to match the phone's physical orientation.
  // Cleanup removes the listener when gyro is toggled off or component unmounts.
  //
  // TODO: Add low-pass filter to smooth jittery gyro readings.
  // TODO: Handle iOS 13+ DeviceOrientationEvent.requestPermission() flow.
  // TODO: Use absolute orientation (webkitCompassHeading) when available.
  // TODO: Eventually also drive AGL from GPS altitude.
  useEffect(() => {
    if (!isGyroActive) {
      // Clean up any existing listener
      if (gyroListenerRef.current) {
        window.removeEventListener('deviceorientation', gyroListenerRef.current)
        gyroListenerRef.current = null
      }
      return
    }

    const handleOrientation = (e: DeviceOrientationEvent) => {
      // alpha = compass heading (0-360), beta = front-back tilt (-180 to 180),
      // gamma = left-right tilt (-90 to 90)
      // webkitCompassHeading is the true compass heading on iOS (alpha is relative)
      const heading = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading
        ?? (e.alpha !== null ? (360 - e.alpha) % 360 : null)
      const pitch = e.beta !== null ? clamp(e.beta - 90, -80, 80) : null

      if (heading !== null) {
        set_heading_from_gyro(heading)
      }
      if (pitch !== null) {
        set_pitch_from_gyro(pitch)
      }
    }

    // Store ref so we can remove it later
    gyroListenerRef.current = handleOrientation
    window.addEventListener('deviceorientation', handleOrientation)

    log.info('Gyroscope mode activated')

    return () => {
      window.removeEventListener('deviceorientation', handleOrientation)
      gyroListenerRef.current = null
    }
  }, [isGyroActive])

  // Direct setters for gyro-driven heading/pitch (bypass sensitivity scaling)
  const set_heading_from_gyro = useCallback((deg: number) => {
    useCameraStore.setState({ heading_deg: ((deg % 360) + 360) % 360 })
  }, [])
  const set_pitch_from_gyro = useCallback((deg: number) => {
    useCameraStore.setState({ pitch_deg: clamp(deg, -80, 80) })
  }, [])

  /**
   * Toggle gyroscope on/off.
   * On iOS 13+, DeviceOrientationEvent requires explicit permission request.
   * TODO: Show user-friendly error if permission is denied.
   */
  const toggleGyro = useCallback(async () => {
    if (isGyroActive) {
      setIsGyroActive(false)
      log.info('Gyroscope deactivated by user')
      return
    }

    // iOS 13+ requires explicit permission request
    const DeviceOrientationEventAny = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    if (typeof DeviceOrientationEventAny.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEventAny.requestPermission()
        if (permission !== 'granted') {
          log.warn('Gyroscope permission denied')
          return
        }
      } catch (err) {
        log.warn('Gyroscope permission request failed', { err: String(err) })
        return
      }
    }

    setIsGyroActive(true)
  }, [isGyroActive])

  // ── Second pass: trigger peak refinement when skyline + peaks are ready ───
  // Sends visible peak bearings/distances to the worker for dense ray-march
  // with higher-zoom tiles.  Stale-while-revalidate: old arcs stay until new ones arrive.
  useEffect(() => {
    if (!skylineData || isSkylineComputing) return
    const worker = skylineWorker.current
    if (!worker) return

    const peaks = activePeaks
    if (peaks.length === 0) return

    const viewerElev = skylineData.computedAt.groundElev + height_m
    const eyeElev = skylineData.computedAt.elev
    const vLat = skylineData.computedAt.lat
    const vLng = skylineData.computedAt.lng
    const cosLat = Math.cos(vLat * DEG_TO_RAD)

    // Build refine list from ALL visible peaks (not just top 15 on screen)
    // — the worker is fast enough to handle them all.
    const refineItems: PeakRefineItem[] = []
    for (const peak of peaks) {
      const dx = (peak.lng - vLng) * 111_320 * cosLat
      const dy = (peak.lat - vLat) * 111_132
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > MAX_PEAK_DIST || dist < 100) continue

      // Determine which band this peak falls in
      const peakDist_m = dist
      let bandIndex = -1
      for (let bi = 0; bi < DEPTH_BANDS.length; bi++) {
        const cfg = DEPTH_BANDS[bi]
        if (cfg && peakDist_m >= cfg.minDist && peakDist_m <= cfg.maxDist) {
          bandIndex = bi
          break
        }
      }
      if (bandIndex < 0) continue

      // Check peak visibility (is it above the ridgeline?)
      const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360
      const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const peakAngle = Math.atan2(peak.elevation_m - curvDrop - eyeElev, dist)
      const ridgeAngle = skylineAngleAt(skylineData, bearing, projectedBands)

      // Only refine peaks that are at least near the ridgeline
      if (peakAngle < ridgeAngle - 1 * DEG_TO_RAD) continue

      refineItems.push({
        bearing,
        distance: dist,
        bandIndex,
        name: peak.name,
      })
    }

    if (refineItems.length === 0) return

    log.info('Requesting peak refinement', { peaks: refineItems.length })
    worker.postMessage({ type: 'refine-peaks', peaks: refineItems })
  }, [skylineData, activePeaks, isSkylineComputing, projectedBands, height_m])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canvas sizing (only on resize) ────────────────────────────────────────

  const resizeCanvas = useCallback(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const dpr  = window.devicePixelRatio || 1
    const newW = Math.round(rect.width  * dpr)
    const newH = Math.round(rect.height * dpr)

    // Only reallocate the pixel buffer if the size actually changed
    if (canvas.width !== newW || canvas.height !== newH) {
      canvas.width  = newW
      canvas.height = newH
    }

    setCanvasCSSSize({ w: rect.width, h: rect.height })
  }, [])

  // ── Terrain canvas draw ────────────────────────────────────────────────────

  const redrawCanvas = useCallback(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return
    if (canvas.width === 0 || canvas.height === 0) return

    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Identity transform — drawScanCanvas works in physical pixels (canvas.width/height)
    // so we must not scale the ctx. Peak positions are divided by dpr after returning.
    ctx.setTransform(1, 0, 0, 1, 0, 0)

    const rawPos = drawScanCanvas(
      canvas,
      activePeaks,
      heading_deg, pitch_deg, height_m,
      activeLat, activeLng,
      fov, skylineData, projectedBands,
      contourStrands, projectedArcs,
      showBandLines, showFill, showPeakLabels,
    )

    setPeakPositions(rawPos.map(p => ({
      ...p,
      screenX: p.screenX / dpr,
      screenY: p.screenY / dpr,
    })))
  }, [
    heading_deg, pitch_deg, height_m, fov,
    activeLat, activeLng,
    activePeaks,
    skylineData, projectedBands, contourStrands, projectedArcs,
    showBandLines, showFill, showPeakLabels,
  ])

  // RAF-gated redraw: collapses multiple rapid state changes into one draw per frame
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      redrawCanvas()
    })
    return () => cancelAnimationFrame(rafRef.current)
  }, [redrawCanvas])

  // ── Resize observer ────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return

    const handleResize = () => {
      resizeCanvas()
      redrawCanvas()
    }

    // Initial size
    handleResize()

    const observer = new ResizeObserver(handleResize)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [resizeCanvas, redrawCanvas])

  // ── Pointer drag (heading + pitch) ────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore second finger (pinch uses touch events)
    if (e.isPrimary === false) return
    viewportRef.current?.setPointerCapture(e.pointerId)
    dragState.current = { isDragging: true, lastX: e.clientX, lastY: e.clientY }
    setShowDragHint(false)

    // Manual drag disables gyroscope — user must tap gyro button to re-enable.
    // This prevents fighting between finger input and sensor input.
    if (isGyroActive) {
      setIsGyroActive(false)
      log.info('Gyroscope deactivated by drag gesture')
    }
  }, [isGyroActive])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging || pinchState.current.isPinching) return
    const deltaX = e.clientX - dragState.current.lastX
    const deltaY = e.clientY - dragState.current.lastY
    dragState.current.lastX = e.clientX
    dragState.current.lastY = e.clientY
    applyARDrag(deltaX, deltaY)
  }, [applyARDrag])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    viewportRef.current?.releasePointerCapture(e.pointerId)
    dragState.current.isDragging = false
  }, [])

  // ── Pinch zoom (FOV) ──────────────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      pinchState.current = { isPinching: true, lastDist: dist, startFov: fov }
      dragState.current.isDragging = false
    }
  }, [fov])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchState.current.isPinching) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (pinchState.current.lastDist > 0) {
        // Pinch in (fingers apart → zoom in → narrower FOV)
        const scale = pinchState.current.lastDist / dist
        applyFovScale(scale)
      }
      pinchState.current.lastDist = dist
    }
  }, [applyFovScale])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      pinchState.current.isPinching = false
    }
  }, [])

  // ── Height slider ─────────────────────────────────────────────────────────

  const handleSliderPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    sliderRef.current?.setPointerCapture(e.pointerId)
    sliderDragRef.current = { isDragging: true, startY: e.clientY, startHeight: height_m }
  }, [height_m])

  const handleSliderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!sliderDragRef.current.isDragging) return
    const sliderEl = sliderRef.current
    if (!sliderEl) return
    const sliderHeight = sliderEl.getBoundingClientRect().height
    const deltaY       = e.clientY - sliderDragRef.current.startY
    const heightDelta  = -(deltaY / sliderHeight) * (MAX_HEIGHT_M - MIN_HEIGHT_M)
    const newHeight    = clamp(sliderDragRef.current.startHeight + heightDelta, MIN_HEIGHT_M, MAX_HEIGHT_M)
    setHeightFromSlider(metersToFeet(newHeight))
  }, [setHeightFromSlider])

  const handleSliderPointerUp = useCallback((e: React.PointerEvent) => {
    sliderRef.current?.releasePointerCapture(e.pointerId)
    sliderDragRef.current.isDragging = false
  }, [])

  // ── Zoom slider (FOV) ──────────────────────────────────────────────────────
  // Drag up = zoom in (smaller FOV), drag down = zoom out (larger FOV)

  const MIN_FOV = 15
  const MAX_FOV = 100

  const handleZoomPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    zoomSliderRef.current?.setPointerCapture(e.pointerId)
    zoomDragRef.current = { isDragging: true, startY: e.clientY, startFov: fov }
  }, [fov])

  const handleZoomPointerMove = useCallback((e: React.PointerEvent) => {
    if (!zoomDragRef.current.isDragging) return
    const el = zoomSliderRef.current
    if (!el) return
    const trackHeight = el.getBoundingClientRect().height
    const deltaY = e.clientY - zoomDragRef.current.startY
    // Drag up (negative deltaY) → smaller FOV (zoom in)
    const fovDelta = (deltaY / trackHeight) * (MAX_FOV - MIN_FOV)
    const newFov = clamp(zoomDragRef.current.startFov + fovDelta, MIN_FOV, MAX_FOV)
    setFov(newFov)
  }, [setFov])

  const handleZoomPointerUp = useCallback((e: React.PointerEvent) => {
    zoomSliderRef.current?.releasePointerCapture(e.pointerId)
    zoomDragRef.current.isDragging = false
  }, [])

  // ── FOV-aware compass sizing ──────────────────────────────────────────────
  // Each compass item = 22.5°. Scale item width so that FOV degrees = viewport width.
  const compassItemWidth = typeof window !== 'undefined'
    ? window.innerWidth * 22.5 / fov
    : COMPASS_ITEM_WIDTH

  const compassOffset = (() => {
    const headingIndex    = heading_deg / 22.5
    const centerItemIndex = headingIndex + 16
    return -(centerItemIndex * compassItemWidth)
  })()

  // ── Ground elevation for HUD ─────────────────────────────────────────────
  // Uses the worker's z15 tile-based ground elevation. Before skyline is ready,
  // we don't have a ground elevation yet — show 0 until the worker responds.
  const groundElev = skylineData
    ? skylineData.computedAt.groundElev
    : 0

  // ── Loading state ─────────────────────────────────────────────────────────

  const isLoading = isSkylineComputing
  const loadingLabel = isSkylineComputing
    ? `Computing panorama… ${Math.round(skylineProgress * 100)}%`
    : ''

  return (
    <div className={styles.screen}>
      {/* ── Compass Strip ──────────────────────────────────────────────────── */}
      <div
        className={styles.compassStrip}
        role="img"
        aria-label={`Compass: ${headingToCompass(heading_deg)} at ${Math.round(heading_deg)}°`}
      >
        <div className={styles.compassNotch} aria-hidden="true" />
        <div className={styles.headingDegrees} aria-hidden="true">
          {Math.round(heading_deg).toString().padStart(3, '0')}°
        </div>
        <div
          className={styles.compassTrack}
          style={{ transform: `translateX(calc(50vw + ${compassOffset}px))` }}
          aria-hidden="true"
        >
          {[0, 1, 2].flatMap((loop) =>
            COMPASS_DIRECTIONS.map((dir, dirIndex) => {
              const isCardinal = ['N', 'S', 'E', 'W'].includes(dir)
              return (
                <div key={`${loop}-${dirIndex}`} className={styles.compassItem} style={{ width: `${compassItemWidth}px` }}>
                  <span className={`${styles.compassLabel} ${isCardinal ? styles.cardinal : ''}`}>
                    {dir}
                  </span>
                  <div className={`${styles.compassTick} ${isCardinal ? styles.cardinalTick : ''}`} />
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── Terrain Viewport ───────────────────────────────────────────────── */}
      <div
        ref={viewportRef}
        className={styles.viewport}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        role="application"
        aria-label="Terrain view — drag to look around, pinch to zoom"
      >
        <canvas
          ref={terrainCanvasRef}
          className={styles.terrainCanvas}
          aria-hidden="true"
        />

        {/* Peak labels */}
        {showPeakLabels && peakPositions.length > 0 && (
          <div className={styles.peakLabelsLayer} aria-label="Peak labels">
            {peakPositions.map((pos) => (
              <PeakLabel
                key={pos.id}
                pos={pos}
                units={units}
                canvasH={canvasCSSSize.h}
              />
            ))}
          </div>
        )}

        {/* Loading overlay */}
        {isLoading && (
          <div className={styles.loadingOverlay} role="status" aria-live="polite">
            <div className={styles.loadingBar}>
              <div
                className={styles.loadingFill}
                style={{ width: `${Math.round(skylineProgress * 100)}%` }}
              />
            </div>
            <span className={styles.loadingLabel}>{loadingLabel}</span>
            <span className={styles.loadingLabel} style={{ marginTop: 4 }}>v1.0.4-MVP</span>
          </div>
        )}

        {/* Refinement progress indicator — shown while second-pass peak refinement runs */}
        {refineStatus && !isLoading && (
          <div style={{
            position: 'absolute', bottom: 70, left: '50%', transform: 'translateX(-50%)',
            color: 'rgba(104, 176, 191, 0.85)', fontSize: 11, fontFamily: 'monospace',
            background: 'rgba(0,0,0,0.5)', padding: '4px 12px',
            borderRadius: 10, zIndex: 100, whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}>
            {refineStatus}
          </div>
        )}

        {/* DEBUG: Comprehensive diagnostics panel */}
        {showDebugPanel && skylineData && (
          <div style={{
            position: 'absolute', top: 58, right: 44,
            color: '#0f0', fontSize: 9, fontFamily: 'monospace',
            background: 'rgba(0,0,0,0.8)', padding: '6px 10px',
            borderRadius: 4, zIndex: 9999, lineHeight: 1.4,
            pointerEvents: 'none', maxWidth: 280,
          }}>
            {(() => {
              const canvasW = terrainCanvasRef.current?.width || 0
              const canvasH = terrainCanvasRef.current?.height || 0
              const horizY = getHorizonY({ heading_deg, pitch_deg, hfov: fov, W: canvasW, H: canvasH })
              const pxPerDegH = canvasW ? (canvasW / (fov * DEG_TO_RAD)).toFixed(1) : '?'
              const pxPerDegV = canvasW ? (canvasW / (fov * DEG_TO_RAD)).toFixed(1) : '?'
              const gElev = skylineData.computedAt.groundElev
              const eyeElev = gElev + height_m

              // Azimuth spacing: how many screen pixels per azimuth sample
              const pxPerAzStd = canvasW ? (canvasW / (fov * skylineData.resolution)).toFixed(1) : '?'
              const pxPerAzHi  = canvasW ? (canvasW / (fov * 4)).toFixed(1) : '?'

              // Geometric horizon at current AGL
              const horizonDist = Math.sqrt(2 * EARTH_R * height_m) / 1000  // km

              // Re-projection validation
              let maxAngleDiff = 0
              if (projectedBands && skylineData) {
                for (let i = 0; i < skylineData.numAzimuths; i++) {
                  const diff = Math.abs(projectedBands.overallAngles[i] - skylineData.angles[i])
                  if (diff > maxAngleDiff) maxAngleDiff = diff
                }
              }
              const angleDiffDeg = (maxAngleDiff * 180 / Math.PI).toFixed(4)
              const angleDiffOk = maxAngleDiff < 0.001

              // Per-band stats (using per-band resolution)
              const bandStats = skylineData.bands.map((band, bi) => {
                const bandAz = band.numAzimuths
                let active = 0, eMin = Infinity, eMax = -Infinity, dMin = Infinity, dMax = -Infinity
                for (let i = 0; i < bandAz; i++) {
                  if (band.elevations[i] > -Infinity) {
                    active++
                    if (band.elevations[i] < eMin) eMin = band.elevations[i]
                    if (band.elevations[i] > eMax) eMax = band.elevations[i]
                    if (band.distances[i] < dMin) dMin = band.distances[i]
                    if (band.distances[i] > dMax) dMax = band.distances[i]
                  }
                }
                // Center-of-view angle for this band (use band's own resolution)
                const normB = ((heading_deg % 360) + 360) % 360
                const centerIdx = Math.round(normB * band.resolution) % bandAz
                const centerAngle = projectedBands
                  ? projectedBands.bandAngles[bi][centerIdx]
                  : (band.elevations[centerIdx] > -Infinity
                    ? Math.atan2(band.elevations[centerIdx] - (band.distances[centerIdx] * band.distances[centerIdx]) / (2 * EARTH_R) * (1 - REFRACTION_K) - skylineData.computedAt.elev, band.distances[centerIdx])
                    : -Math.PI / 2)
                return { label: DEPTH_BANDS[bi]?.label || `band${bi}`, active, bandAz, bandRes: band.resolution, eMin, eMax, dMin, dMax, centerAngle }
              })

              const elevMismatch = projectedBands
                ? Math.abs(skylineData.computedAt.elev - projectedBands.viewerElev)
                : 0

              // Peak funnel
              const totalPeaks = (osmPeaks.length > 0 ? osmPeaks : peaks).length

              return (
                <>
                  <div style={{ color: '#A7DDE5', marginBottom: 2 }}>v2.2.1 DEBUG — Refined Arcs</div>

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>CAMERA</div>
                  <div>hdg:{heading_deg.toFixed(1)}° pit:{pitch_deg.toFixed(1)}° fov:{fov.toFixed(0)}°</div>
                  <div>horizonY:{horizY.toFixed(0)}px  px/rad H:{pxPerDegH} V:{pxPerDegV}</div>
                  <div>AGL:{height_m.toFixed(0)}m  ground:{gElev.toFixed(0)}m  eye:{eyeElev.toFixed(0)}m</div>
                  <div>interp:ON  az:{pxPerAzStd}px/std {pxPerAzHi}px/hi</div>
                  <div>horizon:{horizonDist.toFixed(0)}km (geometric)</div>

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>RE-PROJECTION</div>
                  <div style={{ color: angleDiffOk ? '#0f0' : '#f44' }}>
                    max Δangle: {angleDiffDeg}° {angleDiffOk ? '✓' : '⚠ MISMATCH'}
                  </div>
                  <div>worker elev: {skylineData.computedAt.elev.toFixed(0)}m</div>
                  {projectedBands && <div>reproj elev: {projectedBands.viewerElev.toFixed(0)}m</div>}
                  <div style={{ color: elevMismatch > 50 ? '#f44' : elevMismatch > 10 ? '#fa0' : '#0f0' }}>
                    Δelev: {elevMismatch.toFixed(0)}m {elevMismatch > 50 ? '⚠ BIG' : ''}
                  </div>

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>BANDS ({bandStats.length})</div>
                  {(() => {
                    // Global elev range for debug color preview
                    let gMin = Infinity, gMax = -Infinity
                    for (const bs of bandStats) {
                      if (bs.active > 0) {
                        if (bs.eMin < gMin) gMin = bs.eMin
                        if (bs.eMax > gMax) gMax = bs.eMax
                      }
                    }
                    const gRange = gMax - gMin
                    return bandStats.map((bs, i) => {
                      const bandCfg = DEPTH_BANDS[i]
                      const rangeStr = bandCfg ? `[${(bandCfg.minDist/1000).toFixed(0)}–${(bandCfg.maxDist/1000).toFixed(0)}km]` : ''
                      const resLabel = bs.bandRes > SKYLINE_RESOLUTION ? ' hi' : ''
                      // Palette-derived color: use band's center elevation mapped through RIDGE_PALETTE
                      const bandT = bandStats.length <= 1 ? 1 : 1 - i / (bandStats.length - 1)
                      const centerElev = bs.active > 0 ? (bs.eMin + bs.eMax) / 2 : 0
                      const tElev = gRange > 1 && bs.active > 0 ? (centerElev - gMin) / gRange : 0.5
                      const bandColor = bs.active === 0 ? '#666' : elevToRidgeColor(Math.min(1, tElev + 0.2))
                      const bStyle = bandStyleForIndex(i, bandStats.length)
                      return (
                        <div key={bs.label} style={{ color: bandColor }}>
                          {bs.label} {rangeStr}: {bs.active}/{bs.bandAz}az{resLabel} lw:{bStyle.lineWidthNear.toFixed(0)}→{bStyle.lineWidthFar.toFixed(0)}px c:{Math.round((CONTOUR_INTERVALS_M[i] || 0) / 0.3048)}ft
                          {bs.active > 0 && (
                            <>
                              {' '}∠{(bs.centerAngle * 180 / Math.PI).toFixed(2)}°
                              {' '}e:{bs.eMin.toFixed(0)}–{bs.eMax.toFixed(0)}m
                              {' '}d:{(bs.dMin/1000).toFixed(1)}–{(bs.dMax/1000).toFixed(1)}km
                            </>
                          )}
                        </div>
                      )
                    })
                  })()}

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>REFINED ARCS (2nd pass)</div>
                  {(() => {
                    if (refinedArcs.length === 0) return <div style={{ color: '#666' }}>none (awaiting peaks)</div>
                    const matchedCount = projectedArcs ? projectedArcs.length : 0
                    const totalSamples = refinedArcs.reduce((sum, a) => sum + a.numSamples, 0)
                    return (
                      <>
                        <div>peaks:{refinedArcs.length} samples:{totalSamples} projected:{matchedCount}</div>
                        {refinedArcs.slice(0, 8).map((arc, i) => {
                          const bandLabel = DEPTH_BANDS[arc.bandIndex]?.label || `b${arc.bandIndex}`
                          return (
                            <div key={i} style={{ color: '#ccc', fontSize: 8 }}>
                              {bandLabel} {arc.centerBearing.toFixed(1)}°±{arc.halfWidth}° d:{(arc.featureDist/1000).toFixed(1)}km e:{arc.featureElev.toFixed(0)}m
                            </div>
                          )
                        })}
                        {refinedArcs.length > 8 && <div style={{ color: '#666', fontSize: 8 }}>...+{refinedArcs.length - 8} more</div>}
                      </>
                    )
                  })()}

                  <div style={{ color: '#68B0BF', marginTop: 3 }}>PEAKS</div>
                  <div>total:{totalPeaks} → visible:{peakPositions.length} (r≤{MAX_PEAK_DIST/1000}km)</div>
                  {peakPositions.slice(0, 3).map(p => (
                    <div key={p.id} style={{ color: '#ccc', fontSize: 8 }}>
                      {p.name}: {p.bearing.toFixed(0)}° {p.dist_km.toFixed(0)}km x:{p.screenX.toFixed(0)} y:{p.screenY.toFixed(0)}
                    </div>
                  ))}
                </>
              )
            })()}
          </div>
        )}

        {/* Zoom slider (FOV control) */}
        <ZoomSlider
          fov={fov}
          sliderRef={zoomSliderRef}
          onPointerDown={handleZoomPointerDown}
          onPointerMove={handleZoomPointerMove}
          onPointerUp={handleZoomPointerUp}
        />

        {/* Drag hint — updates to mention gyro when available */}
        <div
          className={`${styles.dragHint} ${!showDragHint ? styles.hidden : ''}`}
          aria-hidden="true"
        >
          ← Drag to look around — Pinch to zoom →
        </div>

        {/* Gyroscope toggle button — activates device orientation tracking.
            When active (highlighted), heading + pitch follow the phone's sensors.
            Dragging automatically disables gyro; tap button to re-enable.
            TODO: Show compass indicator when gyro is active.
            TODO: Add smooth transition when switching between drag and gyro input.
            TODO: Eventually integrate with GPS altitude for automatic AGL. */}
        <button
          className={`${styles.gyroBtn} ${isGyroActive ? styles.gyroBtnActive : ''}`}
          onClick={toggleGyro}
          aria-label={isGyroActive ? 'Disable gyroscope control' : 'Enable gyroscope control'}
          title={isGyroActive ? 'Gyro ON — drag to disable' : 'Enable Gyroscope'}
        >
          {/* Compass/gyro icon */}
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="10" cy="10" r="7" />
            <circle cx="10" cy="10" r="2" fill="currentColor" stroke="none" />
            <line x1="10" y1="1" x2="10" y2="5" />
            <line x1="10" y1="15" x2="10" y2="19" />
            <line x1="1" y1="10" x2="5" y2="10" />
            <line x1="15" y1="10" x2="19" y2="10" />
          </svg>
          {isGyroActive && <span className={styles.gyroBtnLabel}>GYRO</span>}
        </button>
      </div>

      {/* ── Height Slider ──────────────────────────────────────────────────── */}
      <div className={styles.heightSlider} aria-label="View height slider">
        <span className={styles.heightSliderLabel}>HIGH</span>
        <div
          ref={sliderRef}
          className={styles.heightSliderTrack}
          onPointerDown={handleSliderPointerDown}
          onPointerMove={handleSliderPointerMove}
          onPointerUp={handleSliderPointerUp}
          onPointerCancel={handleSliderPointerUp}
          role="slider"
          aria-label="Eye height above ground"
          aria-valuemin={Math.round(metersToFeet(MIN_HEIGHT_M))}
          aria-valuemax={Math.round(metersToFeet(MAX_HEIGHT_M))}
          aria-valuenow={Math.round(metersToFeet(height_m))}
        >
          <div
            className={styles.heightSliderFill}
            style={{ height: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            aria-hidden="true"
          />
          <div
            className={styles.heightSliderThumb}
            style={{ bottom: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%` }}
            aria-hidden="true"
          />
        </div>
        <span className={styles.heightSliderLabel}>LOW</span>
        <span className={styles.heightSliderValue}>
          {units === 'imperial'
            ? `${Math.round(metersToFeet(height_m))}ft`
            : `${Math.round(height_m)}m`}
        </span>
      </div>

      {/* ── HUD Bar ────────────────────────────────────────────────────────── */}
      <HUDBar
        heading_deg={heading_deg}
        lat={activeLat}
        lng={activeLng}
        groundElev_m={groundElev}
        eyeHeight_m={height_m}
        units={units}
        skylineReady={skylineData !== null}
      />
    </div>
  )
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

const PeakLabel: React.FC<{
  pos: PeakScreenPos
  units: 'imperial' | 'metric'
  canvasH: number
}> = ({ pos, units, canvasH }) => {
  const distFade  = Math.max(0.25, 1 - Math.pow(pos.dist_km / (MAX_PEAK_DIST / 1000), 0.5))
  const isNearTop = pos.screenY < canvasH * 0.22

  const card = (
    <div className={styles.peakCard} aria-hidden="true">
      <span className={styles.peakName}>{pos.name}</span>
      <span className={styles.peakElev}>{formatElevation(pos.elevation_m, units)}</span>
      <span className={styles.peakBearing}>
        {headingToCompass(pos.bearing)} · {pos.dist_km.toFixed(0)} km
      </span>
    </div>
  )

  // Anchor the dot center at pos.screenY regardless of card content height.
  // Normal (dot at bottom): use `bottom` so card+line grow upward naturally.
  // Flipped (dot at top): use `top` so line+card grow downward.
  const DOT_HALF = 4  // half of the 8px peakDot
  const posStyle: React.CSSProperties = isNearTop
    ? { left: `${pos.screenX}px`, top: `${pos.screenY - DOT_HALF}px`, opacity: distFade }
    : { left: `${pos.screenX}px`, bottom: `${canvasH - pos.screenY - DOT_HALF}px`, opacity: distFade }

  return (
    <div
      className={`${styles.peakLabel} ${isNearTop ? styles.peakLabelFlipped : ''}`}
      style={posStyle}
      role="img"
      aria-label={`${pos.name}, ${formatElevation(pos.elevation_m, units)}, ${pos.dist_km.toFixed(0)} km`}
    >
      {isNearTop ? (
        <>
          <div className={styles.peakDot}              aria-hidden="true" />
          <div className={`${styles.peakLine} ${styles.peakLineDown}`} aria-hidden="true" />
          {card}
        </>
      ) : (
        <>
          {card}
          <div className={styles.peakLine}  aria-hidden="true" />
          <div className={styles.peakDot}   aria-hidden="true" />
        </>
      )}
    </div>
  )
}

/** Vertical zoom slider on the left edge — controls FOV (drag up = zoom in). */
const ZoomSlider: React.FC<{
  fov: number
  sliderRef: React.RefObject<HTMLDivElement>
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp:   (e: React.PointerEvent) => void
}> = ({ fov, sliderRef, onPointerDown, onPointerMove, onPointerUp }) => {
  // Map FOV 15°–100° → marker position: 15° (zoomed in) = top, 100° (zoomed out) = bottom
  const pct = ((fov - 15) / (100 - 15)) * 100
  // Zoom multiplier relative to default 60° FOV
  const zoomX = (60 / fov).toFixed(1)

  return (
    <div className={styles.zoomSlider} aria-hidden="true">
      <span className={styles.zoomLabel}>+</span>
      <div
        ref={sliderRef as React.RefObject<HTMLDivElement>}
        className={styles.zoomTrack}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="slider"
        aria-label="Zoom level"
        aria-valuemin={15}
        aria-valuemax={100}
        aria-valuenow={Math.round(fov)}
      >
        <div className={styles.zoomMarker} style={{ top: `${pct}%` }} />
      </div>
      <span className={styles.zoomLabel}>−</span>
      <span className={styles.zoomValue}>{zoomX}×</span>
    </div>
  )
}

interface HUDBarProps {
  heading_deg: number
  lat: number
  lng: number
  groundElev_m: number
  eyeHeight_m: number
  units: 'imperial' | 'metric'
  skylineReady: boolean
}

const HUDBar: React.FC<HUDBarProps> = ({
  heading_deg, lat, lng, groundElev_m, eyeHeight_m, units, skylineReady,
}) => {
  const headingStr = `${Math.round(heading_deg).toString().padStart(3, '0')}°`
  const latStr     = `${lat.toFixed(4)}°`
  const lngStr     = `${Math.abs(lng).toFixed(4)}°${lng < 0 ? 'W' : 'E'}`
  const elevStr    = formatElevation(groundElev_m, units)
  const eyeStr     = formatElevation(eyeHeight_m, units)

  return (
    <div className={styles.hud} role="status" aria-label="Navigation data readout">
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>HDG</span>
        <span className={styles.hudValue}>{headingStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>LAT</span>
        <span className={styles.hudValue}>{latStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>LONG</span>
        <span className={styles.hudValue}>{lngStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>ELEV</span>
        <span className={styles.hudValue}>{elevStr}</span>
      </div>
      <div className={styles.hudDivider} aria-hidden="true" />
      <div className={styles.hudItem}>
        <span className={styles.hudLabel}>AGL</span>
        <span className={styles.hudValue}>{eyeStr}</span>
      </div>
      {skylineReady && (
        <>
          <div className={styles.hudDivider} aria-hidden="true" />
          <div className={styles.hudItem}>
            <span className={`${styles.hudValue} ${styles.hudReady}`}>250KM</span>
          </div>
        </>
      )}
    </div>
  )
}

export default ScanScreen
