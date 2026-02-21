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
 * │ HUD: HDG | LAT | LONG | ELEV | EYE         │
 * └─────────────────────────────────────────────┘
 *
 * Key behaviors:
 * - Drag left/right → changes heading (which direction you face)
 * - Drag up/down → changes pitch (look up/down)
 * - Height slider → changes eye height above ground
 * - Peak labels always appear ABOVE the peak (card → line → dot, top to bottom)
 *
 * In Session 2: Three.js renderer replaces the CSS terrain background.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useCameraStore, useLocationStore, useTerrainStore, useSettingsStore } from '../../store'
import { createLogger } from '../../core/logger'
import { COMPASS_DIRECTIONS, COMPASS_ITEM_WIDTH, MAX_HEIGHT_M, MIN_HEIGHT_M } from '../../core/constants'
import { formatElevation, calculateBearing, haversineDistance, headingToCompass, normalizeAngle, clamp, metersToFeet } from '../../core/utils'
import type { Peak } from '../../core/types'
import styles from './ScanScreen.module.css'

const log = createLogger('SCREEN:SCAN')

// ─── Types ────────────────────────────────────────────────────────────────────

interface DragState {
  isDragging: boolean
  lastX: number
  lastY: number
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ScanScreen: React.FC = () => {
  const { heading_deg, pitch_deg, height_m, applyARDrag, setHeightFromSlider } = useCameraStore()
  const { activeLat, activeLng } = useLocationStore()
  const { peaks, meshData } = useTerrainStore()
  const { units, showPeakLabels, showContourLines } = useSettingsStore()

  const viewportRef = useRef<HTMLDivElement>(null)
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
  })

  // ── Drag Handlers (viewport) ──────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Capture the pointer so we get move events even if cursor leaves the element
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
    e.stopPropagation()  // Don't trigger viewport drag
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

    // Distance dragged (negative = up = higher elevation)
    const deltaY = e.clientY - sliderDragRef.current.startY

    // Convert pixel delta to height change
    // Full slider height = full range (MIN to MAX height)
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

  /**
   * Calculate the pixel offset for the compass strip.
   * We render 3 loops of the 16 directions (48 items total) for seamless wrapping.
   * The center of the visible strip should show the current heading.
   *
   * Formula: offset = (center of viewport) - (pixel position of current heading)
   * Since we're using transform:translateX from left:0, we adjust so the
   * current heading is always under the center notch.
   */
  const compassOffset = (() => {
    // Each direction is 22.5 degrees. Find which item index corresponds to heading.
    const headingIndex = heading_deg / 22.5  // 0–16 (fractional)
    // Start from the second loop (offset by 16 items) to allow wrapping
    const centerItemIndex = headingIndex + 16
    // Pixel offset to center this item
    // We want the center of our rendered strip to align with the viewport center
    // The strip starts at left:0, so we translate left by (centerItemIndex * width - viewport/2)
    return -(centerItemIndex * COMPASS_ITEM_WIDTH)
  })()

  // ── Peak Label Positions ──────────────────────────────────────────────────

  /**
   * Determine which peaks are visible from the current viewpoint and
   * calculate their 2D screen positions.
   *
   * For MVP: We use a simplified bearing + angular distance model.
   * A peak is "visible" if its bearing is within ~60° of the current heading.
   * Its horizontal position is proportional to the angle offset from heading.
   * Its vertical position is simplified based on distance and pitch.
   *
   * Session 2 will project peaks from 3D world space via Three.js camera matrices.
   */
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

      // Angular difference from current heading
      let angleDiff = bearing - heading_deg
      // Normalize to -180 to +180
      while (angleDiff > 180) angleDiff -= 360
      while (angleDiff < -180) angleDiff += 360

      return { peak, bearing, distance_km, angleDiff }
    })
    .filter(({ angleDiff, distance_km }) =>
      Math.abs(angleDiff) < 65 && distance_km < 120
    )
    .slice(0, 6)  // Show max 6 peaks to avoid clutter

  return (
    <div className={styles.screen}>
      {/* ── Compass Strip ────────────────────────────────────────────────── */}
      <div className={styles.compassStrip} role="img" aria-label={`Compass showing ${headingToCompass(heading_deg)} at ${Math.round(heading_deg)}°`}>
        <div className={styles.compassNotch} aria-hidden="true" />

        {/* Heading degrees display */}
        <div className={styles.headingDegrees} aria-hidden="true">
          {Math.round(heading_deg)}°
        </div>

        {/* The scrolling track — 3 loops for seamless wrap */}
        <div
          className={styles.compassTrack}
          style={{
            transform: `translateX(calc(50vw + ${compassOffset}px))`,
          }}
          aria-hidden="true"
        >
          {/* Render 3 full loops so the strip wraps seamlessly */}
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
        {/* Simulated terrain background (replaced by Three.js in Session 2) */}
        <div
          className={styles.terrainBg}
          style={{
            // Subtle parallax — terrain shifts slightly with pitch
            backgroundPositionY: `${50 + pitch_deg * 0.5}%`,
          }}
          aria-hidden="true"
        />

        {/* Contour line overlay (simplified for MVP) */}
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

        {/* Drag hint — fades after first interaction */}
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
          {/* Fill — proportion of current height in range */}
          <div
            className={styles.heightSliderFill}
            style={{
              height: `${((height_m - MIN_HEIGHT_M) / (MAX_HEIGHT_M - MIN_HEIGHT_M)) * 100}%`,
            }}
            aria-hidden="true"
          />
          {/* Draggable thumb */}
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
  angleDiff: number    // Angular offset from heading (-65 to +65)
  distance_km: number
  bearing: number
  units: 'imperial' | 'metric'
}

/**
 * Individual peak label.
 * Layout (top to bottom): Card → Line → Dot
 * The label is positioned horizontally by angleDiff and vertically
 * by a simplified distance-based projection.
 */
const PeakLabelComponent: React.FC<PeakLabelProps> = ({
  peak, angleDiff, distance_km, bearing, units,
}) => {
  const log2 = createLogger('COMPONENT:PEAK_LABEL')

  // Horizontal position: center of screen + angle offset
  // ±65° maps to roughly ±50% of screen width
  const leftPercent = 50 + (angleDiff / 65) * 45

  // Vertical position: closer peaks appear lower (simpler approach for MVP)
  // Far peaks appear near the horizon (top), close peaks appear lower
  const maxDist = 120
  const topPercent = 15 + (1 - Math.min(distance_km, maxDist) / maxDist) * 35

  log2.debug('Peak label position', {
    name: peak.name,
    angleDiff: angleDiff.toFixed(1),
    leftPercent: leftPercent.toFixed(1),
    topPercent: topPercent.toFixed(1),
  })

  return (
    <div
      className={styles.peakLabel}
      style={{
        left: `${leftPercent}%`,
        top: `${topPercent}%`,
      }}
      role="img"
      aria-label={`${peak.name}, ${formatElevation(peak.elevation_m, units)}, ${Math.round(distance_km)} km away`}
    >
      {/* Card at top */}
      <div className={styles.peakCard}>
        <span className={styles.peakName}>{peak.name}</span>
        <span className={styles.peakElev}>{formatElevation(peak.elevation_m, units)}</span>
        <span className={styles.peakBearing}>{headingToCompass(bearing)} · {distance_km.toFixed(0)} km</span>
      </div>
      {/* Vertical line pointing DOWN */}
      <div className={styles.peakLine} aria-hidden="true" />
      {/* Glowing dot at the bottom (terrain level) */}
      <div className={styles.peakDot} aria-hidden="true" />
    </div>
  )
}

/** Decorative contour lines drawn across the terrain viewport */
const ContourOverlay: React.FC<{ heading: number; pitch: number }> = ({ heading, pitch }) => {
  // Simplified contour lines — in Session 2 these come from Three.js
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

/** HUD readout bar at the bottom of the scan screen */
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
        <span className={styles.hudLabel}>EYE</span>
        <span className={styles.hudValue}>{eyeStr}</span>
      </div>
    </div>
  )
}

/** Get a representative ground elevation from the terrain mesh center */
function getGroundElevation(elevations: Float32Array, width: number, height: number): number {
  // Sample the center of the terrain grid
  const centerIdx = Math.floor(height / 2) * width + Math.floor(width / 2)
  return elevations[centerIdx] ?? 2400  // Default to ~Colorado base elevation
}

export default ScanScreen
