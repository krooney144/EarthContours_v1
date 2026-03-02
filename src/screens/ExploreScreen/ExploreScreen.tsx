/**
 * EarthContours — EXPLORE Screen  (v1.1 — ENU metre-space)
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
 * ── Coordinate system ────────────────────────────────────────────────────────
 *
 * All world coordinates are in a local ENU (East-North-Up) frame centred on
 * the loaded region's geographic centre (lat0, lon0):
 *
 *   x_m = (col / (w-1) - 0.5) * terrainWidth_m  − pivotX_m   east/west
 *   z_m = (row / (h-1) - 0.5) * terrainDepth_m  − pivotZ_m   north/south (z+ = south in grid)
 *   y_m = (elevation_m − minElevation_m) × verticalExaggeration  up
 *
 *   scale  = pixels per metre  = (min(W,H) × 0.62) / orbitRadius
 *   pivot  = (panX × terrainWidth_m,  panZ × terrainDepth_m)   in metres from terrain centre
 *
 * The ONLY thing that scales the Y (elevation) axis is verticalExaggeration.
 * No hidden multipliers.  At 1× exaggeration, 1 m of elevation = 1 m of world Y.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useCameraStore, useTerrainStore, useSettingsStore, useLocationStore,
} from '../../store'
import { createLogger } from '../../core/logger'
import { formatElevation } from '../../core/utils'
import { ENU_M_PER_DEG_LAT, ENU_M_PER_DEG_LON_AT_LAT } from '../../core/constants'
import { marchingSquares } from '../../renderer/marchingSquares'
import type { Peak, TerrainMeshData } from '../../core/types'
import styles from './ExploreScreen.module.css'

const log = createLogger('SCREEN:EXPLORE')

// ─── ENU Layout Helper ────────────────────────────────────────────────────────

/**
 * Pre-compute all projection constants that must be identical between the
 * canvas renderer and the HTML label overlay.  Called once per render frame.
 *
 * Returns values in metres (world space) and CSS pixels (screen space).
 */
function computeENULayout(
  mesh: TerrainMeshData,
  orbitRadius: number,
  orbitPhi: number,
  verticalExaggeration: number,
  W: number,
  H: number,
) {
  const lat0 = (mesh.bounds.north + mesh.bounds.south) / 2
  const MPD_LON = ENU_M_PER_DEG_LON_AT_LAT(lat0)

  const terrainWidth_m = (mesh.bounds.east  - mesh.bounds.west)  * MPD_LON
  const terrainDepth_m = (mesh.bounds.north - mesh.bounds.south) * ENU_M_PER_DEG_LAT
  const elevRange_m    = mesh.maxElevation_m - mesh.minElevation_m || 1

  // pixels per metre — zoom controlled entirely by orbitRadius
  const scale = Math.min(W, H) * 0.62 / orbitRadius

  const cx = W / 2
  // Push cy down so the full terrain height is centred on screen:
  // half the projected terrain elevation range shifts the view downward
  const cy = H / 2 + (elevRange_m * verticalExaggeration * scale * Math.sin(orbitPhi)) * 0.45

  return { terrainWidth_m, terrainDepth_m, elevRange_m, scale, cx, cy }
}

// ─── 3D Projection ────────────────────────────────────────────────────────────

/**
 * Project an ENU world point (x_m, y_m, z_m) in metres to CSS pixel screen coords.
 *
 * theta  — horizontal orbit angle (radians)
 * phi    — vertical tilt from zenith (radians; 0.1 = top-down, 1.45 = side-on)
 * scale  — pixels per metre (from computeENULayout)
 * cx, cy — screen-space projection centre (CSS pixels)
 */
function project3D(
  x_m: number, y_m: number, z_m: number,
  theta: number, phi: number,
  cx: number, cy: number,
  scale: number,
): [number, number] {
  // Rotate around Y (vertical) by theta — horizontal orbit
  const rx = x_m * Math.cos(theta) + z_m * Math.sin(theta)
  const rz = -x_m * Math.sin(theta) + z_m * Math.cos(theta)
  const ry = y_m

  // Rotate around X by phi — vertical tilt
  const ry2 = ry * Math.cos(phi) - rz * Math.sin(phi)
  const rx2 = rx

  // Orthographic projection (screen-y is flipped: up = negative screen-y)
  return [cx + rx2 * scale, cy - ry2 * scale]
}

// ─── Canvas Draw ──────────────────────────────────────────────────────────────

/**
 * Render the EXPLORE terrain onto the 2D canvas.
 *
 * All world coordinates are in ENU metres.  The canvas is assumed to have
 * ctx.scale(dpr, dpr) already applied by the caller, so this function works
 * entirely in CSS pixels.
 */
function drawExploreCanvas(
  canvas: HTMLCanvasElement,
  mesh: TerrainMeshData,
  contourElevations: number[],
  theta: number,
  phi: number,
  verticalExaggeration: number,
  panX: number,   // normalised fraction of terrainWidth_m  [-0.5, 0.5]
  panZ: number,   // normalised fraction of terrainDepth_m  [-0.5, 0.5]
  orbitRadius: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // Work in CSS pixels so this matches the PeakLabels3D HTML overlay.
  const dpr = window.devicePixelRatio || 1
  const W = canvas.width  / dpr
  const H = canvas.height / dpr

  const { elevations, width, height, minElevation_m, maxElevation_m } = mesh
  const { terrainWidth_m, terrainDepth_m, scale, cx, cy } =
    computeENULayout(mesh, orbitRadius, phi, verticalExaggeration, W, H)

  // Pivot in metres (where the camera is looking)
  const pivotX_m = panX * terrainWidth_m
  const pivotZ_m = panZ * terrainDepth_m

  ctx.fillStyle = '#020e18'
  ctx.fillRect(0, 0, W, H)

  // ── Solid terrain surface fill (painter's order: back → front) ────────────
  // Render each grid cell as a filled quad so the terrain is an opaque shape.
  // Fill colour uses a very dark version of the ocean-depth palette so contour
  // lines drawn on top remain prominent.
  const elevRange = maxElevation_m - minElevation_m || 1

  // Determine grid traversal order based on camera angle so back cells are
  // painted first (painter's algorithm).  theta determines which corner is
  // "far" from the camera.
  const normTheta = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const rowStart = (normTheta > Math.PI / 2 && normTheta < 3 * Math.PI / 2) ? height - 2 : 0
  const rowEnd   = rowStart === 0 ? height - 1 : -1
  const rowStep  = rowStart === 0 ? 1 : -1
  const colStart = (normTheta > Math.PI) ? width - 2 : 0
  const colEnd   = colStart === 0 ? width - 1 : -1
  const colStep  = colStart === 0 ? 1 : -1

  // Downsample for performance — skip every Nth cell on large grids
  const cellCount = (width - 1) * (height - 1)
  const step = cellCount > 80000 ? 2 : 1

  for (let row = rowStart; row !== rowEnd; row += rowStep * step) {
    for (let col = colStart; col !== colEnd; col += colStep * step) {
      const r0 = Math.min(row, height - 2)
      const c0 = Math.min(col, width  - 2)
      const c1 = Math.min(c0 + step, width  - 1)
      const r1 = Math.min(r0 + step, height - 1)

      // Four corner elevations
      const e00 = elevations[r0 * width + c0]
      const e10 = elevations[r0 * width + c1]
      const e01 = elevations[r1 * width + c0]
      const e11 = elevations[r1 * width + c1]
      const avgElev = (e00 + e10 + e01 + e11) / 4

      // Normalised elevation [0,1]
      const t = (avgElev - minElevation_m) / elevRange

      // Very dark ocean-depth fill — dark enough that contour strokes pop
      const fr = Math.round(2  + t * (30  - 2))
      const fg = Math.round(10 + t * (55  - 10))
      const fb = Math.round(18 + t * (70  - 18))

      // Project all four corners to screen
      const x00 = (c0 / (width  - 1) - 0.5) * terrainWidth_m - pivotX_m
      const z00 = (r0 / (height - 1) - 0.5) * terrainDepth_m - pivotZ_m
      const y00 = (e00 - minElevation_m) * verticalExaggeration

      const x10 = (c1 / (width  - 1) - 0.5) * terrainWidth_m - pivotX_m
      const z10 = (r0 / (height - 1) - 0.5) * terrainDepth_m - pivotZ_m
      const y10 = (e10 - minElevation_m) * verticalExaggeration

      const x11 = (c1 / (width  - 1) - 0.5) * terrainWidth_m - pivotX_m
      const z11 = (r1 / (height - 1) - 0.5) * terrainDepth_m - pivotZ_m
      const y11 = (e11 - minElevation_m) * verticalExaggeration

      const x01 = (c0 / (width  - 1) - 0.5) * terrainWidth_m - pivotX_m
      const z01 = (r1 / (height - 1) - 0.5) * terrainDepth_m - pivotZ_m
      const y01 = (e01 - minElevation_m) * verticalExaggeration

      const [sx00, sy00] = project3D(x00, y00, z00, theta, phi, cx, cy, scale)
      const [sx10, sy10] = project3D(x10, y10, z10, theta, phi, cx, cy, scale)
      const [sx11, sy11] = project3D(x11, y11, z11, theta, phi, cx, cy, scale)
      const [sx01, sy01] = project3D(x01, y01, z01, theta, phi, cx, cy, scale)

      ctx.fillStyle = `rgb(${fr},${fg},${fb})`
      ctx.beginPath()
      ctx.moveTo(sx00, sy00)
      ctx.lineTo(sx10, sy10)
      ctx.lineTo(sx11, sy11)
      ctx.lineTo(sx01, sy01)
      ctx.closePath()
      ctx.fill()
    }
  }

  // ── Contour lines (painter's algorithm: low → high) ───────────────────────

  for (const elev of contourElevations) {
    const t = (elev - minElevation_m) / elevRange  // used only for colour

    // Ocean-depth palette: dark navy (low) → bright teal-foam (high)
    const r = Math.round(14  + t * (167 - 14))
    const g = Math.round(75  + t * (221 - 75))
    const b = Math.round(107 + t * (229 - 107))
    const opacity = 0.3 + t * 0.55

    ctx.strokeStyle = `rgba(${r},${g},${b},${opacity})`
    ctx.lineWidth = elev % 500 === 0 ? 1.5 : 0.8

    const segments = marchingSquares(elevations, width, height, elev)

    // ENU Y: elevation relative to terrain base, then exaggerated
    const y_m = (elev - minElevation_m) * verticalExaggeration

    ctx.beginPath()
    for (const seg of segments) {
      // marching squares output: seg.x / seg.y are in [0,1] grid-normalised space
      // Convert to ENU metres centred on terrain, then subtract pivot
      const x1 = (seg.x1 - 0.5) * terrainWidth_m - pivotX_m
      const z1 = (seg.y1 - 0.5) * terrainDepth_m - pivotZ_m
      const x2 = (seg.x2 - 0.5) * terrainWidth_m - pivotX_m
      const z2 = (seg.y2 - 0.5) * terrainDepth_m - pivotZ_m

      const [sx1, sy1] = project3D(x1, y_m, z1, theta, phi, cx, cy, scale)
      const [sx2, sy2] = project3D(x2, y_m, z2, theta, phi, cx, cy, scale)

      ctx.moveTo(sx1, sy1)
      ctx.lineTo(sx2, sy2)
    }
    ctx.stroke()
  }

  log.debug('Explore canvas drawn (ENU)', {
    terrainWidth_km: (terrainWidth_m / 1000).toFixed(1),
    elevRange_m: elevRange.toFixed(0),
    scale_pxpm: scale.toExponential(3),
    orbitRadius_m: orbitRadius.toFixed(0),
  })
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ExploreScreen: React.FC = () => {
  const {
    orbitTheta, orbitPhi, orbitRadius,
    orbitPanX, orbitPanZ,
    applyOrbitDrag, applyOrbitPan, applyOrbitZoom, setOrbitPan,
    initOrbitCamera,
  } = useCameraStore()

  const { peaks, meshData, contourElevations, activeRegion, isRealElevation } = useTerrainStore()
  const { units, showPeakLabels, verticalExaggeration } = useSettingsStore()
  const { activeLat, activeLng, mode } = useLocationStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef    = useRef<HTMLCanvasElement>(null)

  const pointerMapRef     = useRef<Map<number, { x: number; y: number }>>(new Map())
  const lastPinchDistRef  = useRef(0)
  const lastPinchAngleRef = useRef(0)
  const isRightClickRef   = useRef(false)

  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })

  const [showHint, setShowHint] = useState<boolean>(() => {
    try { return !localStorage.getItem('ec_explore_hint_seen') } catch { return true }
  })

  const dismissHint = useCallback(() => {
    setShowHint(false)
    try { localStorage.setItem('ec_explore_hint_seen', '1') } catch { /* ignore */ }
  }, [])

  // ── Init camera when terrain loads ─────────────────────────────────────────
  // Called whenever a new terrain mesh is loaded.  Sets orbitRadius so the
  // full terrain is visible at the default view angle.
  useEffect(() => {
    if (!meshData) return
    const terrainWidth_m = meshData.worldWidth_km * 1000
    initOrbitCamera(terrainWidth_m)
    log.info('Camera initialised for new terrain', { terrainWidth_m })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshData])  // intentionally omit initOrbitCamera — stable store action

  // ── Canvas draw effect ─────────────────────────────────────────────────────

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

  // ── Resize observer ────────────────────────────────────────────────────────

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

  // ── Wheel zoom (non-passive) ───────────────────────────────────────────────

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

  // ── Pointer handlers ───────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    containerRef.current?.setPointerCapture(e.pointerId)
    pointerMapRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (e.button === 2) isRightClickRef.current = true
    if (pointerMapRef.current.size === 2) {
      const pts = Array.from(pointerMapRef.current.values()) as { x: number; y: number }[]
      const dx = pts[1].x - pts[0].x
      const dy = pts[1].y - pts[0].y
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
      const pts   = Array.from(pointerMapRef.current.values()) as { x: number; y: number }[]
      const dx    = pts[1].x - pts[0].x
      const dy    = pts[1].y - pts[0].y
      const dist  = Math.sqrt(dx * dx + dy * dy)
      const angle = Math.atan2(dy, dx)

      const distDelta = dist - lastPinchDistRef.current
      if (Math.abs(distDelta) > 0.5) {
        applyOrbitZoom(distDelta > 0 ? -0.4 : 0.4)
        lastPinchDistRef.current = dist
      }

      const angleDelta = angle - lastPinchAngleRef.current
      if (Math.abs(angleDelta) > 0.005) {
        applyOrbitDrag(angleDelta * 60, 0)
        lastPinchAngleRef.current = angle
      }

      applyOrbitPan(e.clientX - prev.x, e.clientY - prev.y)
    } else {
      const deltaX = e.clientX - prev.x
      const deltaY = e.clientY - prev.y
      if (isRightClickRef.current || e.buttons === 2) {
        applyOrbitDrag(deltaX, deltaY)
      } else {
        applyOrbitPan(deltaX, deltaY)
      }
    }
  }, [applyOrbitDrag, applyOrbitPan, applyOrbitZoom])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    containerRef.current?.releasePointerCapture(e.pointerId)
    pointerMapRef.current.delete(e.pointerId)
    if (e.button === 2) isRightClickRef.current = false
  }, [])

  // ── Double-click: fly to terrain point ────────────────────────────────────
  // Inverts the orthographic projection at the terrain base plane (y_m = 0)
  // to find the ENU world position under the click, then sets the pan pivot
  // so the camera re-centres on that point.

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current
    if (!container || !meshData) return

    const rect = container.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const W  = rect.width
    const H  = rect.height

    const { terrainWidth_m, terrainDepth_m, scale, cx, cy } =
      computeENULayout(meshData, orbitRadius, orbitPhi, verticalExaggeration, W, H)

    // Invert project3D at y_m = 0 (terrain base plane)
    const rx2 = (sx - cx) / scale
    const ry2 = (cy - sy) / scale
    const rz  = -ry2 / Math.max(0.1, Math.sin(orbitPhi))

    // Undo theta rotation to recover ENU world offset from pivot
    const dx_m = rx2 * Math.cos(orbitTheta) - rz * Math.sin(orbitTheta)
    const dz_m = rx2 * Math.sin(orbitTheta) + rz * Math.cos(orbitTheta)

    // New pivot in metres from terrain centre, then normalise back to fraction
    const newPivotX_m = orbitPanX * terrainWidth_m + dx_m
    const newPivotZ_m = orbitPanZ * terrainDepth_m + dz_m

    setOrbitPan(newPivotX_m / terrainWidth_m, newPivotZ_m / terrainDepth_m)

    log.debug('Fly-to double-click', {
      dx_m: dx_m.toFixed(0), dz_m: dz_m.toFixed(0),
      newPanX: (newPivotX_m / terrainWidth_m).toFixed(3),
      newPanZ: (newPivotZ_m / terrainDepth_m).toFixed(3),
    })
  }, [orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ, setOrbitPan, meshData, verticalExaggeration])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // ── Location pin screen position ───────────────────────────────────────────

  const locationPinScreen = useMemo((): { sx: number; sy: number } | null => {
    if (!meshData || !containerSize.w || mode !== 'exploring') return null

    const { bounds, minElevation_m, elevations, width, height } = meshData

    const LAT_TOL = (bounds.north - bounds.south) * 0.02
    const LNG_TOL = (bounds.east  - bounds.west)  * 0.02
    if (
      activeLat < bounds.south - LAT_TOL || activeLat > bounds.north + LAT_TOL ||
      activeLng < bounds.west  - LNG_TOL || activeLng > bounds.east  + LNG_TOL
    ) return null

    const col  = Math.round((activeLng - bounds.west)  / (bounds.east  - bounds.west)  * (width  - 1))
    const row  = Math.round((bounds.north - activeLat) / (bounds.north - bounds.south) * (height - 1))
    const c    = Math.max(0, Math.min(width  - 1, col))
    const r    = Math.max(0, Math.min(height - 1, row))
    const elev = elevations[r * width + c] ?? minElevation_m

    const W = containerSize.w
    const H = containerSize.h
    const { terrainWidth_m, terrainDepth_m, scale, cx, cy } =
      computeENULayout(meshData, orbitRadius, orbitPhi, verticalExaggeration, W, H)

    const pivotX_m = orbitPanX * terrainWidth_m
    const pivotZ_m = orbitPanZ * terrainDepth_m

    const x_m = (c / (width  - 1) - 0.5) * terrainWidth_m - pivotX_m
    const z_m = (r / (height - 1) - 0.5) * terrainDepth_m - pivotZ_m
    const y_m = (elev - minElevation_m) * verticalExaggeration

    const [sx, sy] = project3D(x_m, y_m, z_m, orbitTheta, orbitPhi, cx, cy, scale)
    return { sx, sy }
  }, [
    meshData, activeLat, activeLng, mode,
    orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ,
    verticalExaggeration, containerSize,
  ])

  // ── Loading state ──────────────────────────────────────────────────────────

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

// ─── PeakLabels3D ─────────────────────────────────────────────────────────────

/**
 * HTML overlay that renders peak labels projected into the same ENU world space
 * as the canvas.  Uses computeENULayout() to guarantee identical scale / cx / cy
 * values, so labels stay locked to their contour peaks at all zoom/pan levels.
 *
 * Each peak is snapped to the actual local maximum in the elevation grid within
 * a small search radius — this corrects for minor discrepancies between the
 * stored GPS coordinate and the actual tile data.
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
  const { minElevation_m, bounds, elevations, width, height } = meshData

  const { terrainWidth_m, terrainDepth_m, scale, cx, cy } =
    computeENULayout(meshData, orbitRadius, phi, verticalExaggeration, containerW, containerH)

  const pivotX_m = panX * terrainWidth_m
  const pivotZ_m = panZ * terrainDepth_m

  const SEARCH_RADIUS = 6

  const topPeaks = [...peaks]
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 5)

  return (
    <>
      {topPeaks.map((peak) => {
        const LAT_TOL = (bounds.north - bounds.south) * 0.02
        const LNG_TOL = (bounds.east  - bounds.west)  * 0.02
        if (
          peak.lat < bounds.south - LAT_TOL || peak.lat > bounds.north + LAT_TOL ||
          peak.lng < bounds.west  - LNG_TOL || peak.lng > bounds.east  + LNG_TOL
        ) return null

        const nomCol = Math.round((peak.lng - bounds.west)  / (bounds.east  - bounds.west)  * (width  - 1))
        const nomRow = Math.round((bounds.north - peak.lat) / (bounds.north - bounds.south) * (height - 1))

        let bestElev = -Infinity, bestCol = nomCol, bestRow = nomRow
        for (let dr = -SEARCH_RADIUS; dr <= SEARCH_RADIUS; dr++) {
          for (let dc = -SEARCH_RADIUS; dc <= SEARCH_RADIUS; dc++) {
            const c = Math.max(0, Math.min(width  - 1, nomCol + dc))
            const r = Math.max(0, Math.min(height - 1, nomRow + dr))
            const e = elevations[r * width + c]
            if (e > bestElev) { bestElev = e; bestCol = c; bestRow = r }
          }
        }

        // ENU world coordinates — identical formula to drawExploreCanvas
        const x_m = (bestCol / (width  - 1) - 0.5) * terrainWidth_m - pivotX_m
        const z_m = (bestRow / (height - 1) - 0.5) * terrainDepth_m - pivotZ_m
        const y_m = (bestElev - minElevation_m) * verticalExaggeration

        const [sx, sy] = project3D(x_m, y_m, z_m, theta, phi, cx, cy, scale)

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
