/**
 * Shared pure rendering functions for SCAN-based views.
 *
 * Extracted from ScanScreen.tsx so B2WrapScreen (and future views) can reuse
 * the same projection, terrain rendering, contour rendering, and re-projection
 * logic without duplicating 1000+ lines of code.
 *
 * All functions are stateless — they take data in and produce output.
 * No React, no stores, no side effects.
 */

import type { SkylineData, SkylineBand, RefinedArc } from '../../core/types'
import { DEPTH_BANDS } from '../../core/types'

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_DIST          = 400_000     // Maximum render distance (m)
export const MAX_PEAK_DIST     = 400_000     // Max distance for peak label display (m)
export const EARTH_R           = 6_371_000   // Earth radius (m)
export const REFRACTION_K      = 0.13        // Atmospheric refraction coefficient
export const DEG_TO_RAD        = Math.PI / 180
export const OCEAN_ELEV_M      = 5           // Elevations below this are ocean (matches worker threshold)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CameraParams {
  heading_deg: number
  pitch_deg:   number
  hfov:        number
  W:           number   // Physical pixels (canvas.width)
  H:           number   // Physical pixels (canvas.height)
  scale?:      number   // Visual size multiplier (defaults to 1)
}

export interface ProjectedBands {
  bandAngles: Float32Array[]
  overallAngles: Float32Array
  viewerElev: number
}

export interface ProjectedRefinedArc {
  angles: Float32Array
  arc: RefinedArc
}

export interface PeakScreenPos {
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

export interface PrebuiltContourStrand {
  level:    number
  bandIdx:  number
  interval: number
  points:   Array<{ bearingDeg: number; elevAngleRad: number; dist: number }>
}

// ─── Re-Projection ───────────────────────────────────────────────────────────

export function reprojectBands(
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

      const overallIdx = Math.round((ai / bandRes) * skyline.resolution) % numAzimuths
      if (angles[ai] > overallAngles[overallIdx]) {
        overallAngles[overallIdx] = angles[ai]
      }
    }

    bandAngles.push(angles)
  }

  return { bandAngles, overallAngles, viewerElev }
}

export function reprojectRefinedArcs(
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

// ─── Contour Strand Precomputation ──────────────────────────────────────────

const CONTOUR_INTERVALS_M: number[] = [15.24, 30.48, 60.96, 152.4, 304.8, 609.6]

export function buildContourStrands(
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

    const maxAzGap = Math.ceil(bandRes * 2)

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
        const azCrossings: Array<{ elev: number; dist: number; dir: number }> = []
        for (let j = start; j < end; j += 5) {
          azCrossings.push({ elev: data[j], dist: data[j + 1], dir: data[j + 4] })
        }
        azCrossings.sort((a, b) => a.dist - b.dist)

        let runningMaxAngle = -Math.PI / 2
        const useOcclusion = bi >= 3
        for (const c of azCrossings) {
          const curvDrop = (c.dist * c.dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
          const angle = Math.atan2(c.elev - curvDrop - viewerElev, c.dist)

          if (useOcclusion && angle <= runningMaxAngle) continue
          if (useOcclusion) runningMaxAngle = angle

          // Skip ocean / near-sea-level elevation — avoids coastline artifacts
          if (c.elev < OCEAN_ELEV_M) continue

          const snappedLevel = Math.round(c.elev / interval) * interval
          const levelKey = `${snappedLevel}_${c.dir > 0 ? 'u' : 'd'}`

          let strands = activeStrands.get(levelKey)
          if (!strands) {
            strands = []
            activeStrands.set(levelKey, strands)
          }

          const maxDistDiff = bi <= 1
            ? Math.max(10, c.dist * 0.02)
            : bi === 2
            ? Math.max(50, c.dist * 0.03)
            : Math.max(200, c.dist * 0.05)
          let bestIdx = -1
          let bestDiff = Infinity
          for (let si = 0; si < strands.length; si++) {
            const s = strands[si]
            if (s.lastAi === ai) continue
            if (ai - s.lastAi > maxAzGap) continue
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

// ─── The Camera — Single Source of Truth ──────────────────────────────────────

export function project(
  bearingDeg: number,
  elevAngleRad: number,
  cam: CameraParams,
): { x: number; y: number } {
  const hfovRad  = cam.hfov * DEG_TO_RAD
  const pitchRad = cam.pitch_deg * DEG_TO_RAD

  const pxPerRad = cam.W / hfovRad

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

export function getHorizonY(cam: CameraParams): number {
  const pxPerRad = cam.W / (cam.hfov * DEG_TO_RAD)
  const pitchRad = cam.pitch_deg * DEG_TO_RAD
  return cam.H * 0.5 - pitchRad * pxPerRad
}

// ─── World → Screen Projection ───────────────────────────────────────────────

export function worldToBearingElev(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
): { bearingDeg: number; elevAngleRad: number; horizDist: number } | null {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)
  const dx_east  = (lng - viewerLng) * 111_320 * cosLat
  const dy_north = (lat - viewerLat) * 111_132
  const horizDist = Math.sqrt(dx_east * dx_east + dy_north * dy_north)
  if (horizDist < 10) return null

  const bearingDeg = ((Math.atan2(dx_east, dy_north) * 180 / Math.PI) + 360) % 360
  const curvDrop     = (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const corrElev     = elev - curvDrop
  const dz_up        = corrElev - viewerElev
  const elevAngleRad = Math.atan2(dz_up, horizDist)

  return { bearingDeg, elevAngleRad, horizDist }
}

export function projectFirstPerson(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
  cam: CameraParams,
): { screenX: number; screenY: number; horizDist: number } | null {
  const world = worldToBearingElev(lat, lng, elev, viewerLat, viewerLng, viewerElev)
  if (!world) return null
  const { x, y } = project(world.bearingDeg, world.elevAngleRad, cam)
  return { screenX: x, screenY: y, horizDist: world.horizDist }
}

// ─── Band Data Lookups ───────────────────────────────────────────────────────

export function skylineAngleAt(
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

export function bandAngleAt(
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

export function bandElevAt(
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

export function bandDistAt(
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
  if (band.elevations[idx0] === -Infinity && band.elevations[idx1] === -Infinity) return 0
  if (band.elevations[idx0] === -Infinity) return d1
  if (band.elevations[idx1] === -Infinity) return d0
  return d0 * (1 - t) + d1 * t
}

// ─── Elevation → Palette Color ──────────────────────────────────────────────

const RIDGE_PALETTE: [number, number, number][] = [
  [14,  57,  81],
  [18,  75, 107],
  [33,  92, 121],
  [47, 109, 135],
  [75, 142, 163],
  [104, 176, 191],
]

export function elevToRidgeColor(tElev: number): string {
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

// ─── Depth Band Visual Parameters ───────────────────────────────────────────

export interface BandStyle {
  fillColor:      string
  strokeColor:    string
  lineWidthNear:  number
  lineWidthFar:   number
}

const BAND_LINE_WIDTHS: [number, number][] = [
  [5, 4.5],
  [4.5, 3.5],
  [3.5, 3],
  [3, 2.5],
  [2.5, 2],
  [2, 1],
]

export function bandStyleForIndex(bandIndex: number, bandCount: number): BandStyle {
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

// ─── Terrain Renderer ───────────────────────────────────────────────────────

export function renderTerrain(
  ctx: CanvasRenderingContext2D,
  skyline: SkylineData,
  cam: CameraParams,
  projected: ProjectedBands | null,
  showBandLines: boolean = true,
  showFill: boolean = true,
): void {
  const { W, H } = cam
  const scale = cam.scale ?? 1
  const numBands = skyline.bands.length

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

  const SEGMENT_SIZES = [3, 4, 6, 12, 24, 48].map(s => Math.round(s * scale))

  for (let bi = numBands - 1; bi >= 0; bi--) {
    const style = bandStyleForIndex(bi, numBands)
    const bandCfg = DEPTH_BANDS[bi]
    const segSize = SEGMENT_SIZES[bi] ?? 24

    const lwMin = bandCfg ? bandCfg.minDist : 0
    const lwMax = bandCfg ? bandCfg.maxDist : 1
    const lwRange = lwMax - lwMin

    // ── Fill below this band's ridgeline
    ctx.beginPath()
    ctx.moveTo(0, H)
    let hasVisiblePixels = false

    for (let col = 0; col < W; col++) {
      const bearingDeg = cam.heading_deg + (col / W - 0.5) * cam.hfov
      const angle = bandAngleAt(skyline, bi, bearingDeg, projected)

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

    // ── Ridgeline stroke
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
          const elev = bandElevAt(skyline, bi, bearingDeg)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange
            : 0.5
          const dist = bandDistAt(skyline, bi, bearingDeg)
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          ctx.lineWidth = (style.lineWidthNear + tDist * (style.lineWidthFar - style.lineWidthNear)) * scale
          ctx.beginPath()
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(col, clampedY)
          segStartCol = col
        } else if (col - segStartCol >= segSize) {
          ctx.lineTo(col, clampedY)
          ctx.stroke()

          const elev = bandElevAt(skyline, bi, bearingDeg)
          const tElev = hasElevRange && elev > -Infinity
            ? (elev - globalElevMin) / elevRange
            : 0.5
          const dist = bandDistAt(skyline, bi, bearingDeg)
          const tDist = lwRange > 0 ? Math.max(0, Math.min(1, (dist - lwMin) / lwRange)) : 0
          ctx.lineWidth = (style.lineWidthNear + tDist * (style.lineWidthFar - style.lineWidthNear)) * scale
          ctx.beginPath()
          ctx.strokeStyle = elevToRidgeColor(tElev)
          ctx.moveTo(col, clampedY)
          segStartCol = col
        } else {
          ctx.lineTo(col, clampedY)
        }
      }

      if (segStartCol >= 0) ctx.stroke()
    }
  }
}

// ─── Contour Line Renderer ──────────────────────────────────────────────────

export function renderContours(
  ctx: CanvasRenderingContext2D,
  strands: PrebuiltContourStrand[],
  cam: CameraParams,
  globalElevMin: number,
  globalElevMax: number,
  skyline?: SkylineData,
  projected?: ProjectedBands | null,
): void {
  const { W, H } = cam
  const scale = cam.scale ?? 1
  const elevRange = globalElevMax - globalElevMin
  const hasElevRange = elevRange > 1

  const MAX_D = 400_000
  const WIDTH_MIN = 0.5 * scale
  const WIDTH_MAX = 5 * scale
  const WIDTH_RANGE = WIDTH_MAX - WIDTH_MIN
  const WIDTH_POWER = 0.2

  const CONTOUR_OPACITIES = [0.65, 0.55, 0.45, 0.35, 0.25, 0.15]

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
        if (pathStarted) { ctx.stroke(); pathStarted = false }
        continue
      }

      const tDist = Math.min(1, pt.dist / MAX_D)
      const lw = WIDTH_MIN + WIDTH_RANGE * (1 - Math.pow(tDist, WIDTH_POWER))

      if (!pathStarted) {
        ctx.lineWidth = lw
        currentWidth = lw
        ctx.beginPath()
        ctx.moveTo(x, y)
        pathStarted = true
      } else if (Math.abs(lw - currentWidth) > currentWidth * WIDTH_FLUSH_RATIO) {
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

// ─── Peak Visibility ────────────────────────────────────────────────────────

const NEAR_PEAK_DIST = 50_000

export function isPeakVisible(
  peak: { lat: number; lng: number; elevation_m: number },
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

  const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

  let angleDiff = bearing - heading_deg
  if (angleDiff > 180) angleDiff -= 360
  if (angleDiff < -180) angleDiff += 360
  if (Math.abs(angleDiff) > hfov * 0.5) return false

  const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const peakAngle = Math.atan2(peak.elevation_m - curvDrop - viewerElev, dist)

  const ridgeAngle = skylineAngleAt(skyline, bearing, projected)
  const tolerance = 0.15 * DEG_TO_RAD

  if (peakAngle >= ridgeAngle - tolerance) return true

  if (dist <= NEAR_PEAK_DIST) {
    let occluded = false
    for (let bi = 0; bi < skyline.bands.length; bi++) {
      const bandCfg = DEPTH_BANDS[bi]
      if (!bandCfg || bandCfg.minDist >= dist) continue
      const bAngle = bandAngleAt(skyline, bi, bearing, projected)
      if (bAngle > -Math.PI / 2 + 0.001 && peakAngle < bAngle - tolerance) {
        occluded = true
        break
      }
    }
    if (!occluded) return true
  }

  return false
}

// ─── Sky Gradient + Stars ───────────────────────────────────────────────────

export function drawSkyAndStars(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0,    '#000810')
  skyGrad.addColorStop(0.20, '#020c18')
  skyGrad.addColorStop(0.50, '#051520')
  skyGrad.addColorStop(0.78, '#071a2a')
  skyGrad.addColorStop(0.90, '#0c2235')
  skyGrad.addColorStop(1.0,  '#0f2c42')
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

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
}

// ─── Horizon Glow ───────────────────────────────────────────────────────────

export function drawHorizonGlow(
  ctx: CanvasRenderingContext2D,
  cam: CameraParams,
): void {
  const horizonY = getHorizonY(cam)
  const { W } = cam
  const g = Math.round(12 * (cam.scale ?? 1))

  const glowGrad = ctx.createLinearGradient(0, horizonY - g, 0, horizonY + g)
  glowGrad.addColorStop(0,   'rgba(132, 209, 219, 0)')
  glowGrad.addColorStop(0.5, 'rgba(132, 209, 219, 0.22)')
  glowGrad.addColorStop(1,   'rgba(132, 209, 219, 0)')
  ctx.fillStyle = glowGrad
  ctx.fillRect(0, Math.round(horizonY - g), W, 2 * g)

  ctx.fillStyle = 'rgba(132, 209, 219, 0.18)'
  ctx.fillRect(0, Math.round(horizonY), W, 1)
}
