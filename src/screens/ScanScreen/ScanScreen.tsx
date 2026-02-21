/**
 * EarthContours — SCAN Screen
 *
 * The AR first-person terrain view. This is the main/home screen.
 *
 * Layout:
 * ┌─────────────────────────────────────────────┐
 * │ Compass Strip (top, fixed)                  │
 * │─────────────────────────────────────────────│
 * │                                       │     │
 * │          Terrain Viewport            Slider │
 * │     (draggable — changes heading)     │     │
 * │                                       │     │
 * │  Peak labels float above their peaks  │     │
 * │─────────────────────────────────────────────│
 * │ HUD: HDG | LAT | LONG | ELEV | VIEWPT AGL  │
 * └─────────────────────────────────────────────┘
 *
 * Key behaviors:
 * - Drag left/right → changes heading (which direction you face)
 * - Drag up/down → changes pitch (look up/down)
 * - Height slider → changes eye height above ground
 * - Peak labels always appear ABOVE the peak (card → line → dot, top to bottom)
 *
 * Terrain canvas: ray-height-field renderer that casts rays along the heading
 * direction and draws the terrain silhouette based on real elevation data.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCameraStore, useLocationStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import { COMPASS_DIRECTIONS, COMPASS_ITEM_WIDTH, MAX_HEIGHT_M, MIN_HEIGHT_M } from '../../core/constants'
import { formatElevation, calculateBearing, haversineDistance, headingToCompass, clamp, metersToFeet } from '../../core/utils'
import type { Peak, TerrainMeshData } from '../../core/types'
import styles from './ScanScreen.module.css'

const log = createLogger('SCREEN:SCAN')

// ─── Types ────────────────────────────────────────────────────────────────────

interface DragState {
  isDragging: boolean
  lastX: number
  lastY: number
}

// ─── Terrain Canvas Helpers ───────────────────────────────────────────────────

/**
 * Sample elevation at a lat/lng from the terrain mesh.
 * Uses nearest-neighbor lookup — fast for real-time rendering.
 */
function sampleMeshAt(lat: number, lng: number, mesh: TerrainMeshData): number {
  const { bounds, width, height, elevations } = mesh
  const col = Math.round((lng - bounds.west) / (bounds.east - bounds.west) * (width - 1))
  const row = Math.round((bounds.north - lat) / (bounds.north - bounds.south) * (height - 1))
  const c = Math.max(0, Math.min(width - 1, col))
  const r = Math.max(0, Math.min(height - 1, row))
  return elevations[r * width + c] ?? 0
}

/**
 * Ray-height-field terrain renderer.
 *
 * For each screen column, casts a ray at the corresponding bearing angle
 * and finds the highest visible terrain point (the horizon silhouette).
 * Fills sky above the silhouette and terrain below it, with distance-based
 * color shading (dark = far, bright = near).
 *
 * This is a 2.5D technique (the classic Comanche heightmap algorithm).
 */
function drawTerrainCanvas(
  canvas: HTMLCanvasElement,
  mesh: TerrainMeshData,
  heading_deg: number,
  pitch_deg: number,
  eyeHeight_m: number,
  activeLat: number,
  activeLng: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const W = canvas.width
  const H = canvas.height

  const HFOV = 70          // Horizontal field of view (degrees)
  const VFOV = 60          // Vertical field of view (degrees)
  const MAX_DIST = 35000   // Max render distance (meters)
  const STEP_COUNT = 100   // Depth samples per column
  const DEG_TO_RAD = Math.PI / 180

  const groundElev = sampleMeshAt(activeLat, activeLng, mesh)
  const eyeElev = groundElev + eyeHeight_m

  // ── Sky gradient ────────────────────────────────────────────────────────────
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H)
  skyGrad.addColorStop(0,   '#010810')   // deep space
  skyGrad.addColorStop(0.4, '#04121e')   // sky
  skyGrad.addColorStop(0.65, '#082030')  // near horizon
  skyGrad.addColorStop(1,   '#0d2a42')   // horizon
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, H)

  // Horizon Y pixel position (pitch shifts it up/down)
  const pitchRad = pitch_deg * DEG_TO_RAD
  const vfovRad = VFOV * DEG_TO_RAD
  const horizonY = H * 0.5 - pitchRad * (H / vfovRad)

  // Lat factor for converting distances to longitude deltas
  const cosLat = Math.cos(activeLat * DEG_TO_RAD)

  // ── Terrain columns ─────────────────────────────────────────────────────────
  for (let col = 0; col < W; col++) {
    const bearingDeg = heading_deg + (col / W - 0.5) * HFOV
    const bearingRad = bearingDeg * DEG_TO_RAD

    // sin/cos for lat/lng movement along this bearing
    const sinB = Math.sin(bearingRad)
    const cosB = Math.cos(bearingRad)

    let maxTerrainY = H  // lowest point drawn so far (start from bottom)

    // Far-to-near: step from MAX_DIST down to 0, finding new visible terrain
    for (let step = STEP_COUNT; step >= 1; step--) {
      const dist = (step / STEP_COUNT) * MAX_DIST  // meters

      // Approximate lat/lng at this distance along the ray
      const sampleLat = activeLat + (cosB * dist) / 111320
      const sampleLng = activeLng + (sinB * dist) / (111320 * cosLat)

      const terrainElev = sampleMeshAt(sampleLat, sampleLng, mesh)
      const elevDiff = terrainElev - eyeElev

      // Angle from eye to terrain point (positive = above eye)
      const angleRad = Math.atan2(elevDiff, dist)

      // Project to screen Y (below horizon = larger Y)
      const screenY = horizonY - angleRad * (H / vfovRad)

      if (screenY < maxTerrainY) {
        // This terrain is higher on screen — draw the newly visible slice
        const distFrac = step / STEP_COUNT  // 1=far/dark, 0=near/bright

        // Ocean-depth color palette: dark far ridges → brighter near terrain
        const r = Math.round(8  + (1 - distFrac) * 28)
        const g = Math.round(35 + (1 - distFrac) * 85)
        const b = Math.round(55 + (1 - distFrac) * 100)

        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(
          col,
          Math.round(screenY),
          1,
          Math.round(maxTerrainY - screenY) + 1,
        )

        maxTerrainY = screenY
      }
    }
  }

  // ── Horizon glow line ───────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(132, 209, 219, 0.12)'
  ctx.fillRect(0, Math.round(horizonY) - 1, W, 2)

  log.debug('Terrain canvas drawn', {
    heading: heading_deg.toFixed(1),
    pitch: pitch_deg.toFixed(1),
    eyeElev: eyeElev.toFixed(0),
  })
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ScanScreen: React.FC = () => {
  const { heading_deg, pitch_deg, height_m, applyARDrag, setHeightFromSlider } = useCameraStore()
  const { activeLat, activeLng } = useLocationStore()
  const { peaks, meshData } = useTerrainStore()
  const { units, showPeakLabels, showContourLines } = useSettingsStore()

  const viewportRef = useRef<HTMLDivElement>(null)
  const terrainCanvasRef = useRef<HTMLCanvasElement>(null)
  const dragState = useRef<DragState>({ isDragging: false, lastX: 0, lastY: 0 })
  const [showDragHint, setShowDragHint] = useState(true)

  // Height slider drag state
  const sliderRef = useRef<HTMLDivElement>(null)
  const sliderDragRef = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({
    isDragging: false, startY: 0, startHeight: height_m,
  })

  log.debug('ScanScreen render', {
    heading: heading_deg.toFixed(1),
    pitch: pitch_deg.toFixed(1),
    height_m: height_m.toFixed(0),
    peakCount: peaks.length,
    hasMesh: !!meshData,
  })

  // ── Terrain Canvas Draw ───────────────────────────────────────────────────

  useEffect(() => {
    const canvas = terrainCanvasRef.current
    if (!canvas || !meshData) return

    // Set canvas resolution to match display size
    const rect = canvas.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.scale(dpr, dpr)
    }

    drawTerrainCanvas(canvas, meshData, heading_deg, pitch_deg, height_m, activeLat, activeLng)
  }, [heading_deg, pitch_deg, height_m, activeLat, activeLng, meshData])

  // ── Drag Handlers (viewport) ──────────────────────────────────────────────

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

  // ── Height Slider ─────────────────────────────────────────────────────────

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

    const sliderRect = sliderEl.getBoundingClientRect()
    const sliderHeight = sliderRect.height

    const deltaY = e.clientY - sliderDragRef.current.startY
    const heightRange_m = MAX_HEIGHT_M - MIN_HEIGHT_M
    const heightDelta_m = -(deltaY / sliderHeight) * heightRange_m

    const newHeight_m = clamp(
      sliderDragRef.current.startHeight + heightDelta_m,
      MIN_HEIGHT_M,
      MAX_HEIGHT_M,
    )

    setHeightFromSlider(metersToFeet(newHeight_m))
  }, [setHeightFromSlider])

  const handleSliderPointerUp = useCallback((e: React.PointerEvent) => {
    sliderRef.current?.releasePointerCapture(e.pointerId)
    sliderDragRef.current.isDragging = false
    log.debug('Height slider drag end', { height_m: height_m.toFixed(0) })
  }, [height_m])

  // ── Compass ───────────────────────────────────────────────────────────────

  const compassOffset = (() => {
    const headingIndex = heading_deg / 22.5
    const centerItemIndex = headingIndex + 16
    return -(centerItemIndex * COMPASS_ITEM_WIDTH)
  })()

  // ── Peak Label Positions ──────────────────────────────────────────────────

  const visiblePeaks = peaks
    .map((peak) => {
      const bearing = calculateBearing(
        { lat: activeLat, lng: activeLng },
        { lat: peak.lat, lng: peak.lng },
      )
      const distance_km = haversineDistance(
        { lat: activeLat, lng: activeLng },
        { lat: peak.lat, lng: peak.lng },
      )

      let angleDiff = bearing - heading_deg
      while (angleDiff > 180) angleDiff -= 360
      while (angleDiff < -180) angleDiff += 360

      return { peak, bearing, distance_km, angleDiff }
    })
    .filter(({ angleDiff, distance_km }) =>
      Math.abs(angleDiff) < 65 && distance_km < 120
    )
    .slice(0, 6)

  return (
    <div className={styles.screen}>
      {/* ── Compass Strip ────────────────────────────────────────────────── */}
      <div className={styles.compassStrip} role="img" aria-label={`Compass showing ${headingToCompass(heading_deg)} at ${Math.round(heading_deg)}°`}>
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

      {/* ── Terrain Viewport (draggable) ──────────────────────────────────── */}
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
        {/* Ray-height-field terrain canvas */}
        <canvas
          ref={terrainCanvasRef}
          className={styles.terrainCanvas}
          aria-hidden="true"
        />

        {/* Contour line overlay */}
        {showContourLines && (
          <ContourOverlay
            heading={heading_deg}
            pitch={pitch_deg}
          />
        )}

        {/* ── Peak Labels ───────────────────────────────────────────────── */}
        {showPeakLabels && (
          <div className={styles.peakLabelsLayer} aria-label="Peak labels">
            {visiblePeaks.map(({ peak, angleDiff, distance_km, bearing }) => (
              <PeakLabelComponent
                key={peak.id}
                peak={peak}
                angleDiff={angleDiff}
                distance_km={distance_km}
                bearing={bearing}
                units={units}
              />
            ))}
          </div>
        )}

        {/* Drag hint */}
        <div className={`${styles.dragHint} ${!showDragHint ? styles.hidden : ''}`} aria-hidden="true">
          ← Drag to look around →
        </div>
      </div>

      {/* ── Height Slider ─────────────────────────────────────────────────── */}
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
            style={{
              height: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%`,
            }}
            aria-hidden="true"
          />
          <div
            className={styles.heightSliderThumb}
            style={{
              bottom: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%`,
            }}
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

      {/* ── HUD Bar ──────────────────────────────────────────────────────── */}
      <HUDBar
        heading_deg={heading_deg}
        lat={activeLat}
        lng={activeLng}
        groundElev_m={meshData ? getGroundElevation(meshData.elevations, meshData.width, meshData.height) : 0}
        eyeHeight_m={height_m}
        units={units}
      />
    </div>
  )
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

interface PeakLabelProps {
  peak: Peak
  angleDiff: number
  distance_km: number
  bearing: number
  units: 'imperial' | 'metric'
}

const PeakLabelComponent: React.FC<PeakLabelProps> = ({
  peak, angleDiff, distance_km, bearing, units,
}) => {
  const leftPercent = 50 + (angleDiff / 65) * 45
  const maxDist = 120
  const topPercent = 15 + (1 - Math.min(distance_km, maxDist) / maxDist) * 35

  return (
    <div
      className={styles.peakLabel}
      style={{ left: `${leftPercent}%`, top: `${topPercent}%` }}
      role="img"
      aria-label={`${peak.name}, ${formatElevation(peak.elevation_m, units)}, ${Math.round(distance_km)} km away`}
    >
      <div className={styles.peakCard}>
        <span className={styles.peakName}>{peak.name}</span>
        <span className={styles.peakElev}>{formatElevation(peak.elevation_m, units)}</span>
        <span className={styles.peakBearing}>{headingToCompass(bearing)} · {distance_km.toFixed(0)} km</span>
      </div>
      <div className={styles.peakLine} aria-hidden="true" />
      <div className={styles.peakDot} aria-hidden="true" />
    </div>
  )
}

const ContourOverlay: React.FC<{ heading: number; pitch: number }> = ({ heading, pitch }) => {
  const lines = [
    { y: 55, opacity: 0.12, width: '100%' },
    { y: 62, opacity: 0.15, width: '90%' },
    { y: 68, opacity: 0.2, width: '75%' },
    { y: 74, opacity: 0.25, width: '60%' },
    { y: 80, opacity: 0.2, width: '45%' },
  ]

  return (
    <svg
      className={styles.contourOverlay}
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      {lines.map((line, i) => (
        <path
          key={i}
          d={`M ${(100 - parseInt(line.width)) / 2}% ${line.y + pitch * 0.1}% Q 50% ${line.y - 3 + pitch * 0.1}% ${100 - (100 - parseInt(line.width)) / 2}% ${line.y + pitch * 0.1}%`}
          stroke="rgba(132, 209, 219, 1)"
          strokeWidth="1"
          fill="none"
          opacity={line.opacity}
        />
      ))}
    </svg>
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
  const latStr = `${lat.toFixed(4)}°`
  const lngStr = `${Math.abs(lng).toFixed(4)}°${lng < 0 ? 'W' : 'E'}`
  const elevStr = formatElevation(groundElev_m, units)
  const eyeStr = formatElevation(eyeHeight_m, units)

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
        {/* VIEWPT = viewpoint elevation above ground level (AGL) */}
        <span className={styles.hudLabel}>VIEWPT</span>
        <span className={styles.hudValue}>{eyeStr}</span>
        <span className={styles.hudSubLabel}>AGL</span>
      </div>
    </div>
  )
}

function getGroundElevation(elevations: Float32Array, width: number, height: number): number {
  const centerIdx = Math.floor(height / 2) * width + Math.floor(width / 2)
  return elevations[centerIdx] ?? 2400
}

export default ScanScreen
