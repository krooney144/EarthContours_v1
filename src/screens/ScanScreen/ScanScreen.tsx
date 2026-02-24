/**
 * EarthContours — SCAN Screen
 *
 * First-person AR terrain view. Two rendering passes on a single canvas:
 *
 *  Pass 1 — Ray-height-field silhouette
 *    Classic heightmap algorithm (per-column ray march). Fills terrain with
 *    ocean-depth color gradient; near = bright/saturated, far = dark/muted.
 *
 *  Pass 2 — First-person projected contour lines
 *    Runs marching squares on the elevation mesh (same algorithm as EXPLORE),
 *    then projects each segment endpoint from world-space lat/lng/elev into
 *    first-person screen coordinates using the viewer's heading, pitch, and
 *    eye elevation. Applies atmospheric perspective (distance fade + blue-shift).
 *
 * Projection math (ENU → camera → screen):
 *   1. dx_east, dy_north in meters from viewer position
 *   2. Rotate by heading → cam_forward (depth), cam_right (lateral)
 *   3. azimuth = atan2(cam_right, cam_forward)
 *   4. elevation_angle = atan2(dz_up, horiz_dist)
 *   5. screenX = cx + azimuth * (W / hfovRad)
 *   6. screenY = horizonY − elevation_angle * (H / vfovRad)
 *
 * TerrainProvider:
 *   The renderer only calls `sampleHeight(lat, lon)` — never touches tile
 *   URLs or IndexedDB. Swap the provider in `src/data/TerrainProvider.ts`
 *   to change the elevation backend without touching this file.
 *
 * Layout:
 * ┌─────────────────────────────────────────────┐
 * │ Compass Strip (top, fixed)                  │
 * │─────────────────────────────────────────────│
 * │                                       │     │
 * │    Terrain Viewport (canvas + labels) │Sldr │
 * │    Drag left/right  → heading         │     │
 * │    Drag up/down     → pitch           │     │
 * │─────────────────────────────────────────────│
 * │ HUD: HDG | LAT | LONG | ELEV | VIEWPT AGL  │
 * └─────────────────────────────────────────────┘
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCameraStore, useLocationStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import {
  COMPASS_DIRECTIONS, COMPASS_ITEM_WIDTH,
  MAX_HEIGHT_M, MIN_HEIGHT_M, PALETTE,
} from '../../core/constants'
import {
  formatElevation, calculateBearing, haversineDistance,
  headingToCompass, clamp, metersToFeet,
} from '../../core/utils'
import { marchingSquares } from '../../renderer/marchingSquares'
import type { Peak, TerrainMeshData } from '../../core/types'
import styles from './ScanScreen.module.css'

const log = createLogger('SCREEN:SCAN')

// ─── Constants ────────────────────────────────────────────────────────────────

const HFOV         = 70          // Horizontal field of view (degrees)
const VFOV         = 60          // Vertical field of view (degrees)
const MAX_DIST     = 120_000     // Max render distance (metres) — typical region extent
const MAX_PEAK_DIST = 80_000     // Max distance for peak label rendering (metres)
const EARTH_R      = 6_371_000   // Earth radius (metres) — for curvature correction
const REFRACTION_K = 0.13        // Standard atmospheric refraction coefficient
const DEG_TO_RAD   = Math.PI / 180

// Pre-computed logarithmic ray-march distances, far→near order.
// 1.5% step growth from 100m → 120km: ~476 steps.
// This gives fine detail near the viewer (2m steps at 100m) and
// coarser sampling far away (1.8km steps at 120km), matching human visual acuity.
const RAY_DISTANCES: Float32Array = (() => {
  const arr: number[] = []
  let d = 100
  while (d <= MAX_DIST) {
    arr.push(d)
    d *= 1.015
  }
  arr.reverse()  // Process far→near so nearer terrain paints over farther
  return new Float32Array(arr)
})()

// NW sun at 45° altitude — standard cartographic illumination convention.
// Light direction in ENU (East-North-Up): from surface toward the sun.
// Azimuth 315° (NW), altitude 45°: x=-0.5 (west), y=0.707 (up), z=0.5 (north)
// Vector is already unit-length: sqrt(0.25 + 0.5 + 0.25) = 1.0
const LIGHT_ENU = [-0.5, 0.707, 0.5] as const

// ─── Types ────────────────────────────────────────────────────────────────────

interface DragState {
  isDragging: boolean
  lastX: number
  lastY: number
}

/** Screen-space position of a peak label anchor point */
interface PeakScreenPos {
  id: string
  name: string
  elevation_m: number
  dist_km: number
  bearing: number
  screenX: number   // CSS pixels from left
  screenY: number   // CSS pixels from top (pinned to peak's projected position)
}

// ─── Grid Sampler ─────────────────────────────────────────────────────────────

/**
 * Bilinear-interpolated elevation lookup from the loaded terrain mesh.
 * Blends the 4 surrounding grid cells to produce smooth, staircase-free values.
 * Used for both the ray-height-field silhouette and hill-shade normal computation.
 */
function sampleMeshBilinear(lat: number, lng: number, mesh: TerrainMeshData): number {
  const { bounds, width, height, elevations } = mesh
  const nx = (lng - bounds.west)  / (bounds.east  - bounds.west)
  const ny = (bounds.north - lat) / (bounds.north - bounds.south)

  // Clamp to valid grid range — returns edge value for out-of-bounds coordinates
  const sx = Math.max(0, Math.min(width  - 1, nx * (width  - 1)))
  const sy = Math.max(0, Math.min(height - 1, ny * (height - 1)))

  const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, width  - 1)
  const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, height - 1)
  const fx = sx - x0, fy = sy - y0

  return (
    elevations[y0 * width + x0] * (1 - fx) * (1 - fy) +
    elevations[y0 * width + x1] * fx       * (1 - fy) +
    elevations[y1 * width + x0] * (1 - fx) * fy +
    elevations[y1 * width + x1] * fx       * fy
  )
}

// ─── Hill Shading ─────────────────────────────────────────────────────────────

/**
 * Compute hill-shade intensity at a terrain point using finite-difference surface normals.
 *
 * Algorithm:
 *   1. Sample elevation at four neighbours (~500m step at mid-latitudes)
 *   2. Compute central differences → rise-over-run in east and north directions
 *   3. Derive ENU surface normal: n = (-dzdx, 1, -dzdy) — points upward from surface
 *   4. Dot with pre-computed NW-45° sun direction → shade in [0, 1]
 *
 * Returns 0.0 (fully shadowed) to 1.0 (fully lit).
 */
function computeHillShade(lat: number, lng: number, mesh: TerrainMeshData): number {
  const STEP    = 0.005  // ~500m at mid-latitudes — safe step for 860m/px grid
  const cosLat  = Math.cos(lat * DEG_TO_RAD)
  const dx_m    = STEP * 111_320 * cosLat   // metres per STEP east–west
  const dy_m    = STEP * 111_132             // metres per STEP north–south

  const eE = sampleMeshBilinear(lat,          lng + STEP, mesh)
  const eW = sampleMeshBilinear(lat,          lng - STEP, mesh)
  const eN = sampleMeshBilinear(lat + STEP,   lng,        mesh)
  const eS = sampleMeshBilinear(lat - STEP,   lng,        mesh)

  // Central differences: elevation change per metre in each horizontal direction
  const dzdx = (eE - eW) / (2 * dx_m)   // east slope
  const dzdy = (eN - eS) / (2 * dy_m)   // north slope

  // Surface normal (ENU: x=east, y=up, z=north) — un-normalised
  // For surface y = f(x,z): n = (-df/dx, 1, -df/dz)
  const nx = -dzdx, ny = 1.0, nz = -dzdy
  const mag = Math.sqrt(nx * nx + ny * ny + nz * nz)

  // Dot with NW 45° sun direction; clamp negative (shadowed) side to 0
  const shade = (nx * LIGHT_ENU[0] + ny * LIGHT_ENU[1] + nz * LIGHT_ENU[2]) / mag
  return Math.max(0, shade)
}

// ─── First-Person Projection ──────────────────────────────────────────────────

/**
 * Project a world-space terrain point (lat, lng, elev) into first-person
 * screen coordinates. Returns null if the point is behind the camera.
 *
 * Coordinate frame: ENU (East-North-Up) relative to viewer, in meters.
 *   - cam_forward = depth along the viewer's look direction (must be > 0)
 *   - cam_right   = lateral offset (positive = right)
 *   - dz_up       = vertical offset from eye elevation
 */
function projectFirstPerson(
  lat: number,
  lng: number,
  elev: number,
  viewerLat: number,
  viewerLng: number,
  viewerElev: number,
  heading_deg: number,
  pitch_deg: number,
  W: number,
  H: number,
): { screenX: number; screenY: number; horizDist: number } | null {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)

  // ENU offset from viewer (meters)
  const dx_east  = (lng - viewerLng) * 111_320 * cosLat
  const dy_north = (lat - viewerLat) * 111_320
  const dz_up    = elev - viewerElev

  // Rotate to camera frame by heading
  const headRad      = heading_deg * DEG_TO_RAD
  const cam_forward  = dx_east * Math.sin(headRad) + dy_north * Math.cos(headRad)
  const cam_right    = dx_east * Math.cos(headRad) - dy_north * Math.sin(headRad)

  // Cull points behind camera
  if (cam_forward <= 10) return null  // 10m threshold avoids projection artifacts at close range

  // Bearing and elevation angle from camera center
  const azimuth       = Math.atan2(cam_right, cam_forward)
  const horizDist     = Math.sqrt(cam_forward * cam_forward + cam_right * cam_right)
  const elevAngle     = Math.atan2(dz_up, horizDist)

  // Screen space
  const hfovRad  = HFOV * DEG_TO_RAD
  const vfovRad  = VFOV * DEG_TO_RAD
  const pitchRad = pitch_deg * DEG_TO_RAD
  const horizonY = H * 0.5 - pitchRad * (H / vfovRad)

  const screenX = W * 0.5 + azimuth   * (W / hfovRad)
  const screenY = horizonY - elevAngle * (H / vfovRad)

  return { screenX, screenY, horizDist }
}

// ─── Main Canvas Draw ─────────────────────────────────────────────────────────

/**
 * Render the full SCAN viewport onto `canvas`.
 *
 * Returns computed peak screen positions so the React layer can position
 * the HTML label cards precisely without a second layout pass.
 *
 * Drawing order (painter's algorithm):
 *   1. Sky gradient
 *   2. Terrain silhouette fill (ray-height-field, per-column)
 *   3. Contour lines (marching squares + first-person projection)
 *   4. Horizon glow line
 */
function drawScanCanvas(
  canvas: HTMLCanvasElement,
  mesh: TerrainMeshData,
  contourElevations: number[],
  peaks: Peak[],
  heading_deg: number,
  pitch_deg: number,
  eyeHeight_m: number,
  activeLat: number,
  activeLng: number,
  showContours: boolean,
): PeakScreenPos[] {
  const ctx = canvas.getContext('2d')
  if (!ctx) return []

  const W = canvas.width
  const H = canvas.height

  const groundElev = sampleMeshBilinear(activeLat, activeLng, mesh)
  const eyeElev    = groundElev + eyeHeight_m

  const pitchRad = pitch_deg * DEG_TO_RAD
  const vfovRad  = VFOV * DEG_TO_RAD
  const horizonY = H * 0.5 - pitchRad * (H / vfovRad)

  const cosLat = Math.cos(activeLat * DEG_TO_RAD)

  // ── 1. Sky gradient ─────────────────────────────────────────────────────────
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0,    '#010810')   // deep void
  skyGrad.addColorStop(0.38, '#04121e')   // sky
  skyGrad.addColorStop(0.62, '#071825')   // near horizon
  skyGrad.addColorStop(1,    '#0c2338')   // horizon haze
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

  // ── 2. Terrain silhouette — logarithmic ray-height-field ─────────────────────
  //
  // For each screen column:
  //   - Walk outward from viewer using pre-computed logarithmic step sizes
  //     (1.5% growth from 100m → 120km, ~476 steps processed far→near)
  //   - Apply Earth curvature + atmospheric refraction correction at each sample
  //   - Fill newly-visible terrain slices with distance + hill-shade colour
  //   - Hill shade: NW 45° sun, finite-difference surface normals from the grid

  for (let col = 0; col < W; col++) {
    const bearingDeg = heading_deg + (col / W - 0.5) * HFOV
    const bearingRad = bearingDeg * DEG_TO_RAD
    const sinB       = Math.sin(bearingRad)
    const cosB       = Math.cos(bearingRad)

    let maxTerrainY = H  // lowest visible pixel for this column (starts at bottom)

    for (let i = 0; i < RAY_DISTANCES.length; i++) {
      const dist = RAY_DISTANCES[i]  // far→near order (far steps first)

      // Flat-earth approximation for sample position — accurate to ≪ 1 grid pixel at 120km
      const sampleLat = activeLat + (cosB * dist) / 111_320
      const sampleLng = activeLng + (sinB * dist) / (111_320 * cosLat)

      const rawElev = sampleMeshBilinear(sampleLat, sampleLng, mesh)

      // Earth curvature + atmospheric refraction correction.
      // Without this, a 50km-away point appears ~196m too high; 120km ~1.1km too high.
      // Refraction (k=0.13) partially offsets curvature — standard geodetic correction.
      const curvDrop      = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
      const effectiveElev = rawElev - curvDrop

      const elevDiff  = effectiveElev - eyeElev
      const elevAngle = Math.atan2(elevDiff, dist)
      const screenY   = horizonY - elevAngle * (H / vfovRad)

      if (screenY < maxTerrainY) {
        // Newly visible slice — compute hill shade at this ridgeline point
        const shade = computeHillShade(sampleLat, sampleLng, mesh)

        // Distance fraction: 0 = far/dark, 1 = near/bright
        const nearFrac = Math.max(0, 1 - dist / MAX_DIST)
        const g        = Math.pow(nearFrac, 0.75)

        // Hill shade scale: 0.40 in full shadow → 1.00 in full sun
        // Keeps shadows deep (navy) and lit faces bright (teal) without blowing out
        const shadeScale = 0.40 + shade * 0.60

        const r  = Math.round(( 8 + g * 32)  * shadeScale)
        const gr = Math.round((35 + g * 105) * shadeScale)
        const b  = Math.round((55 + g * 100) * (0.60 + shadeScale * 0.40))

        ctx.fillStyle = `rgb(${r},${gr},${b})`
        ctx.fillRect(col, Math.round(screenY), 1, Math.round(maxTerrainY - screenY) + 1)

        maxTerrainY = screenY
      }
    }
  }

  // ── 3. Contour lines — marching squares + first-person projection ────────────
  //
  // For each contour level, run marching squares on the elevation grid to get
  // segments in normalized grid space [0,1], convert each endpoint to a
  // real-world lat/lng, then project into first-person screen coords.
  //
  // Atmospheric perspective: farther segments → lower opacity + slight blue-shift.

  if (showContours && contourElevations.length > 0) {
    const { elevations, width, height, bounds, minElevation_m, maxElevation_m } = mesh
    const elevRange = maxElevation_m - minElevation_m || 1

    const latRange = bounds.north - bounds.south
    const lngRange = bounds.east  - bounds.west

    for (const elev of contourElevations) {
      const t = (elev - minElevation_m) / elevRange  // 0=low, 1=high
      // Index contour every 500m — matches EXPLORE's threshold; heavier + brighter
      const isIndex = elev % 500 === 0

      // Ocean-depth tint for this contour level: low = dark navy, high = bright teal
      const cr = Math.round(14  + t * (132 - 14))
      const cg = Math.round(75  + t * (209 - 75))
      const cb = Math.round(107 + t * (219 - 107))

      const segments = marchingSquares(elevations, width, height, elev)

      for (const seg of segments) {
        // Grid [0,1] → geographic lat/lng for each endpoint
        const lat1 = bounds.north - seg.y1 * latRange
        const lng1 = bounds.west  + seg.x1 * lngRange
        const lat2 = bounds.north - seg.y2 * latRange
        const lng2 = bounds.west  + seg.x2 * lngRange

        const p1 = projectFirstPerson(
          lat1, lng1, elev,
          activeLat, activeLng, eyeElev,
          heading_deg, pitch_deg, W, H,
        )
        const p2 = projectFirstPerson(
          lat2, lng2, elev,
          activeLat, activeLng, eyeElev,
          heading_deg, pitch_deg, W, H,
        )

        if (!p1 || !p2) continue

        // Rough off-screen cull (generous margin for diagonal segments)
        if (p1.screenX < -W && p2.screenX < -W) continue
        if (p1.screenX > W * 2 && p2.screenX > W * 2) continue
        if (p1.screenY < -H && p2.screenY < -H) continue
        if (p1.screenY > H * 2 && p2.screenY > H * 2) continue

        // Atmospheric perspective: opacity falls off with distance
        const avgDist  = (p1.horizDist + p2.horizDist) * 0.5
        const depthT   = Math.max(0, 1 - Math.pow(avgDist / MAX_DIST, 0.65))

        // Index contours (500m) stronger; minor (100m) contours subtler
        // Minor opacity raised slightly (0.32→0.40) because we now have 2× more lines
        const baseOpacity = isIndex ? 0.72 : 0.40
        const opacity = depthT * baseOpacity

        if (opacity < 0.03) continue

        // Blue-shift for distant features (atmospheric haze effect)
        const blueShift = (1 - depthT) * 40
        const fr = Math.max(0, cr - blueShift)
        const fg = Math.max(0, cg - blueShift * 0.3)
        const fb = Math.min(255, cb + blueShift * 0.5)

        ctx.beginPath()
        ctx.strokeStyle = `rgba(${Math.round(fr)},${Math.round(fg)},${Math.round(fb)},${opacity.toFixed(3)})`
        ctx.lineWidth   = isIndex ? 1.5 : 0.9
        ctx.moveTo(p1.screenX, p1.screenY)
        ctx.lineTo(p2.screenX, p2.screenY)
        ctx.stroke()
      }
    }

    log.debug('Contours drawn', { levels: contourElevations.length })
  }

  // ── 4. Horizon glow ──────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(132, 209, 219, 0.10)'
  ctx.fillRect(0, Math.round(horizonY) - 1, W, 2)

  // ── Compute peak screen positions ─────────────────────────────────────────────
  // Project each peak into first-person screen space for label anchoring.
  // Peaks too far off-screen or behind the camera are excluded.

  const hfovRad = HFOV * DEG_TO_RAD
  const peakPositions: PeakScreenPos[] = []

  for (const peak of peaks) {
    const projected = projectFirstPerson(
      peak.lat, peak.lng, peak.elevation_m,
      activeLat, activeLng, eyeElev,
      heading_deg, pitch_deg, W, H,
    )
    if (!projected) continue

    // Cull if horizontally outside view (with small margin)
    const { screenX, screenY, horizDist } = projected
    if (screenX < -50 || screenX > W + 50) continue
    // Only show peaks within label range (80km — useful visibility limit)
    if (horizDist > MAX_PEAK_DIST) continue

    const bearing   = calculateBearing(
      { lat: activeLat, lng: activeLng },
      { lat: peak.lat,  lng: peak.lng },
    )
    const dist_km = horizDist / 1000

    peakPositions.push({
      id:          peak.id,
      name:        peak.name,
      elevation_m: peak.elevation_m,
      dist_km,
      bearing,
      screenX,
      screenY,
    })
  }

  log.debug('Scan canvas drawn', {
    heading: heading_deg.toFixed(1),
    pitch:   pitch_deg.toFixed(1),
    eyeElev: eyeElev.toFixed(0),
    visiblePeaks: peakPositions.length,
  })

  return peakPositions
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ScanScreen: React.FC = () => {
  const { heading_deg, pitch_deg, height_m, applyARDrag, setHeightFromSlider } = useCameraStore()
  const { activeLat, activeLng } = useLocationStore()
  const { peaks, meshData, contourElevations } = useTerrainStore()
  const { units, showPeakLabels, showContourLines } = useSettingsStore()

  const viewportRef      = useRef<HTMLDivElement>(null)
  const terrainCanvasRef = useRef<HTMLCanvasElement>(null)
  const dragState        = useRef<DragState>({ isDragging: false, lastX: 0, lastY: 0 })
  const sliderRef        = useRef<HTMLDivElement>(null)
  const sliderDragRef    = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })

  const [showDragHint, setShowDragHint]         = useState(true)
  const [peakPositions, setPeakPositions]       = useState<PeakScreenPos[]>([])
  const [canvasCSSSize, setCanvasCSSSize]        = useState({ w: 0, h: 0 })

  log.debug('ScanScreen render', {
    heading:    heading_deg.toFixed(1),
    pitch:      pitch_deg.toFixed(1),
    height_m:   height_m.toFixed(0),
    peakCount:  peaks.length,
    hasMesh:    !!meshData,
  })

  // ── Terrain Canvas Draw ────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas || !meshData) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width  = Math.round(rect.width  * dpr)
    canvas.height = Math.round(rect.height * dpr)
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.scale(dpr, dpr)

    // Store CSS size so label coordinates can be computed correctly
    setCanvasCSSSize({ w: rect.width, h: rect.height })

    // Draw and get back peak screen positions (in physical canvas pixels)
    const rawPositions = drawScanCanvas(
      canvas,
      meshData,
      contourElevations,
      peaks,
      heading_deg,
      pitch_deg,
      height_m,
      activeLat,
      activeLng,
      showContourLines,
    )

    // Convert physical canvas coords → CSS pixel coords for HTML labels
    setPeakPositions(
      rawPositions.map((p) => ({
        ...p,
        screenX: p.screenX / dpr,
        screenY: p.screenY / dpr,
      })),
    )
  }, [
    heading_deg, pitch_deg, height_m,
    activeLat, activeLng,
    meshData, contourElevations, peaks,
    showContourLines,
  ])

  // ── Resize observer ────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return

    const observer = new ResizeObserver(() => {
      // Re-draw happens because the next animation frame will re-trigger the
      // draw effect if anything changed. For pure resize without state change,
      // trigger a manual redraw.
      if (!meshData) return
      const rect = canvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width  = Math.round(rect.width  * dpr)
      canvas.height = Math.round(rect.height * dpr)
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.scale(dpr, dpr)
      setCanvasCSSSize({ w: rect.width, h: rect.height })
      const rawPositions = drawScanCanvas(
        canvas, meshData, contourElevations, peaks,
        heading_deg, pitch_deg, height_m,
        activeLat, activeLng, showContourLines,
      )
      const currentDpr = window.devicePixelRatio || 1
      setPeakPositions(rawPositions.map((p) => ({
        ...p,
        screenX: p.screenX / currentDpr,
        screenY: p.screenY / currentDpr,
      })))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [
    heading_deg, pitch_deg, height_m,
    activeLat, activeLng,
    meshData, contourElevations, peaks,
    showContourLines,
  ])

  // ── Drag Handlers (viewport) ───────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    viewportRef.current?.setPointerCapture(e.pointerId)
    dragState.current = { isDragging: true, lastX: e.clientX, lastY: e.clientY }
    setShowDragHint(false)
    log.debug('AR drag start', { x: e.clientX, y: e.clientY })
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging) return
    const deltaX = e.clientX - dragState.current.lastX
    const deltaY = e.clientY - dragState.current.lastY
    dragState.current.lastX = e.clientX
    dragState.current.lastY = e.clientY
    applyARDrag(deltaX, deltaY)
  }, [applyARDrag])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    viewportRef.current?.releasePointerCapture(e.pointerId)
    dragState.current.isDragging = false
    log.debug('AR drag end')
  }, [])

  // ── Height Slider ──────────────────────────────────────────────────────────

  const handleSliderPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    sliderRef.current?.setPointerCapture(e.pointerId)
    sliderDragRef.current = { isDragging: true, startY: e.clientY, startHeight: height_m }
    log.debug('Height slider drag start', { height_m: height_m.toFixed(0) })
  }, [height_m])

  const handleSliderPointerMove = useCallback((e: React.PointerEvent) => {
    if (!sliderDragRef.current.isDragging) return
    const sliderEl = sliderRef.current
    if (!sliderEl) return
    const sliderRect   = sliderEl.getBoundingClientRect()
    const sliderHeight = sliderRect.height
    const deltaY       = e.clientY - sliderDragRef.current.startY
    const heightRange  = MAX_HEIGHT_M - MIN_HEIGHT_M
    const heightDelta  = -(deltaY / sliderHeight) * heightRange
    const newHeight    = clamp(
      sliderDragRef.current.startHeight + heightDelta,
      MIN_HEIGHT_M,
      MAX_HEIGHT_M,
    )
    setHeightFromSlider(metersToFeet(newHeight))
  }, [setHeightFromSlider])

  const handleSliderPointerUp = useCallback((e: React.PointerEvent) => {
    sliderRef.current?.releasePointerCapture(e.pointerId)
    sliderDragRef.current.isDragging = false
  }, [])

  // ── Compass offset ─────────────────────────────────────────────────────────

  const compassOffset = (() => {
    const headingIndex = heading_deg / 22.5
    const centerItemIndex = headingIndex + 16
    return -(centerItemIndex * COMPASS_ITEM_WIDTH)
  })()

  // ── Ground elevation for HUD ───────────────────────────────────────────────

  const groundElev = meshData
    ? sampleMeshBilinear(activeLat, activeLng, meshData)
    : 0

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
          {Math.round(heading_deg)}°
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
                <div key={`${loop}-${dirIndex}`} className={styles.compassItem}>
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
        role="application"
        aria-label="Terrain view — drag to look around"
      >
        {/* Ray-height-field + contour canvas */}
        <canvas
          ref={terrainCanvasRef}
          className={styles.terrainCanvas}
          aria-hidden="true"
        />

        {/* Peak labels anchored to projected screen positions */}
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

        {/* Drag hint */}
        <div
          className={`${styles.dragHint} ${!showDragHint ? styles.hidden : ''}`}
          aria-hidden="true"
        >
          ← Drag to look around →
        </div>
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
      />
    </div>
  )
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

// Label height constants (card + line + dot = ~98px total)
const LABEL_STACK_HEIGHT = 98

/**
 * Peak label card — dot is pinned to the peak's projected screen position.
 *
 * Default: card → line → dot (top to bottom), positioned so DOT is at screenY.
 * Flipped (near viewport top): dot → line → card (dot at screenY, card below).
 *
 * Distance fading: far peaks fade so near peaks stay readable.
 */
const PeakLabel: React.FC<{
  pos: PeakScreenPos
  units: 'imperial' | 'metric'
  canvasH: number
}> = ({ pos, units, canvasH }) => {
  const MAX_LABEL_DIST_KM = MAX_PEAK_DIST / 1000  // fade peaks over 80km range
  const distFade  = Math.max(0.25, 1 - Math.pow(pos.dist_km / MAX_LABEL_DIST_KM, 0.5))
  const isNearTop = pos.screenY < canvasH * 0.22

  // Offset so the DOT aligns with the projected peak position
  const topPx = isNearTop
    ? pos.screenY                      // dot at top of stack (label renders downward)
    : pos.screenY - LABEL_STACK_HEIGHT // dot at bottom of stack (label renders upward)

  const card = (
    <div className={styles.peakCard} aria-hidden="true">
      <span className={styles.peakName}>{pos.name}</span>
      <span className={styles.peakElev}>{formatElevation(pos.elevation_m, units)}</span>
      <span className={styles.peakBearing}>
        {headingToCompass(pos.bearing)} · {pos.dist_km.toFixed(0)} km
      </span>
    </div>
  )

  return (
    <div
      className={`${styles.peakLabel} ${isNearTop ? styles.peakLabelFlipped : ''}`}
      style={{ left: `${pos.screenX}px`, top: `${topPx}px`, opacity: distFade }}
      role="img"
      aria-label={`${pos.name}, ${formatElevation(pos.elevation_m, units)}, ${pos.dist_km.toFixed(0)} km`}
    >
      {isNearTop ? (
        // Flipped: dot at top, card below
        <>
          <div className={styles.peakDot}              aria-hidden="true" />
          <div className={`${styles.peakLine} ${styles.peakLineDown}`} aria-hidden="true" />
          {card}
        </>
      ) : (
        // Default: card at top, dot at bottom (aligned with peak)
        <>
          {card}
          <div className={styles.peakLine}  aria-hidden="true" />
          <div className={styles.peakDot}   aria-hidden="true" />
        </>
      )}
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
}

const HUDBar: React.FC<HUDBarProps> = ({
  heading_deg, lat, lng, groundElev_m, eyeHeight_m, units,
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
        <span className={styles.hudLabel}>VIEWPT</span>
        <span className={styles.hudValue}>{eyeStr}</span>
        <span className={styles.hudSubLabel}>AGL</span>
      </div>
    </div>
  )
}

export default ScanScreen
