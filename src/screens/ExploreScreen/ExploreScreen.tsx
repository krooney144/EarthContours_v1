/**
 * EarthContours — EXPLORE Screen
 *
 * 3D orbit view showing contour lines extracted from real elevation data
 * using the marching squares algorithm, projected into an orthographic 3D view.
 *
 * Key behaviors:
 * - Drag to orbit (rotate + tilt)
 * - Auto-rotates slowly after 3 seconds of idle
 * - Peak labels float above terrain
 * - Elevation legend on right side
 * - Contour lines color-coded from dark (low) to bright (high)
 *
 * Rendering pipeline:
 * 1. Marching squares extracts line segments from the elevation grid for each
 *    contour level
 * 2. Each segment's 3D position is projected using the orbit camera angles
 *    (theta = horizontal rotation, phi = vertical tilt)
 * 3. Segments are drawn on a canvas with color and opacity based on elevation
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCameraStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import { formatElevation } from '../../core/utils'
import { PALETTE } from '../../core/constants'
import type { Peak, TerrainMeshData } from '../../core/types'
import styles from './ExploreScreen.module.css'

const log = createLogger('SCREEN:EXPLORE')

// ─── Marching Squares ─────────────────────────────────────────────────────────

/**
 * Marching squares edge table.
 * Each case (0-15) maps to a list of edge pairs [fromEdge, toEdge].
 * Edges are: 0=top, 1=right, 2=bottom, 3=left
 * Case is built from corners: bit0=TL>t, bit1=TR>t, bit2=BR>t, bit3=BL>t
 */
const MS_EDGES: Array<Array<[number, number]>> = [
  [],              // 0000 - all below
  [[3, 0]],        // 0001 - TL above
  [[0, 1]],        // 0010 - TR above
  [[3, 1]],        // 0011 - TL+TR above
  [[1, 2]],        // 0100 - BR above
  [[3, 0],[1, 2]], // 0101 - TL+BR (saddle — pick consistent case)
  [[0, 2]],        // 0110 - TR+BR above
  [[3, 2]],        // 0111 - TL+TR+BR above
  [[2, 3]],        // 1000 - BL above
  [[2, 0]],        // 1001 - TL+BL above
  [[0, 1],[2, 3]], // 1010 - TR+BL (saddle)
  [[2, 1]],        // 1011 - TL+TR+BL above
  [[1, 3]],        // 1100 - BR+BL above
  [[1, 0]],        // 1101 - TL+BR+BL above
  [[0, 3]],        // 1110 - TR+BR+BL above
  [],              // 1111 - all above
]

interface Segment {
  x1: number; y1: number  // grid-normalized [0,1]
  x2: number; y2: number
}

/**
 * Extract line segments for a given elevation threshold from the mesh.
 * Returns segments in normalized grid space (0 to 1 for both axes).
 */
function marchingSquares(elevations: Float32Array, w: number, h: number, threshold: number): Segment[] {
  const segments: Segment[] = []

  for (let row = 0; row < h - 1; row++) {
    for (let col = 0; col < w - 1; col++) {
      const tl = elevations[row * w + col]
      const tr = elevations[row * w + col + 1]
      const br = elevations[(row + 1) * w + col + 1]
      const bl = elevations[(row + 1) * w + col]

      // Build case index
      const caseIdx =
        ((tl > threshold) ? 1 : 0) |
        ((tr > threshold) ? 2 : 0) |
        ((br > threshold) ? 4 : 0) |
        ((bl > threshold) ? 8 : 0)

      const edgePairs = MS_EDGES[caseIdx]
      if (edgePairs.length === 0) continue

      // Normalized cell bounds [0,1]
      const x0 = col / (w - 1)
      const x1 = (col + 1) / (w - 1)
      const y0 = row / (h - 1)
      const y1 = (row + 1) / (h - 1)

      // Linear interpolation factor for each edge crossing
      const tTop    = tl !== tr ? (threshold - tl) / (tr - tl) : 0.5
      const tRight  = tr !== br ? (threshold - tr) / (br - tr) : 0.5
      const tBottom = bl !== br ? (threshold - bl) / (br - bl) : 0.5
      const tLeft   = tl !== bl ? (threshold - tl) / (bl - tl) : 0.5

      // Edge midpoint positions [gx, gy] in normalized grid space
      // edge 0=top, 1=right, 2=bottom, 3=left
      const edgePts: Array<[number, number]> = [
        [x0 + tTop * (x1 - x0), y0],          // top edge
        [x1, y0 + tRight * (y1 - y0)],         // right edge
        [x0 + tBottom * (x1 - x0), y1],        // bottom edge
        [x0, y0 + tLeft * (y1 - y0)],          // left edge
      ]

      for (const [fromEdge, toEdge] of edgePairs) {
        const [px1, py1] = edgePts[fromEdge]
        const [px2, py2] = edgePts[toEdge]
        segments.push({ x1: px1, y1: py1, x2: px2, y2: py2 })
      }
    }
  }

  return segments
}

// ─── 3D Projection ────────────────────────────────────────────────────────────

/**
 * Project a 3D terrain point (gx, gy, gz) to 2D screen coordinates.
 *
 * Coordinate system:
 *   gx: grid X, centered at 0, range [-0.5, 0.5] (east/west)
 *   gy: elevation, range [0, vertExag * elevScale]
 *   gz: grid Z, centered at 0, range [-0.5, 0.5] (south = positive z)
 *
 * Camera orbit:
 *   theta: rotation around Y axis (horizontal orbit)
 *   phi: angle from zenith (0 = top-down, π/2 = side view)
 */
function project3D(
  gx: number, gy: number, gz: number,
  theta: number, phi: number,
  cx: number, cy: number,
  scale: number,
): [number, number] {
  // Step 1: Rotate around Y by theta
  const rx = gx * Math.cos(theta) + gz * Math.sin(theta)
  const rz = -gx * Math.sin(theta) + gz * Math.cos(theta)
  const ry = gy

  // Step 2: Rotate around X by phi (tilt)
  const ry2 = ry * Math.cos(phi) - rz * Math.sin(phi)
  const rx2 = rx  // x unchanged by X rotation

  // Orthographic projection
  const sx = cx + rx2 * scale
  const sy = cy - ry2 * scale  // screen y flipped

  return [sx, sy]
}

// ─── Canvas Draw ──────────────────────────────────────────────────────────────

function drawExploreCanvas(
  canvas: HTMLCanvasElement,
  mesh: TerrainMeshData,
  contourElevations: number[],
  theta: number,
  phi: number,
  verticalExaggeration: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const W = canvas.width
  const H = canvas.height
  const { elevations, width, height, minElevation_m, maxElevation_m } = mesh
  const elevRange = maxElevation_m - minElevation_m || 1

  // Clear background
  ctx.fillStyle = '#020e18'
  ctx.fillRect(0, 0, W, H)

  // Projection parameters
  const cx = W / 2
  const cy = H / 2 + H * 0.05  // slightly below center for better framing
  const scale = Math.min(W, H) * 0.62

  // Elevation scale: max elevation maps to 0.25 units, then multiplied by exaggeration
  const elevScale = 0.25 * verticalExaggeration

  // Subtle ground plane ellipse (shows the base of the terrain)
  const groundY = cy + (Math.sin(phi) * scale * 0.05)
  const groundRX = scale * 0.52
  const groundRY = scale * 0.52 * Math.abs(Math.cos(phi)) * 0.35 + 4
  ctx.beginPath()
  ctx.ellipse(cx, groundY, groundRX, groundRY, 0, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(18, 75, 107, 0.4)'
  ctx.lineWidth = 1
  ctx.stroke()

  // Draw contour levels from lowest to highest (painter's algorithm)
  for (const elev of contourElevations) {
    const t = (elev - minElevation_m) / elevRange  // 0=low, 1=high

    // Color: interpolate from dark ocean blue to bright foam
    const r = Math.round(14 + t * (167 - 14))
    const g = Math.round(75 + t * (221 - 75))
    const b = Math.round(107 + t * (229 - 107))
    const opacity = 0.3 + t * 0.55

    ctx.strokeStyle = `rgba(${r},${g},${b},${opacity})`
    ctx.lineWidth = elev % 500 === 0 ? 1.5 : 0.8  // Index contours thicker

    // Get segments from marching squares
    const segments = marchingSquares(elevations, width, height, elev)

    // Map elevation to 3D Y (normalized to [0, elevScale])
    const gy = (t * elevScale)

    ctx.beginPath()
    for (const seg of segments) {
      // Convert from grid [0,1] to centered [-0.5, 0.5]
      const gx1 = seg.x1 - 0.5
      const gz1 = seg.y1 - 0.5
      const gx2 = seg.x2 - 0.5
      const gz2 = seg.y2 - 0.5

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
  })
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ExploreScreen: React.FC = () => {
  const {
    orbitTheta, orbitPhi, orbitRadius,
    autoRotating, lastInteractionTime,
    applyOrbitDrag, recordOrbitInteraction, tickAutoRotate,
  } = useCameraStore()
  const { peaks, meshData, contourElevations, activeRegion } = useTerrainStore()
  const { units, showPeakLabels, verticalExaggeration } = useSettingsStore()

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragState = useRef({ isDragging: false, lastX: 0, lastY: 0 })
  const animFrameRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(performance.now())
  const [showHint, setShowHint] = useState(true)

  log.debug('ExploreScreen render', {
    theta: orbitTheta.toFixed(3),
    phi: orbitPhi.toFixed(3),
    autoRotating,
    contourCount: contourElevations.length,
    hasMesh: !!meshData,
  })

  // ── Canvas draw effect ────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !meshData || contourElevations.length === 0) return

    // Size canvas to container on first draw
    const container = containerRef.current
    if (container) {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.round(rect.width * dpr)
        canvas.height = Math.round(rect.height * dpr)
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.scale(dpr, dpr)
      }
    }

    drawExploreCanvas(canvas, meshData, contourElevations, orbitTheta, orbitPhi, verticalExaggeration)
  }, [orbitTheta, orbitPhi, meshData, contourElevations, verticalExaggeration])

  // ── Auto-rotate animation loop ────────────────────────────────────────────

  useEffect(() => {
    log.info('ExploreScreen mounted — starting animation loop')

    function animate(timestamp: number) {
      const deltaTime_s = (timestamp - lastTimeRef.current) / 1000
      lastTimeRef.current = timestamp

      tickAutoRotate(deltaTime_s)

      animFrameRef.current = requestAnimationFrame(animate)
    }

    animFrameRef.current = requestAnimationFrame(animate)

    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current)
        log.debug('ExploreScreen animation loop stopped')
      }
    }
  }, [tickAutoRotate])

  // ── Resize observer ───────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && meshData && contourElevations.length > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.round(rect.width * dpr)
        canvas.height = Math.round(rect.height * dpr)
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.scale(dpr, dpr)
          drawExploreCanvas(canvas, meshData, contourElevations, orbitTheta, orbitPhi, verticalExaggeration)
        }
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [meshData, contourElevations, orbitTheta, orbitPhi, verticalExaggeration])

  // ── Drag handlers ─────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    containerRef.current?.setPointerCapture(e.pointerId)
    dragState.current = { isDragging: true, lastX: e.clientX, lastY: e.clientY }
    recordOrbitInteraction()
    setShowHint(false)
    log.debug('Orbit drag start', { x: e.clientX, y: e.clientY })
  }, [recordOrbitInteraction])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState.current.isDragging) return
    const deltaX = e.clientX - dragState.current.lastX
    const deltaY = e.clientY - dragState.current.lastY
    dragState.current.lastX = e.clientX
    dragState.current.lastY = e.clientY
    applyOrbitDrag(deltaX, deltaY)
  }, [applyOrbitDrag])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    containerRef.current?.releasePointerCapture(e.pointerId)
    dragState.current.isDragging = false
    log.debug('Orbit drag end')
  }, [])

  if (!meshData) {
    return (
      <div className={styles.screen}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ec-text-muted)', fontFamily: 'var(--font-display)', letterSpacing: '0.1em' }}>
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
        <div className={`${styles.autoRotateBadge} ${autoRotating ? styles.visible : ''}`} aria-live="polite">
          <div className={styles.autoRotateDot} aria-hidden="true" />
          AUTO-ROTATING
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
        role="application"
        aria-label="3D terrain view — drag to orbit"
      >
        <canvas
          ref={canvasRef}
          className={styles.terrainCanvas}
          aria-hidden="true"
        />

        {/* Peak labels in 3D-projected space */}
        {showPeakLabels && (
          <div className={styles.peakLabelsLayer}>
            <PeakLabels3D
              peaks={peaks}
              theta={orbitTheta}
              phi={orbitPhi}
              minElev={minElevation_m}
              maxElev={maxElevation_m}
              units={units}
            />
          </div>
        )}

        <div className={`${styles.hint} ${!showHint ? styles.hidden : ''}`} aria-hidden="true">
          ← Drag to orbit →
        </div>
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

// ─── Sub-Components ───────────────────────────────────────────────────────────

const PeakLabels3D: React.FC<{
  peaks: Peak[]
  theta: number
  phi: number
  minElev: number
  maxElev: number
  units: 'imperial' | 'metric'
}> = ({ peaks, theta, phi, minElev, maxElev, units }) => {
  const elevRange = maxElev - minElev || 1

  const topPeaks = [...peaks]
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 5)

  return (
    <>
      {topPeaks.map((peak, i) => {
        const t = (peak.elevation_m - minElev) / elevRange

        const angle = (i / topPeaks.length) * Math.PI * 0.6 - 0.3 + theta * 0.1
        const leftPercent = 30 + Math.cos(angle) * 30
        const topPercent = 20 + (1 - t) * 35 + Math.sin(phi) * 10

        return (
          <div
            key={peak.id}
            className={styles.peakLabel3D}
            style={{ left: `${leftPercent}%`, top: `${topPercent}%` }}
          >
            <div className={styles.peakLabelCard}>
              <span className={styles.peakLabelName}>{peak.name}</span>
              <span className={styles.peakLabelElev}>{formatElevation(peak.elevation_m, units)}</span>
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
