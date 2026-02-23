/**
 * EarthContours — EXPLORE Screen
 *
 * 3D terrain view with free-roam navigation: pan, zoom, and orbit.
 * Elevation data rendered using marching squares contour lines, projected
 * into an orthographic 3D view.
 *
 * Navigation (desktop):
 *   Left drag        → pan across terrain
 *   Right drag       → rotate / tilt camera angle
 *   Scroll wheel     → zoom in / out
 *   Double-click     → fly to that terrain location
 *
 * Navigation (mobile / touch):
 *   1 finger drag    → pan across terrain
 *   2 finger pinch   → zoom in / out
 *   2 finger twist   → rotate view (theta)
 *
 * Rendering pipeline:
 * 1. Marching squares extracts contour line segments from the elevation grid
 * 2. Segments offset by pan, projected with orbit camera angles (theta, phi)
 * 3. Scale responds to orbitRadius so scroll-zoom works
 * 4. Peak labels projected using actual terrain maxima found by grid search
 * 5. Location pin (MAP screen selection) rendered as a pulsing HTML dot
 *
 * elevScale = ELEV_BASE_SCALE × verticalExaggeration
 *   ELEV_BASE_SCALE = 1.0 — at 1× exaggeration the terrain height range
 *   equals the terrain width in world units (1:1 square world space)
 *   verticalExaggeration from settings is the sole control over drama
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useCameraStore, useTerrainStore, useSettingsStore, useLocationStore,
} from '../../store'
import { createLogger } from '../../core/logger'
import { formatElevation } from '../../core/utils'
import { DEFAULT_ORBIT_RADIUS } from '../../core/constants'
import { marchingSquares } from '../../renderer/marchingSquares'
import type { Peak, TerrainMeshData } from '../../core/types'
import styles from './ExploreScreen.module.css'

const log = createLogger('SCREEN:EXPLORE')

// At 1× vertical exaggeration, terrain height range equals terrain width in
// world units (1:1). verticalExaggeration is the sole drama control.
const ELEV_BASE_SCALE = 1.0

// --- 3D Projection ------------------------------------------------------------

/**
 * Project a 3D terrain point (gx, gy, gz) to 2D screen coordinates.
 *
 * Coordinate system:
 *   gx: grid X, centered at 0 (east/west). Range after pan: roughly [-0.5, 0.5]
 *   gy: elevation. Range [0, ELEV_BASE_SCALE × verticalExaggeration]
 *   gz: grid Z, centered at 0 (south = positive z)
 *
 * Camera orbit:
 *   theta: rotation around Y axis (horizontal orbit)
 *   phi:   angle from zenith (0.1 = almost top-down, 1.45 = almost side-on)
 *   scale: pixels per world unit — drives zoom (higher = more zoomed in)
 */
function project3D(
  gx: number, gy: number, gz: number,
  theta: number, phi: number,
  cx: number, cy: number,
  scale: number,
): [number, number] {
  // Step 1: Rotate around Y by theta (horizontal orbit)
  const rx = gx * Math.cos(theta) + gz * Math.sin(theta)
  const rz = -gx * Math.sin(theta) + gz * Math.cos(theta)
  const ry = gy

  // Step 2: Rotate around X by phi (vertical tilt)
  const ry2 = ry * Math.cos(phi) - rz * Math.sin(phi)
  const rx2 = rx  // x unchanged by X-axis rotation

  // Orthographic projection (screen y is flipped)
  return [cx + rx2 * scale, cy - ry2 * scale]
}

// --- Canvas Draw --------------------------------------------------------------

/**
 * Render the EXPLORE 3D terrain onto the canvas.
 *
 * elevScale = ELEV_BASE_SCALE * verticalExaggeration
 * panX / panZ shift the terrain in world space (left-drag pan)
 * orbitRadius controls zoom: lower = more zoomed in
 */
function drawExploreCanvas(
  canvas: HTMLCanvasElement,
  mesh: TerrainMeshData,
  contourElevations: number[],
  theta: number,
  phi: number,
  verticalExaggeration: number,
  panX: number,
  panZ: number,
  orbitRadius: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // canvas.width/height are in device pixels (set to rect.width * dpr).
  // ctx.scale(dpr, dpr) is already applied by the caller, so all drawing
  // coordinates must be in CSS pixels. Divide back to get the CSS-pixel
  // dimensions that both this canvas path and the PeakLabels3D HTML overlay use.
  const dpr = window.devicePixelRatio || 1
  const W = canvas.width  / dpr   // CSS pixels — matches containerW in PeakLabels3D
  const H = canvas.height / dpr   // CSS pixels — matches containerH in PeakLabels3D
  const { elevations, width, height, minElevation_m, maxElevation_m } = mesh
  const elevRange = maxElevation_m - minElevation_m || 1

  ctx.fillStyle = '#020e18'
  ctx.fillRect(0, 0, W, H)

  const cx = W / 2
  const cy = H / 2 + H * 0.15  // pushed down so taller terrain stays in frame

  // Scale responds to orbitRadius — scroll-zoom moves terrain closer/further
  const scale = (Math.min(W, H) * 0.62) * (DEFAULT_ORBIT_RADIUS / orbitRadius)

  // Vertical scale: named constant × user setting (no hidden compression)
  const elevScale = ELEV_BASE_SCALE * verticalExaggeration

  // Subtle ground plane ellipse at the terrain base
  const groundY  = cy + (Math.sin(phi) * scale * 0.05)
  const groundRX = scale * 0.52
  const groundRY = scale * 0.52 * Math.abs(Math.cos(phi)) * 0.35 + 4
  ctx.beginPath()
  ctx.ellipse(cx, groundY, groundRX, groundRY, 0, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(18, 75, 107, 0.4)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Draw contour levels from lowest to highest (painter's algorithm)
  for (const elev of contourElevations) {
    const t = (elev - minElevation_m) / elevRange

    // Ocean-depth palette: dark navy (low) -> bright teal-foam (high)
    const r = Math.round(14 + t * (167 - 14))
    const g = Math.round(75 + t * (221 - 75))
    const b = Math.round(107 + t * (229 - 107))
    const opacity = 0.3 + t * 0.55

    ctx.strokeStyle = `rgba(${r},${g},${b},${opacity})`
    ctx.lineWidth = elev % 500 === 0 ? 1.5 : 0.8

    const segments = marchingSquares(elevations, width, height, elev)

    // Map elevation to 3D Y
    const gy = t * elevScale

    ctx.beginPath()
    for (const seg of segments) {
      // Apply pan offset so terrain moves when the user pans
      const gx1 = seg.x1 - 0.5 - panX
      const gz1 = seg.y1 - 0.5 - panZ
      const gx2 = seg.x2 - 0.5 - panX
      const gz2 = seg.y2 - 0.5 - panZ

      const [sx1, sy1] = project3D(gx1, gy, gz1, theta, phi, cx, cy, scale)
      const [sx2, sy2] = project3D(gx2, gy, gz2, theta, phi, cx, cy, scale)

      ctx.moveTo(sx1, sy1)
      ctx.lineTo(sx2, sy2)
    }
    ctx.stroke()
  }

  log.debug('Explore canvas drawn', {
    contours: contourElevations.length,
    theta: theta.toFixed(2),
    phi: phi.toFixed(2),
    panX: panX.toFixed(3),
    panZ: panZ.toFixed(3),
    orbitRadius: orbitRadius.toFixed(2),
  })
}

// --- Main Component -----------------------------------------------------------

const ExploreScreen: React.FC = () => {
  const {
    orbitTheta, orbitPhi, orbitRadius,
    orbitPanX, orbitPanZ,
    applyOrbitDrag, applyOrbitPan, applyOrbitZoom, setOrbitPan,
  } = useCameraStore()

  const { peaks, meshData, contourElevations, activeRegion, isRealElevation } = useTerrainStore()
  const { units, showPeakLabels, verticalExaggeration } = useSettingsStore()
  // Subscribe to location store to show the MAP-selected pin
  const { activeLat, activeLng, mode } = useLocationStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef    = useRef<HTMLCanvasElement>(null)

  // Track all active pointer positions for multi-touch
  const pointerMapRef     = useRef<Map<number, { x: number; y: number }>>(new Map())
  const lastPinchDistRef  = useRef(0)
  const lastPinchAngleRef = useRef(0)
  const isRightClickRef   = useRef(false)

  // Container CSS size kept in state so peak label positions update on resize
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })

  // Controls hint shown only on first visit, persisted in localStorage
  const [showHint, setShowHint] = useState<boolean>(() => {
    try { return !localStorage.getItem('ec_explore_hint_seen') } catch { return true }
  })

  const dismissHint = useCallback(() => {
    setShowHint(false)
    try { localStorage.setItem('ec_explore_hint_seen', '1') } catch { /* ignore */ }
  }, [])

  log.debug('ExploreScreen render', {
    theta: orbitTheta.toFixed(3),
    phi: orbitPhi.toFixed(3),
    radius: orbitRadius.toFixed(2),
    contourCount: contourElevations.length,
    hasMesh: !!meshData,
  })

  // -- Canvas draw effect ------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !meshData || contourElevations.length === 0) return

    const container = containerRef.current
    if (container) {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width  = Math.round(rect.width  * dpr)
        canvas.height = Math.round(rect.height * dpr)
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.scale(dpr, dpr)
        setContainerSize({ w: rect.width, h: rect.height })
      }
    }

    drawExploreCanvas(
      canvas, meshData, contourElevations,
      orbitTheta, orbitPhi, verticalExaggeration,
      orbitPanX, orbitPanZ, orbitRadius,
    )
  }, [orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ, meshData, contourElevations, verticalExaggeration])

  // -- Resize observer ---------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current
    const canvas    = canvasRef.current
    if (!container || !canvas) return

    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && meshData && contourElevations.length > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width  = Math.round(rect.width  * dpr)
        canvas.height = Math.round(rect.height * dpr)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.scale(dpr, dpr)
          drawExploreCanvas(
            canvas, meshData, contourElevations,
            orbitTheta, orbitPhi, verticalExaggeration,
            orbitPanX, orbitPanZ, orbitRadius,
          )
        }
        setContainerSize({ w: rect.width, h: rect.height })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [meshData, contourElevations, orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ, verticalExaggeration])

  // -- Wheel zoom (non-passive so we can call preventDefault) ------------------

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      applyOrbitZoom(e.deltaY > 0 ? 1 : -1)
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [applyOrbitZoom])

  // -- Pointer handlers (pan, rotate, pinch) -----------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    containerRef.current?.setPointerCapture(e.pointerId)
    pointerMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (e.button === 2) isRightClickRef.current = true

    // When 2nd finger touches down, initialise pinch/rotate baseline
    if (pointerMapRef.current.size === 2) {
      const pts = Array.from(pointerMapRef.current.values()) as { x: number; y: number }[]
      const dx  = pts[1].x - pts[0].x
      const dy  = pts[1].y - pts[0].y
      lastPinchDistRef.current  = Math.sqrt(dx * dx + dy * dy)
      lastPinchAngleRef.current = Math.atan2(dy, dx)
    }

    dismissHint()
  }, [dismissHint])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const prev = pointerMapRef.current.get(e.pointerId)
    if (!prev) return

    const pointerCount = pointerMapRef.current.size
    pointerMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointerCount >= 2) {
      // Multi-touch: pinch zoom + 2-finger rotate
      const pts   = Array.from(pointerMapRef.current.values()) as { x: number; y: number }[]
      const dx    = pts[1].x - pts[0].x
      const dy    = pts[1].y - pts[0].y
      const dist  = Math.sqrt(dx * dx + dy * dy)
      const angle = Math.atan2(dy, dx)

      // Pinch zoom
      const distDelta = dist - lastPinchDistRef.current
      if (Math.abs(distDelta) > 0.5) {
        applyOrbitZoom(distDelta > 0 ? -0.4 : 0.4)
        lastPinchDistRef.current = dist
      }

      // 2-finger rotation -> theta (orbit)
      const angleDelta = angle - lastPinchAngleRef.current
      if (Math.abs(angleDelta) > 0.005) {
        applyOrbitDrag(angleDelta * 60, 0)
        lastPinchAngleRef.current = angle
      }

      // 2-finger pan (use this pointer's delta as proxy for midpoint movement)
      applyOrbitPan(e.clientX - prev.x, e.clientY - prev.y)
    } else {
      // Single pointer
      const deltaX = e.clientX - prev.x
      const deltaY = e.clientY - prev.y

      if (isRightClickRef.current || e.buttons === 2) {
        // Right-click drag: rotate + tilt
        applyOrbitDrag(deltaX, deltaY)
      } else {
        // Left-click / 1-finger: pan
        applyOrbitPan(deltaX, deltaY)
      }
    }
  }, [applyOrbitDrag, applyOrbitPan, applyOrbitZoom])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    containerRef.current?.releasePointerCapture(e.pointerId)
    pointerMapRef.current.delete(e.pointerId)
    if (e.button === 2) isRightClickRef.current = false
  }, [])

  // -- Double-click: fly to that terrain location ------------------------------

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current
    if (!container || !meshData) return

    const rect  = container.getBoundingClientRect()
    const sx    = e.clientX - rect.left
    const sy    = e.clientY - rect.top
    const W     = rect.width
    const H     = rect.height
    const cx    = W / 2
    const cy    = H / 2 + H * 0.05
    const scale = (Math.min(W, H) * 0.62) * (DEFAULT_ORBIT_RADIUS / orbitRadius)

    // Invert the orthographic project3D to find world coords at ground plane (gy=0).
    // At gy=0: ry = 0, so ry2 = -rz * sin(phi) => rz = -ry2 / sin(phi)
    const rx2 = (sx - cx) / scale
    const ry2 = (cy - sy) / scale
    const rz  = -ry2 / Math.max(0.1, Math.sin(orbitPhi))

    // Undo theta rotation to get world-relative coords
    const gx_camera = rx2 * Math.cos(orbitTheta) - rz * Math.sin(orbitTheta)
    const gz_camera = rx2 * Math.sin(orbitTheta) + rz * Math.cos(orbitTheta)

    setOrbitPan(gx_camera + orbitPanX, gz_camera + orbitPanZ)

    log.debug('Fly-to double-click', {
      newPanX: (gx_camera + orbitPanX).toFixed(3),
      newPanZ: (gz_camera + orbitPanZ).toFixed(3),
    })
  }, [orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ, setOrbitPan, meshData])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // -- Compute location pin screen position -----------------------------------

  const locationPinScreen = useMemo((): { sx: number; sy: number } | null => {
    if (!meshData || !containerSize.w || mode !== 'exploring') return null

    const { bounds, minElevation_m, maxElevation_m, elevations, width, height } = meshData
    const elevRange = maxElevation_m - minElevation_m || 1

    // Small tolerance so the bounds check doesn't reject locations right on the edge
    const LAT_TOL = (bounds.north - bounds.south) * 0.02
    const LNG_TOL = (bounds.east  - bounds.west)  * 0.02
    if (
      activeLat < bounds.south - LAT_TOL || activeLat > bounds.north + LAT_TOL ||
      activeLng < bounds.west  - LNG_TOL || activeLng > bounds.east  + LNG_TOL
    ) return null

    // Sample terrain elevation at the selected location (nearest-neighbor)
    const col  = Math.round((activeLng - bounds.west)  / (bounds.east  - bounds.west)  * (width  - 1))
    const row  = Math.round((bounds.north - activeLat) / (bounds.north - bounds.south) * (height - 1))
    const c    = Math.max(0, Math.min(width  - 1, col))
    const r    = Math.max(0, Math.min(height - 1, row))
    const elev = elevations[r * width + c] ?? minElevation_m

    // World coordinates in grid space, with pan applied (must match drawExploreCanvas)
    const gx = c / (width  - 1) - 0.5 - orbitPanX
    const gz = r / (height - 1) - 0.5 - orbitPanZ
    const gy = ((elev - minElevation_m) / elevRange) * (ELEV_BASE_SCALE * verticalExaggeration)

    // Project to CSS screen space
    const W     = containerSize.w
    const H     = containerSize.h
    const cx    = W / 2
    const cy    = H / 2 + H * 0.05
    const scale = (Math.min(W, H) * 0.62) * (DEFAULT_ORBIT_RADIUS / orbitRadius)

    const [sx, sy] = project3D(gx, gy, gz, orbitTheta, orbitPhi, cx, cy, scale)
    return { sx, sy }
  }, [
    meshData, activeLat, activeLng, mode,
    orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ,
    verticalExaggeration, containerSize,
  ])

  // -- Loading state -----------------------------------------------------------

  if (!meshData) {
    return (
      <div className={styles.screen}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100%', color: 'var(--ec-text-muted)',
          fontFamily: 'var(--font-display)', letterSpacing: '0.1em',
        }}>
          LOADING TERRAIN...
        </div>
      </div>
    )
  }

  const { minElevation_m, maxElevation_m } = meshData

  return (
    <div className={styles.screen}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <div className={styles.headerTitle}>EXPLORE</div>
          {activeRegion && (
            <div className={styles.regionName}>{activeRegion.name}</div>
          )}
        </div>
        <div
          className={`${styles.dataSourceBadge} ${isRealElevation ? styles.dataSourceReal : styles.dataSourceSim}`}
          aria-label={isRealElevation ? 'Real elevation data from AWS Terrain Tiles' : 'Simulated procedural terrain'}
        >
          {isRealElevation ? '● REAL DATA' : '◌ SIMULATED'}
        </div>
      </div>

      {/* 3D Canvas area */}
      <div
        ref={containerRef}
        className={styles.canvasArea}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        role="application"
        aria-label="3D terrain — drag to pan, right-drag to rotate, scroll to zoom"
      >
        <canvas
          ref={canvasRef}
          className={styles.terrainCanvas}
          aria-hidden="true"
        />

        {/* Peak labels projected using real lat/lng snapped to terrain maxima */}
        {showPeakLabels && containerSize.w > 0 && (
          <div className={styles.peakLabelsLayer}>
            <PeakLabels3D
              peaks={peaks}
              theta={orbitTheta}
              phi={orbitPhi}
              panX={orbitPanX}
              panZ={orbitPanZ}
              orbitRadius={orbitRadius}
              meshData={meshData}
              verticalExaggeration={verticalExaggeration}
              containerW={containerSize.w}
              containerH={containerSize.h}
              units={units}
            />
          </div>
        )}

        {/* Pulsing "you are here" pin at MAP-selected location */}
        {locationPinScreen && (
          <div
            className={styles.locationPin}
            style={{ left: `${locationPinScreen.sx}px`, top: `${locationPinScreen.sy}px` }}
            aria-label="Selected explore location"
          >
            <div className={styles.locationPinRing} aria-hidden="true" />
            <div className={styles.locationPinDot}  aria-hidden="true" />
          </div>
        )}

        {/* Controls hint — shown only on first visit */}
        {showHint && (
          <div
            className={styles.controlsHint}
            onClick={dismissHint}
            role="button"
            aria-label="Dismiss navigation hint"
          >
            <div className={styles.controlsHintTitle}>EXPLORE CONTROLS</div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Drag</span>
              <span className={styles.controlsHintDesc}>Pan terrain</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Right drag</span>
              <span className={styles.controlsHintDesc}>Rotate &amp; tilt</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Scroll</span>
              <span className={styles.controlsHintDesc}>Zoom</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Double-click</span>
              <span className={styles.controlsHintDesc}>Fly to point</span>
            </div>
            <div className={styles.controlsHintDismiss}>tap to dismiss</div>
          </div>
        )}
      </div>

      {/* Elevation legend */}
      <div className={styles.legend} aria-label="Elevation color legend">
        <div className={`${styles.legendLabel} ${styles.legendTop}`}>
          {formatElevation(maxElevation_m, units)}
        </div>
        <div className={styles.legendGradient} aria-hidden="true" />
        <div className={`${styles.legendLabel} ${styles.legendBottom}`}>
          {formatElevation(minElevation_m, units)}
        </div>
      </div>
    </div>
  )
}

// --- Sub-Components -----------------------------------------------------------

/**
 * Peak labels projected to 3D screen space.
 *
 * Instead of using the stored lat/lng directly, each peak is snapped to the
 * actual local maximum in the elevation grid within a search radius. This
 * ensures labels sit on visible terrain peaks regardless of any small
 * coordinate discrepancies between the named list and the elevation tiles.
 *
 * Coordinate pipeline:
 *   peak lat/lng → nominal grid cell → search radius for local max →
 *   grid cell → world space (with pan) → project3D() → CSS px
 */
const PeakLabels3D: React.FC<{
  peaks: Peak[]
  theta: number
  phi: number
  panX: number
  panZ: number
  orbitRadius: number
  meshData: TerrainMeshData
  verticalExaggeration: number
  containerW: number
  containerH: number
  units: 'imperial' | 'metric'
}> = ({ peaks, theta, phi, panX, panZ, orbitRadius, meshData, verticalExaggeration, containerW, containerH, units }) => {
  const { minElevation_m, maxElevation_m, bounds, elevations, width, height } = meshData
  const elevRange = maxElevation_m - minElevation_m || 1
  const elevScale = ELEV_BASE_SCALE * verticalExaggeration

  const cx    = containerW / 2
  const cy    = containerH / 2 + containerH * 0.05  // must match drawExploreCanvas
  const scale = (Math.min(containerW, containerH) * 0.62) * (DEFAULT_ORBIT_RADIUS / orbitRadius)

  // Search radius: ~5 cells in each direction to find actual terrain peak
  const SEARCH_RADIUS = 6

  const topPeaks = [...peaks]
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 5)

  return (
    <>
      {topPeaks.map((peak) => {
        // Skip peaks outside the loaded terrain bounds (with small tolerance)
        const LAT_TOL = (bounds.north - bounds.south) * 0.02
        const LNG_TOL = (bounds.east  - bounds.west)  * 0.02
        if (
          peak.lat < bounds.south - LAT_TOL || peak.lat > bounds.north + LAT_TOL ||
          peak.lng < bounds.west  - LNG_TOL || peak.lng > bounds.east  + LNG_TOL
        ) return null

        // Nominal grid cell from stored lat/lng
        const nomCol = Math.round(
          (peak.lng - bounds.west) / (bounds.east - bounds.west) * (width - 1)
        )
        const nomRow = Math.round(
          (bounds.north - peak.lat) / (bounds.north - bounds.south) * (height - 1)
        )

        // Snap to actual local maximum within search radius
        // This makes the label sit on the visible terrain peak, not just the
        // stored GPS coordinate (which may be slightly off from the tile data)
        let bestElev = -Infinity, bestCol = nomCol, bestRow = nomRow
        for (let dr = -SEARCH_RADIUS; dr <= SEARCH_RADIUS; dr++) {
          for (let dc = -SEARCH_RADIUS; dc <= SEARCH_RADIUS; dc++) {
            const c = Math.max(0, Math.min(width  - 1, nomCol + dc))
            const r = Math.max(0, Math.min(height - 1, nomRow + dr))
            const e = elevations[r * width + c]
            if (e > bestElev) { bestElev = e; bestCol = c; bestRow = r }
          }
        }

        // World coordinates from the actual terrain-maximum cell (with pan)
        const gx = bestCol / (width  - 1) - 0.5 - panX
        const gz = bestRow / (height - 1) - 0.5 - panZ
        const t  = (bestElev - minElevation_m) / elevRange
        const gy = t * elevScale

        // Project to CSS screen space
        const [sx, sy] = project3D(gx, gy, gz, theta, phi, cx, cy, scale)

        // Cull labels that are off-screen (with generous margin)
        if (sx < -80 || sx > containerW + 80 || sy < -60 || sy > containerH + 60) return null

        return (
          <div
            key={peak.id}
            className={styles.peakLabel3D}
            style={{ left: `${sx}px`, top: `${sy}px` }}
          >
            <div className={styles.peakLabelCard}>
              <span className={styles.peakLabelName}>{peak.name}</span>
              <span className={styles.peakLabelElev}>{formatElevation(bestElev, units)}</span>
            </div>
            <div className={styles.peakLine3D} />
            <div className={styles.peakDot3D} />
          </div>
        )
      })}
    </>
  )
}

export default ExploreScreen
