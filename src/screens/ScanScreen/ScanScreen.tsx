/**
 * EarthContours — SCAN Screen  (Phase 2)
 *
 * First-person terrain panorama with PeakFinder-style aesthetics.
 *
 * ── Rendering modes ──────────────────────────────────────────────────────────
 *
 *  QUICK (skyline available):
 *    Reads pre-computed SkylineData from the Web Worker — O(W) per frame.
 *    Silhouette rendered from ridgeline angles; smooth 60-fps panning.
 *
 *  FULL (fallback / high-quality):
 *    Per-column logarithmic ray march using ScanTileCache for multi-zoom tiles.
 *    Runs automatically when SkylineData is stale or unavailable.
 *
 * ── Layers (painter's order) ─────────────────────────────────────────────────
 *   1  Sky gradient   — deep void → atmospheric haze with horizon glow
 *   2  Terrain fill   — silhouette fill from ridgeline to bottom (distance-shaded)
 *   3  Contour lines  — marching squares projected into first-person space
 *   4  Horizon glow   — thin teal line at the horizon
 *   5  Peak labels    — HTML overlay anchored to projected peak positions
 *
 * ── Phase 2 additions ────────────────────────────────────────────────────────
 *   • ScanTileCache   — multi-zoom tiles (z8→z13) for 250 km range
 *   • skylineWorker   — Web Worker precomputes 360° ridgeline in background
 *   • peakLoader      — live OSM Overpass peaks for any viewpoint worldwide
 *   • Dynamic FOV     — pinch zoom changes field of view (15°–100°)
 *   • Pitch indicator — vertical level gauge on left edge
 *   • Curvature in    — Earth curvature applied to peak label projections
 *     peak labels
 *   • Loading overlay — "Computing panorama…" progress during worker computation
 *
 * ── Projection math (ENU → screen) ──────────────────────────────────────────
 *   dx_east  = (lng − viewerLng) × 111 320 × cos(viewerLat)
 *   dy_north = (lat − viewerLat) × 111 132
 *   Rotate by heading → cam_forward (depth), cam_right (lateral)
 *   azimuth   = atan2(cam_right, cam_forward)
 *   elev_angle = atan2(dz − curvDrop, horizDist)  ← includes curvature
 *   screenX   = cx + azimuth    × (W / hfovRad)
 *   screenY   = horizonY − elev_angle × (H / vfovRad)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
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
import { marchingSquares } from '../../renderer/marchingSquares'
import { ScanTileCache, distanceToZoom } from '../../data/ScanTileCache'
import { fetchPeaksNear }                from '../../data/peakLoader'
import type { Peak, TerrainMeshData, SkylineData, SkylineRequest } from '../../core/types'
import styles from './ScanScreen.module.css'

const log = createLogger('SCREEN:SCAN')

// ─── Constants ────────────────────────────────────────────────────────────────

const VFOV              = 60          // Vertical field of view (°) — fixed
const MAX_DIST          = 250_000     // Maximum render distance (m) — Phase 2 upgrade
const MAX_PEAK_DIST     = 120_000     // Max distance for peak label display (m)
const EARTH_R           = 6_371_000  // Earth radius (m)
const REFRACTION_K      = 0.13       // Atmospheric refraction coefficient
const DEG_TO_RAD        = Math.PI / 180
const SKYLINE_RESOLUTION = 2         // 0.5° per step = 720 azimuths for full 360°

// Pre-computed logarithmic ray distances, far→near (250 km).
// ~595 steps at 1.5% growth from 100 m → 250 km.
const RAY_DISTANCES: Float32Array = (() => {
  const arr: number[] = []
  let d = 100
  while (d <= MAX_DIST) {
    arr.push(d)
    d *= 1.015
  }
  arr.reverse()
  return new Float32Array(arr)
})()

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
  screenX:     number
  screenY:     number
}

// ─── Grid Sampler ─────────────────────────────────────────────────────────────

function sampleMeshBilinear(lat: number, lng: number, mesh: TerrainMeshData): number {
  const { bounds, width, height, elevations } = mesh
  const nx = (lng - bounds.west)  / (bounds.east  - bounds.west)
  const ny = (bounds.north - lat) / (bounds.north - bounds.south)
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

/** Best-available elevation: ScanTileCache at appropriate zoom, then mesh fallback. */
function sampleBestAvailable(
  lat: number, lng: number, dist: number,
  mesh: TerrainMeshData,
  tileCache: ScanTileCache,
): number {
  const zoom = distanceToZoom(dist)
  if (zoom >= 11) {
    const hi = tileCache.sampleBilinear(lat, lng, zoom)
    if (hi !== null) return hi
  } else {
    const hi = tileCache.sampleBilinear(lat, lng, zoom)
    if (hi !== null) return hi
  }
  return sampleMeshBilinear(lat, lng, mesh)
}

// ─── Cheap Directional Shade ──────────────────────────────────────────────────

/**
 * O(1) bearing-based shade for the full ray-march path.
 *
 * Sun is from NW (315°) at 45° altitude.  Terrain faces pointing toward SE–S–E
 * are lit (shade → 1.0); faces pointing toward NW are in shadow (shade → 0.4).
 *
 * This avoids the 4 extra elevation lookups of finite-difference normals and
 * runs smoothly at 60 fps on mobile while still conveying 3-D depth.
 * The skyline worker computes accurate finite-difference hill shade offline.
 */
function cheapDirectionalShade(bearingDeg: number): number {
  const SUN_BEARING = 315  // NW
  const cosAngle = Math.cos((bearingDeg - SUN_BEARING) * DEG_TO_RAD)
  // Map [-1, 1] → [0.4, 1.0]
  return 0.4 + cosAngle * 0.3 + 0.3
}

// ─── First-Person Projection ──────────────────────────────────────────────────

/**
 * Project a world-space point into first-person screen space.
 * Includes Earth curvature correction so distant peaks appear at their true angle.
 */
function projectFirstPerson(
  lat: number, lng: number, elev: number,
  viewerLat: number, viewerLng: number, viewerElev: number,
  heading_deg: number, pitch_deg: number,
  hfov: number, W: number, H: number,
): { screenX: number; screenY: number; horizDist: number } | null {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)

  const dx_east  = (lng - viewerLng) * 111_320 * cosLat
  const dy_north = (lat - viewerLat) * 111_132

  const headRad     = heading_deg * DEG_TO_RAD
  const cam_forward = dx_east * Math.sin(headRad) + dy_north * Math.cos(headRad)
  const cam_right   = dx_east * Math.cos(headRad) - dy_north * Math.sin(headRad)

  if (cam_forward <= 10) return null

  const horizDist = Math.sqrt(cam_forward * cam_forward + cam_right * cam_right)

  // Earth curvature + refraction correction — same formula as ray march
  const curvDrop  = (horizDist * horizDist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const corrElev  = elev - curvDrop
  const dz_up     = corrElev - viewerElev

  const azimuth   = Math.atan2(cam_right, cam_forward)
  const elevAngle = Math.atan2(dz_up, horizDist)

  const hfovRad  = hfov * DEG_TO_RAD
  const vfovRad  = VFOV * DEG_TO_RAD
  const pitchRad = pitch_deg * DEG_TO_RAD
  const horizonY = H * 0.5 - pitchRad * (H / vfovRad)

  const screenX = W * 0.5 + azimuth    * (W / hfovRad)
  const screenY = horizonY - elevAngle * (H / vfovRad)

  return { screenX, screenY, horizDist }
}

// ─── Terrain Color ────────────────────────────────────────────────────────────

/**
 * Map (distance, hill-shade) → RGB terrain color from the ocean-depth palette.
 *
 * Near/lit  → reef/glow range  (teal, ~rgb(68,155,175))
 * Far/dark  → abyss/void range (deep navy, ~rgb(8,35,55))
 */
function terrainColor(dist: number, shade: number): [number, number, number] {
  const nearFrac   = Math.max(0, 1 - dist / MAX_DIST)
  const g          = Math.pow(nearFrac, 0.75)
  const shadeScale = 0.40 + shade * 0.60

  const r  = Math.round(( 8 + g *  60) * shadeScale)
  const gr = Math.round((35 + g * 120) * shadeScale)
  const b  = Math.round((55 + g * 120) * (0.55 + shadeScale * 0.45))
  return [r, gr, b]
}

// ─── Quick Render (SkylineData) ───────────────────────────────────────────────

/**
 * Fast O(W) render using pre-computed SkylineData.
 * Draws the terrain silhouette by reading pre-computed ridgeline angles.
 * Used while panning — the smooth 60-fps path.
 */
function drawFromSkyline(
  ctx: CanvasRenderingContext2D,
  skyline: SkylineData,
  heading_deg: number,
  pitch_deg: number,
  hfov: number,
  W: number,
  H: number,
): void {
  const hfovRad  = hfov * DEG_TO_RAD
  const vfovRad  = VFOV * DEG_TO_RAD
  const pitchRad = pitch_deg * DEG_TO_RAD
  const horizonY = H * 0.5 - pitchRad * (H / vfovRad)

  for (let col = 0; col < W; col++) {
    const bearingDeg = heading_deg + (col / W - 0.5) * hfov
    const normBearing = ((bearingDeg % 360) + 360) % 360
    const aziIdx = Math.round(normBearing * skyline.resolution) % skyline.numAzimuths

    const ridgeAngle = skyline.angles[aziIdx]
    const ridgeDist  = skyline.distances[aziIdx]
    const shade      = skyline.shading[aziIdx]

    const screenY = Math.round(horizonY - ridgeAngle * (H / vfovRad))
    if (screenY >= H) continue  // ridgeline below viewport — nothing to draw

    const [r, gr, b] = terrainColor(ridgeDist, shade)
    ctx.fillStyle = `rgb(${r},${gr},${b})`
    ctx.fillRect(col, Math.max(0, screenY), 1, H - Math.max(0, screenY))
  }
}

// ─── Full Canvas Draw ─────────────────────────────────────────────────────────

function drawScanCanvas(
  canvas: HTMLCanvasElement,
  mesh: TerrainMeshData,
  tileCache: ScanTileCache,
  contourElevations: number[],
  peaks: Peak[],
  heading_deg: number,
  pitch_deg: number,
  eyeHeight_m: number,
  activeLat: number,
  activeLng: number,
  hfov: number,
  showContours: boolean,
  skylineData: SkylineData | null,
): PeakScreenPos[] {
  const ctx = canvas.getContext('2d')
  if (!ctx) return []

  const W = canvas.width
  const H = canvas.height

  const groundElev = sampleMeshBilinear(activeLat, activeLng, mesh)
  const eyeElev    = groundElev + eyeHeight_m

  const pitchRad = pitch_deg * DEG_TO_RAD
  const vfovRad  = VFOV * DEG_TO_RAD
  const hfovRad  = hfov * DEG_TO_RAD
  const horizonY = H * 0.5 - pitchRad * (H / vfovRad)
  const cosLat   = Math.cos(activeLat * DEG_TO_RAD)

  // ── 1. Sky gradient ─────────────────────────────────────────────────────────
  // Multi-stop gradient from deep void (top) through ocean navy to horizon haze.
  // The gradient fills the full canvas height — terrain paints over the lower half.
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0,    '#000810')   // --ec-void  — absolute black top
  skyGrad.addColorStop(0.20, '#020c18')   // dark space
  skyGrad.addColorStop(0.50, '#051520')   // mid sky
  skyGrad.addColorStop(0.78, '#071a2a')   // near horizon
  skyGrad.addColorStop(0.90, '#0c2235')   // atmosphere haze
  skyGrad.addColorStop(1.0,  '#0f2c42')   // horizon
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

  // Subtle star field: very faint dots in the upper 45% of sky
  // Deterministic from canvas dimensions so they don't flicker between frames
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

  // ── 2. Terrain silhouette ────────────────────────────────────────────────────

  if (skylineData) {
    // QUICK PATH — read pre-computed ridgeline angles (O(W) per frame)
    drawFromSkyline(ctx, skylineData, heading_deg, pitch_deg, hfov, W, H)
  } else {
    // FULL PATH — per-column logarithmic ray march with multi-zoom tile cache.
    // Hill shade uses a cheap O(1) directional approximation (no extra elevation
    // lookups) so it runs smoothly at 60 fps on mobile.
    for (let col = 0; col < W; col++) {
      const bearingDeg = heading_deg + (col / W - 0.5) * hfov
      const bearingRad = bearingDeg * DEG_TO_RAD
      const sinB = Math.sin(bearingRad)
      const cosB = Math.cos(bearingRad)

      // Compute shade once per column (it only depends on bearing direction)
      const colShade = cheapDirectionalShade(bearingDeg)

      let maxTerrainY = H

      for (let i = 0; i < RAY_DISTANCES.length; i++) {
        const dist = RAY_DISTANCES[i]

        const sampleLat = activeLat + (cosB * dist) / 111_132
        const sampleLng = activeLng + (sinB * dist) / (111_320 * cosLat)

        const rawElev  = sampleBestAvailable(sampleLat, sampleLng, dist, mesh, tileCache)
        const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
        const effElev  = rawElev - curvDrop

        const elevAngle = Math.atan2(effElev - eyeElev, dist)
        const screenY   = horizonY - elevAngle * (H / vfovRad)

        if (screenY < maxTerrainY) {
          const [r, gr, b] = terrainColor(dist, colShade)
          ctx.fillStyle = `rgb(${r},${gr},${b})`
          ctx.fillRect(col, Math.round(screenY), 1, Math.round(maxTerrainY - screenY) + 1)
          maxTerrainY = screenY
        }
      }
    }
  }

  // ── 3. Contour lines — marching squares + first-person projection ────────────

  if (showContours && contourElevations.length > 0) {
    const { elevations, width, height, bounds, minElevation_m, maxElevation_m } = mesh
    const elevRange = maxElevation_m - minElevation_m || 1
    const latRange  = bounds.north - bounds.south
    const lngRange  = bounds.east  - bounds.west

    for (const elev of contourElevations) {
      const t       = (elev - minElevation_m) / elevRange
      const isIndex = elev % 500 === 0

      // Ocean-depth tint: low = dark navy, high = bright teal
      const cr = Math.round(14  + t * (132 - 14))
      const cg = Math.round(75  + t * (209 - 75))
      const cb = Math.round(107 + t * (219 - 107))

      const segments = marchingSquares(elevations, width, height, elev)

      for (const seg of segments) {
        const lat1 = bounds.north - seg.y1 * latRange
        const lng1 = bounds.west  + seg.x1 * lngRange
        const lat2 = bounds.north - seg.y2 * latRange
        const lng2 = bounds.west  + seg.x2 * lngRange

        const p1 = projectFirstPerson(lat1, lng1, elev, activeLat, activeLng, eyeElev, heading_deg, pitch_deg, hfov, W, H)
        const p2 = projectFirstPerson(lat2, lng2, elev, activeLat, activeLng, eyeElev, heading_deg, pitch_deg, hfov, W, H)
        if (!p1 || !p2) continue

        if (p1.screenX < -W && p2.screenX < -W) continue
        if (p1.screenX > W * 2 && p2.screenX > W * 2) continue
        if (p1.screenY < -H && p2.screenY < -H) continue
        if (p1.screenY > H * 2 && p2.screenY > H * 2) continue

        const avgDist     = (p1.horizDist + p2.horizDist) * 0.5
        const depthT      = Math.max(0, 1 - Math.pow(avgDist / MAX_DIST, 0.65))
        const baseOpacity = isIndex ? 0.72 : 0.40
        const opacity     = depthT * baseOpacity
        if (opacity < 0.03) continue

        const blueShift = (1 - depthT) * 40
        ctx.beginPath()
        ctx.strokeStyle = `rgba(${Math.max(0, cr - blueShift).toFixed(0)},${Math.max(0, cg - blueShift * 0.3).toFixed(0)},${Math.min(255, cb + blueShift * 0.5).toFixed(0)},${opacity.toFixed(3)})`
        ctx.lineWidth = isIndex ? 1.5 : 0.9
        ctx.moveTo(p1.screenX, p1.screenY)
        ctx.lineTo(p2.screenX, p2.screenY)
        ctx.stroke()
      }
    }
  }

  // ── 4. Horizon glow ──────────────────────────────────────────────────────────
  // Soft teal glow centred on the horizon line — stronger than Phase 1 version
  const glowGrad = ctx.createLinearGradient(0, horizonY - 12, 0, horizonY + 12)
  glowGrad.addColorStop(0,   'rgba(132, 209, 219, 0)')
  glowGrad.addColorStop(0.5, 'rgba(132, 209, 219, 0.22)')
  glowGrad.addColorStop(1,   'rgba(132, 209, 219, 0)')
  ctx.fillStyle = glowGrad
  ctx.fillRect(0, Math.round(horizonY - 12), W, 24)

  // Crisp 1-pixel glow line
  ctx.fillStyle = 'rgba(132, 209, 219, 0.18)'
  ctx.fillRect(0, Math.round(horizonY), W, 1)

  // ── Compute peak screen positions ─────────────────────────────────────────

  const peakPositions: PeakScreenPos[] = []

  for (const peak of peaks) {
    const projected = projectFirstPerson(
      peak.lat, peak.lng, peak.elevation_m,
      activeLat, activeLng, eyeElev,
      heading_deg, pitch_deg, hfov, W, H,
    )
    if (!projected) continue

    const { screenX, screenY, horizDist } = projected
    if (screenX < -50 || screenX > W + 50) continue
    if (horizDist > MAX_PEAK_DIST) continue

    peakPositions.push({
      id:          peak.id,
      name:        peak.name,
      elevation_m: peak.elevation_m,
      dist_km:     horizDist / 1000,
      bearing:     calculateBearing({ lat: activeLat, lng: activeLng }, { lat: peak.lat, lng: peak.lng }),
      screenX,
      screenY,
    })
  }

  log.debug('Scan canvas drawn', {
    heading:      heading_deg.toFixed(1),
    pitch:        pitch_deg.toFixed(1),
    hfov:         hfov.toFixed(1),
    mode:         skylineData ? 'quick/skyline' : 'full/raycast',
    visiblePeaks: peakPositions.length,
  })

  return peakPositions
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ScanScreen: React.FC = () => {
  const {
    heading_deg, pitch_deg, height_m, fov,
    applyARDrag, setHeightFromSlider, applyFovScale,
  } = useCameraStore()
  const { activeLat, activeLng }               = useLocationStore()
  const { peaks, meshData, contourElevations } = useTerrainStore()
  const { units, showPeakLabels, showContourLines } = useSettingsStore()

  const viewportRef      = useRef<HTMLDivElement>(null)
  const terrainCanvasRef = useRef<HTMLCanvasElement>(null)
  const dragState        = useRef<DragState>({ isDragging: false, lastX: 0, lastY: 0 })
  const pinchState       = useRef<PinchState>({ isPinching: false, lastDist: 0, startFov: fov })
  const sliderRef        = useRef<HTMLDivElement>(null)
  const sliderDragRef    = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })

  // Phase 2 infrastructure
  const scanTileCache  = useRef<ScanTileCache>(new ScanTileCache())
  const skylineWorker  = useRef<Worker | null>(null)

  const [showDragHint, setShowDragHint]       = useState(true)
  const [peakPositions, setPeakPositions]     = useState<PeakScreenPos[]>([])
  const [canvasCSSSize, setCanvasCSSSize]     = useState({ w: 0, h: 0 })
  const [skylineData, setSkylineData]         = useState<SkylineData | null>(null)
  const [osmPeaks, setOsmPeaks]               = useState<Peak[]>([])
  const [isPrefetching, setIsPrefetching]     = useState(false)
  const [isSkylineComputing, setIsSkylineComputing] = useState(false)
  const [skylineProgress, setSkylineProgress] = useState(0)

  // ── Active peak set: OSM peaks when available, fallback to hardcoded ────────
  const activePeaks: Peak[] = osmPeaks.length > 0 ? osmPeaks : peaks

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
        setSkylineData(skyline as SkylineData)
        setIsSkylineComputing(false)
        setSkylineProgress(1)
      }
    }

    worker.onerror = (err) => {
      log.warn('Skyline worker error', { err: err.message })
      setIsSkylineComputing(false)
    }

    skylineWorker.current = worker
    return () => { worker.terminate() }
  }, [])

  // ── Tile prefetch + skyline computation on location change ──────────────────

  useEffect(() => {
    if (!meshData) return

    // Clear stale skyline immediately so we fall back to ray march
    setSkylineData(null)
    setSkylineProgress(0)

    // 1. Prefetch tiles on main thread (for real-time ray march)
    setIsPrefetching(true)
    scanTileCache.current.prefetchForViewer(activeLat, activeLng)
      .finally(() => setIsPrefetching(false))

    // 2. Launch worker for full 250km skyline
    const worker = skylineWorker.current
    if (!worker) return

    const groundElev = sampleMeshBilinear(activeLat, activeLng, meshData)
    const viewerElev = groundElev + height_m

    setIsSkylineComputing(true)

    // Copy mesh elevations — worker needs its own buffer (main thread keeps original)
    const meshCopy = Float32Array.from(meshData.elevations)

    const request: SkylineRequest = {
      viewerLat:      activeLat,
      viewerLng:      activeLng,
      viewerElev:     viewerElev,
      meshElevations: meshCopy,
      meshWidth:      meshData.width,
      meshHeight:     meshData.height,
      meshBounds:     { ...meshData.bounds },
      resolution:     SKYLINE_RESOLUTION,
      maxRange:       MAX_DIST,
    }

    worker.postMessage(request, [meshCopy.buffer])

  }, [activeLat, activeLng, meshData])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── OSM peak fetch on location change ────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    fetchPeaksNear(activeLat, activeLng, 130)
      .then(fetched => {
        if (!cancelled) {
          setOsmPeaks(fetched)
          log.info('OSM peaks loaded', { count: fetched.length })
        }
      })
      .catch(err => log.warn('OSM peak fetch failed', { err: String(err) }))
    return () => { cancelled = true }
  }, [activeLat, activeLng])

  // ── Terrain canvas draw ────────────────────────────────────────────────────

  const redrawCanvas = useCallback(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas || !meshData) return

    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width  = Math.round(rect.width  * dpr)
    canvas.height = Math.round(rect.height * dpr)
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.scale(dpr, dpr)

    setCanvasCSSSize({ w: rect.width, h: rect.height })

    const rawPos = drawScanCanvas(
      canvas, meshData, scanTileCache.current,
      contourElevations, activePeaks,
      heading_deg, pitch_deg, height_m,
      activeLat, activeLng,
      fov, showContourLines, skylineData,
    )

    const currentDpr = window.devicePixelRatio || 1
    setPeakPositions(rawPos.map(p => ({
      ...p,
      screenX: p.screenX / currentDpr,
      screenY: p.screenY / currentDpr,
    })))
  }, [
    heading_deg, pitch_deg, height_m, fov,
    activeLat, activeLng,
    meshData, contourElevations, activePeaks,
    showContourLines, skylineData,
  ])

  useEffect(() => { redrawCanvas() }, [redrawCanvas])

  // ── Resize observer ────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(redrawCanvas)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [redrawCanvas])

  // ── Pointer drag (heading + pitch) ────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore second finger (pinch uses touch events)
    if (e.isPrimary === false) return
    viewportRef.current?.setPointerCapture(e.pointerId)
    dragState.current = { isDragging: true, lastX: e.clientX, lastY: e.clientY }
    setShowDragHint(false)
  }, [])

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

  // ── Compass offset (uses dynamic fov) ─────────────────────────────────────

  const compassOffset = (() => {
    const headingIndex   = heading_deg / 22.5
    const centerItemIndex = headingIndex + 16
    return -(centerItemIndex * COMPASS_ITEM_WIDTH)
  })()

  // ── Ground elevation for HUD ─────────────────────────────────────────────

  const groundElev = meshData ? sampleMeshBilinear(activeLat, activeLng, meshData) : 0

  // ── Loading state ─────────────────────────────────────────────────────────

  const isLoading = isPrefetching || isSkylineComputing
  const loadingLabel = isPrefetching
    ? 'Loading tiles…'
    : isSkylineComputing
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
          </div>
        )}

        {/* Pitch indicator */}
        <PitchIndicator pitch_deg={pitch_deg} />

        {/* FOV indicator (appears when pinching) */}
        <div className={styles.fovBadge} aria-hidden="true">
          {Math.round(fov)}° FOV
        </div>

        {/* Drag hint */}
        <div
          className={`${styles.dragHint} ${!showDragHint ? styles.hidden : ''}`}
          aria-hidden="true"
        >
          ← Drag to look around — Pinch to zoom →
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
        skylineReady={skylineData !== null}
      />
    </div>
  )
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

const LABEL_STACK_HEIGHT = 98

const PeakLabel: React.FC<{
  pos: PeakScreenPos
  units: 'imperial' | 'metric'
  canvasH: number
}> = ({ pos, units, canvasH }) => {
  const distFade  = Math.max(0.25, 1 - Math.pow(pos.dist_km / (MAX_PEAK_DIST / 1000), 0.5))
  const isNearTop = pos.screenY < canvasH * 0.22

  const topPx = isNearTop
    ? pos.screenY
    : pos.screenY - LABEL_STACK_HEIGHT

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

/** Vertical level gauge on the left edge showing current pitch. */
const PitchIndicator: React.FC<{ pitch_deg: number }> = ({ pitch_deg }) => {
  // Map pitch −80°…+80° → 0…100% (centre = 50%)
  const pct = 50 - (pitch_deg / 80) * 50
  return (
    <div className={styles.pitchIndicator} aria-hidden="true">
      <div className={styles.pitchTrack}>
        <div className={styles.pitchMarker} style={{ top: `${pct}%` }} />
        <div className={styles.pitchZero} />
      </div>
      <span className={styles.pitchLabel}>
        {pitch_deg > 0 ? '+' : ''}{Math.round(pitch_deg)}°
      </span>
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
