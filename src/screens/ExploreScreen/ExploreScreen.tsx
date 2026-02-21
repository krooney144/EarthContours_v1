/**
 * EarthContours — EXPLORE Screen
 *
 * 3D orbit view showing contour lines only — no filled terrain mesh.
 * Like looking at a physical topographic model from above and around.
 *
 * Key behaviors:
 * - Drag to orbit (rotate + tilt)
 * - Auto-rotates slowly after 3 seconds of idle
 * - Peak labels float above terrain
 * - Elevation legend on right side
 * - Contour lines color-coded from dark (low) to light (high)
 *
 * In Session 2: Three.js renderer with real WebGL contour lines.
 * For MVP: SVG-based simulated contour view that responds to orbit drag.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCameraStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import { formatElevation, lerpColor } from '../../core/utils'
import { PALETTE } from '../../core/constants'
import type { Peak } from '../../core/types'
import styles from './ExploreScreen.module.css'

const log = createLogger('SCREEN:EXPLORE')

// ─── Main Component ───────────────────────────────────────────────────────────

const ExploreScreen: React.FC = () => {
  const {
    orbitTheta, orbitPhi, orbitRadius,
    autoRotating, lastInteractionTime,
    applyOrbitDrag, recordOrbitInteraction, tickAutoRotate,
  } = useCameraStore()
  const { peaks, meshData, contourElevations, activeRegion } = useTerrainStore()
  const { units, showPeakLabels, verticalExaggeration } = useSettingsStore()

  const canvasRef = useRef<HTMLDivElement>(null)
  const dragState = useRef({ isDragging: false, lastX: 0, lastY: 0 })
  const animFrameRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(performance.now())
  const [showHint, setShowHint] = useState(true)

  log.debug('ExploreScreen render', {
    theta: orbitTheta.toFixed(3),
    phi: orbitPhi.toFixed(3),
    autoRotating,
    contourCount: contourElevations.length,
  })

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

  // ── Drag handlers ─────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    canvasRef.current?.setPointerCapture(e.pointerId)
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
    canvasRef.current?.releasePointerCapture(e.pointerId)
    dragState.current.isDragging = false
    log.debug('Orbit drag end')
  }, [])

  // ── Contour line rendering (MVP SVG simulation) ───────────────────────────

  /**
   * For the MVP, we draw contour lines as SVG ellipses that simulate the
   * view of a 3D terrain from an orbiting camera.
   *
   * In Session 2: Three.js draws actual 3D contour lines on a WebGL canvas.
   *
   * The simulation uses the orbit angles to:
   * - Tilt the ellipses (phi → vertical compression)
   * - Rotate them (theta → horizontal rotation of the mountain shape)
   * - Offset them (simulating the 3D position)
   */

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
  const elevRange = maxElevation_m - minElevation_m

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
        ref={canvasRef}
        className={styles.canvasArea}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        role="application"
        aria-label="3D terrain view — drag to orbit"
      >
        <ContourTerrain
          theta={orbitTheta}
          phi={orbitPhi}
          contourElevations={contourElevations}
          minElev={minElevation_m}
          maxElev={maxElevation_m}
          verticalExaggeration={verticalExaggeration}
        />

        {/* Peak labels */}
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

interface ContourTerrainProps {
  theta: number
  phi: number
  contourElevations: number[]
  minElev: number
  maxElev: number
  verticalExaggeration: number
}

/**
 * SVG-based simulated contour terrain for MVP.
 * Renders ellipses representing each contour elevation level.
 * The ellipses are skewed by theta/phi to simulate 3D orbit viewing.
 *
 * In Session 2, this is replaced by a Three.js WebGL canvas.
 */
const ContourTerrain: React.FC<ContourTerrainProps> = ({
  theta, phi, contourElevations, minElev, maxElev, verticalExaggeration,
}) => {
  const elevRange = maxElev - minElev

  // View projection parameters based on orbit angles
  const cosTheta = Math.cos(theta)
  const sinTheta = Math.sin(theta)
  const cosPhi = Math.cos(phi)

  // Vertical compression based on viewing angle (phi)
  // phi near 0 = top-down (very compressed), phi near π/2 = side-on (full height)
  const verticalCompress = Math.sin(phi) * 0.8 + 0.1

  return (
    <svg
      viewBox="0 0 400 400"
      style={{ width: '100%', height: '100%' }}
      aria-hidden="true"
    >
      {/* Background */}
      <rect width="400" height="400" fill="var(--ec-bg-primary)" />

      {/* Draw contour lines from bottom (low) to top (high) */}
      {contourElevations.map((elev, i) => {
        const t = (elev - minElev) / elevRange  // 0=low, 1=high
        const color = lerpColor(PALETTE.abyss, PALETTE.foam, t)

        // Size of this contour's ellipse:
        // Higher contours are smaller (mountain narrows toward peak)
        // Apply vertical exaggeration to spread them out vertically
        const baseRadius = 150 * (1 - t * 0.7 * (verticalExaggeration / 2))

        // Horizontal radius varies with theta (rotation)
        const rx = baseRadius * (0.6 + 0.4 * Math.abs(cosTheta))

        // Vertical radius is compressed by viewing angle
        const ry = baseRadius * verticalCompress

        // Center point — higher contours shifted up on screen
        const cx = 200 + baseRadius * 0.15 * sinTheta  // Slight rotation offset
        const cy = 220 - t * 120 * verticalCompress * verticalExaggeration

        // Opacity — higher contours slightly more visible
        const opacity = 0.35 + t * 0.45

        // Animation offset for contour pulse effect
        const animationDelay = `${i * 0.1}s`

        return (
          <ellipse
            key={elev}
            cx={cx}
            cy={cy}
            rx={Math.max(rx, 2)}
            ry={Math.max(ry * 0.35, 1)}
            fill="none"
            stroke={color}
            strokeWidth={elev % 500 === 0 ? 2 : 1}  // Index contours thicker
            opacity={opacity}
            style={{
              animation: `contour-pulse 3s ease-in-out ${animationDelay} infinite`,
            }}
          />
        )
      })}

      {/* Peak indicator dots (rough positions) */}
      <circle cx="200" cy={220 - 115 * verticalCompress} r="4" fill={PALETTE.foam} opacity="0.8" />
      <circle cx="200" cy={220 - 115 * verticalCompress} r="8" fill="none" stroke={PALETTE.glow} strokeWidth="1" opacity="0.4" />
    </svg>
  )
}

/** Peak labels positioned in 3D-projected space */
const PeakLabels3D: React.FC<{
  peaks: Peak[]
  theta: number
  phi: number
  minElev: number
  maxElev: number
  units: 'imperial' | 'metric'
}> = ({ peaks, theta, phi, minElev, maxElev, units }) => {
  const elevRange = maxElev - minElev

  // Show only the top 5 peaks
  const topPeaks = [...peaks]
    .sort((a, b) => b.elevation_m - a.elevation_m)
    .slice(0, 5)

  return (
    <>
      {topPeaks.map((peak, i) => {
        const t = (peak.elevation_m - minElev) / elevRange

        // Position peaks in a rough arc
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
