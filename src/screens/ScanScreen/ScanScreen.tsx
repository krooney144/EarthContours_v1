/**
 * EarthContours — SCAN Screen  (v1.4)
 *
 * First-person terrain panorama with PeakFinder-style aesthetics.
 *
 * ── Rendering architecture ───────────────────────────────────────────────────
 *  Worker computes a 720-azimuth 360° skyline in background (tiles + ray march).
 *  Main thread shows sky + loading overlay while worker runs, then snaps to the
 *  full panorama on worker completion — O(W) per frame during panning (QUICK path).
 *
 * ── Layers (painter's order) ─────────────────────────────────────────────────
 *   1  Sky gradient   — deep void → atmospheric haze with horizon glow
 *   2  Terrain fill   — silhouette fill from ridgeline to bottom (worker skyline)
 *   3  Horizon glow   — thin teal line at the horizon
 *   4  Peak labels    — HTML overlay; only visible ridgeline peaks, max 15
 *
 * ── Peak visibility ──────────────────────────────────────────────────────────
 *   isPeakVisible() compares peak elevation angle against skyline ridgeline angle
 *   at that azimuth. Dots are snapped to the ridgeline Y so they sit on the ridge.
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

// ─── Peak Visibility Check ────────────────────────────────────────────────────

/**
 * Check if a peak is visible above the terrain ridgeline.
 * Uses pre-computed SkylineData to compare the peak's elevation angle
 * against the maximum terrain angle at that azimuth.
 */
function isPeakVisible(
  peak: Peak,
  viewerLat: number, viewerLng: number, viewerElev: number,
  heading_deg: number, hfov: number,
  skyline: SkylineData,
): boolean {
  const cosLat = Math.cos(viewerLat * DEG_TO_RAD)
  const dx = (peak.lng - viewerLng) * 111_320 * cosLat
  const dy = (peak.lat - viewerLat) * 111_132
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist > MAX_PEAK_DIST || dist < 100) return false

  // Bearing from viewer to peak
  const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360

  // Check if peak is within the current FOV (with margin)
  let angleDiff = bearing - heading_deg
  if (angleDiff > 180) angleDiff -= 360
  if (angleDiff < -180) angleDiff += 360
  if (Math.abs(angleDiff) > hfov * 0.6) return false  // outside FOV

  // Earth curvature correction
  const curvDrop = (dist * dist) / (2 * EARTH_R) * (1 - REFRACTION_K)
  const peakAngle = Math.atan2(peak.elevation_m - curvDrop - viewerElev, dist)

  // Ridgeline angle at this azimuth from skyline data
  const normBearing = ((bearing % 360) + 360) % 360
  const aziIdx = Math.round(normBearing * skyline.resolution) % skyline.numAzimuths
  const ridgeAngle = skyline.angles[aziIdx]

  // Peak is visible if its elevation angle is at or above the ridgeline.
  // Allow a small tolerance (0.15°) so peaks right at the ridge still show.
  const tolerance = 0.15 * DEG_TO_RAD
  return peakAngle >= ridgeAngle - tolerance
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
  peaks: Peak[],
  heading_deg: number,
  pitch_deg: number,
  eyeHeight_m: number,
  activeLat: number,
  activeLng: number,
  hfov: number,
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
    drawFromSkyline(ctx, skylineData, heading_deg, pitch_deg, hfov, W, H)
  }
  // else: no terrain drawn — loading overlay shows "Computing panorama..."

  // ── 3. Horizon glow ──────────────────────────────────────────────────────────
  // Soft teal glow centred on the horizon line
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

  // Filter to visible peaks, then take top ~15 by elevation to prevent label clutter
  const visiblePeaks = skylineData
    ? peaks.filter(p => isPeakVisible(p, activeLat, activeLng, eyeElev, heading_deg, hfov, skylineData))
    : peaks.filter(p => {
        // Without skyline, just check FOV + distance (basic filter)
        const cosLat = Math.cos(activeLat * DEG_TO_RAD)
        const dx = (p.lng - activeLng) * 111_320 * cosLat
        const dy = (p.lat - activeLat) * 111_132
        const dist = Math.sqrt(dx * dx + dy * dy)
        return dist <= MAX_PEAK_DIST && dist > 100
      })

  // Sort by elevation descending, take top 15
  const topPeaks = visiblePeaks
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 15)

  for (const peak of topPeaks) {
    const projected = projectFirstPerson(
      peak.lat, peak.lng, peak.elevation_m,
      activeLat, activeLng, eyeElev,
      heading_deg, pitch_deg, hfov, W, H,
    )
    if (!projected) continue

    let { screenX, screenY, horizDist } = projected
    if (screenX < -50 || screenX > W + 50) continue
    if (horizDist > MAX_PEAK_DIST) continue

    // Snap dot to ridgeline Y position when skyline data is available
    if (skylineData) {
      const bearing = calculateBearing(
        { lat: activeLat, lng: activeLng },
        { lat: peak.lat, lng: peak.lng },
      )
      const normBearing = ((bearing % 360) + 360) % 360
      const aziIdx = Math.round(normBearing * skylineData.resolution) % skylineData.numAzimuths
      const ridgeAngle = skylineData.angles[aziIdx]

      const vfovRad = VFOV * DEG_TO_RAD
      const ridgeScreenY = horizonY - ridgeAngle * (H / vfovRad)

      // Use the lower screen position (higher pixel Y = lower in image) of:
      // ridgeline position vs geometric position — dot sits at the ridge, never floating in sky
      screenY = Math.max(ridgeScreenY, screenY)
    }

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
    mode:         skylineData ? 'quick/skyline' : 'loading',
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
  const { peaks, meshData } = useTerrainStore()
  const { units, showPeakLabels } = useSettingsStore()

  const viewportRef      = useRef<HTMLDivElement>(null)
  const terrainCanvasRef = useRef<HTMLCanvasElement>(null)
  const dragState        = useRef<DragState>({ isDragging: false, lastX: 0, lastY: 0 })
  const pinchState       = useRef<PinchState>({ isPinching: false, lastDist: 0, startFov: fov })
  const sliderRef        = useRef<HTMLDivElement>(null)
  const sliderDragRef    = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })

  // Phase 2 infrastructure
  const skylineWorker  = useRef<Worker | null>(null)
  const rafRef         = useRef<number>(0)

  const [showDragHint, setShowDragHint]       = useState(true)
  const [peakPositions, setPeakPositions]     = useState<PeakScreenPos[]>([])
  const [canvasCSSSize, setCanvasCSSSize]     = useState({ w: 0, h: 0 })
  const [skylineData, setSkylineData]         = useState<SkylineData | null>(null)
  const [osmPeaks, setOsmPeaks]               = useState<Peak[]>([])
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

  // ── Skyline computation on location change ────────────────────────────────
  // Only the worker fetches tiles — main thread shows loading state until done.

  useEffect(() => {
    if (!meshData) return

    // Clear stale skyline so loading overlay shows while worker computes
    setSkylineData(null)
    setSkylineProgress(0)

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
    if (!canvas || !meshData) return
    if (canvas.width === 0 || canvas.height === 0) return

    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Reset transform without reallocating the pixel buffer
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const rawPos = drawScanCanvas(
      canvas, meshData,
      activePeaks,
      heading_deg, pitch_deg, height_m,
      activeLat, activeLng,
      fov, skylineData,
    )

    setPeakPositions(rawPos.map(p => ({
      ...p,
      screenX: p.screenX / dpr,
      screenY: p.screenY / dpr,
    })))
  }, [
    heading_deg, pitch_deg, height_m, fov,
    activeLat, activeLng,
    meshData, activePeaks,
    skylineData,
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

const LABEL_STACK_HEIGHT = 75

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
