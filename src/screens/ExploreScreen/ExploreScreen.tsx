/**
 * EarthContours — EXPLORE Screen  (v3.0 — Solid Three.js terrain)
 *
 * 3D terrain view with solid mesh surface. PlaneGeometry displaced by
 * elevation heightmap, vertex-colored with ocean-depth palette, lit by
 * directional + ambient lights. No more see-through contour lines.
 *
 * Navigation (desktop):
 *   Left drag        → pan across terrain
 *   Right drag       → rotate / tilt camera angle
 *   Scroll wheel     → zoom in / out
 *   Double-click     → fly to that terrain location
 *
 * Navigation (mobile / touch — Google Earth style):
 *   1 finger drag    → orbit (rotate + tilt camera angle)
 *   2 finger drag    → pan across terrain
 *   2 finger pinch   → zoom in / out
 *   2 finger twist   → rotate view (theta)
 *   Double-tap       → fly to that terrain location
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useCameraStore, useTerrainStore, useSettingsStore, useLocationStore,
} from '../../store'
import { createLogger } from '../../core/logger'
import { formatElevation } from '../../core/utils'
import { TerrainRenderer } from '../../renderer/TerrainRenderer'
import type { Peak, TerrainMeshData } from '../../core/types'
import styles from './ExploreScreen.module.css'

const log = createLogger('SCREEN:EXPLORE')

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
  const rendererRef  = useRef<TerrainRenderer | null>(null)

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

  // ── Initialize Three.js renderer ─────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const renderer = new TerrainRenderer()
    renderer.initialize(canvas)
    rendererRef.current = renderer

    // Initial size
    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      renderer.resize(rect.width, rect.height)
      setContainerSize({ w: rect.width, h: rect.height })
    }

    log.info('Three.js renderer initialized')

    return () => {
      renderer.dispose()
      rendererRef.current = null
      log.info('Three.js renderer disposed')
    }
  }, [])

  // ── Init camera when terrain loads ─────────────────────────────────────────

  useEffect(() => {
    if (!meshData) return
    const terrainWidth_m = meshData.worldWidth_km * 1000
    initOrbitCamera(terrainWidth_m)
    log.info('Camera initialised for new terrain', { terrainWidth_m })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meshData])  // intentionally omit initOrbitCamera — stable store action

  // ── Build terrain mesh when data loads or exaggeration changes ─────────────

  const lastExaggerationRef = useRef<number>(0)

  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !renderer.isReady() || !meshData) return

    if (lastExaggerationRef.current !== 0 && lastExaggerationRef.current !== verticalExaggeration) {
      // Just update vertex positions — no full rebuild
      renderer.updateExaggeration(meshData, verticalExaggeration)
    } else {
      renderer.buildTerrain(meshData, verticalExaggeration)
    }
    // Build contour lines on top of the solid mesh
    if (contourElevations.length > 0) {
      renderer.buildContourLines(meshData, contourElevations, verticalExaggeration)
    }
    lastExaggerationRef.current = verticalExaggeration
  }, [meshData, verticalExaggeration, contourElevations])

  // ── Render loop: update camera + render on every state change ──────────────

  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !renderer.isReady()) return

    renderer.updateCamera(orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ)
    renderer.render()
  }, [orbitTheta, orbitPhi, orbitRadius, orbitPanX, orbitPanZ, meshData, verticalExaggeration])

  // ── Resize observer ────────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const renderer = rendererRef.current
        if (renderer) {
          renderer.resize(rect.width, rect.height)
          renderer.render()
        }
        setContainerSize({ w: rect.width, h: rect.height })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

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

      const isTouch = e.pointerType === 'touch'
      if (isTouch || isRightClickRef.current || e.buttons === 2) {
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

  // ── Double-click: fly to terrain point (raycast) ───────────────────────────

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current
    const renderer = rendererRef.current
    if (!container || !renderer || !meshData) return

    const rect = container.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    const hit = renderer.raycastTerrain(sx, sy, rect.width, rect.height)
    if (hit) {
      const tw = renderer.getTerrainWidth()
      const td = renderer.getTerrainDepth()
      if (tw > 0 && td > 0) {
        setOrbitPan(hit.x / tw, hit.z / td)
        log.debug('Fly-to raycast hit', {
          x: hit.x.toFixed(0), z: hit.z.toFixed(0),
          panX: (hit.x / tw).toFixed(3),
          panZ: (hit.z / td).toFixed(3),
        })
      }
    }
  }, [meshData, setOrbitPan])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // ── Location pin screen position ───────────────────────────────────────────

  const locationPinScreen = useMemo((): { sx: number; sy: number } | null => {
    const renderer = rendererRef.current
    if (!meshData || !containerSize.w || mode !== 'exploring' || !renderer) return null

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

    return renderer.projectToScreen(
      meshData, c, r, elev, verticalExaggeration,
      containerSize.w, containerSize.h,
    )
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

        {showPeakLabels && containerSize.w > 0 && rendererRef.current && (
          <div className={styles.peakLabelsLayer}>
            <PeakLabels3D
              peaks={peaks}
              meshData={meshData}
              verticalExaggeration={verticalExaggeration}
              containerW={containerSize.w}
              containerH={containerSize.h}
              units={units}
              renderer={rendererRef.current}
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
              <span className={styles.controlsHintKey}>1 finger</span>
              <span className={styles.controlsHintDesc}>Rotate &amp; tilt</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>2 fingers</span>
              <span className={styles.controlsHintDesc}>Pan &amp; zoom</span>
            </div>
            <div className={styles.controlsHintRow}>
              <span className={styles.controlsHintKey}>Double-tap</span>
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
 * HTML overlay that renders peak labels projected via the Three.js camera.
 * Uses TerrainRenderer.projectToScreen() so labels stay locked to the
 * terrain mesh at all zoom/pan levels.
 */
const PeakLabels3D: React.FC<{
  peaks: Peak[]
  meshData: TerrainMeshData
  verticalExaggeration: number
  containerW: number
  containerH: number
  units: 'imperial' | 'metric'
  renderer: TerrainRenderer
}> = ({ peaks, meshData, verticalExaggeration, containerW, containerH, units, renderer }) => {
  const { minElevation_m, bounds, elevations, width, height } = meshData

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

        const screen = renderer.projectToScreen(
          meshData, bestCol, bestRow, bestElev, verticalExaggeration,
          containerW, containerH,
        )
        if (!screen) return null

        const { sx, sy } = screen
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
