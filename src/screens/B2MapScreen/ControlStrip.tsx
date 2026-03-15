/**
 * B2 Control Strip — Touch button panel for one side of the exhibit table
 *
 * Each strip has: 4 directional arrows (diamond layout), zoom +/−, SELECT.
 * Arrow directions are remapped per side so "up" always means "away from
 * the person standing at that edge of the table."
 *
 * Side rotations:
 *   bottom (0°)   — person faces north on screen
 *   top    (180°) — person faces south on screen
 *   left   (90°)  — person faces east on screen
 *   right  (-90°) — person faces west on screen
 */

import React, { useCallback, useRef, useEffect } from 'react'
import { useMapViewStore } from '../../store'
import { useLocationStore } from '../../store'
import { createLogger } from '../../core/logger'
import styles from './B2MapScreen.module.css'

const log = createLogger('B2:CONTROL-STRIP')

type Side = 'top' | 'bottom' | 'left' | 'right'

interface ControlStripProps {
  side: Side
}

// ─── Press-and-Hold Repeat ───────────────────────────────────────────────────
// First fire on press, then after 300ms delay start repeating every 80ms.
// Acceleration: speed multiplier ramps from 1× to 4× over ~2 seconds of holding.

const INITIAL_DELAY_MS = 300
const REPEAT_INTERVAL_MS = 80
const MAX_ACCEL = 4
const ACCEL_RAMP_MS = 2000  // time to reach max acceleration

// ─── Direction Mapping ───────────────────────────────────────────────────────
// Each person sees ↑↓←→ from their perspective.
// We map these to lat/lng deltas based on which table edge they're at.
//
// "Up" = away from the person (toward center and beyond)
// "Down" = toward the person
// "Left" = person's left
// "Right" = person's right

type Dir = 'up' | 'down' | 'left' | 'right'

function getDelta(side: Side, dir: Dir): { dLat: number; dLng: number } {
  // Returns unit direction — will be multiplied by panStep()
  const map: Record<Side, Record<Dir, { dLat: number; dLng: number }>> = {
    // Person at bottom edge, facing north (up on screen)
    bottom: {
      up:    { dLat:  1, dLng:  0 },  // north
      down:  { dLat: -1, dLng:  0 },  // south
      left:  { dLat:  0, dLng: -1 },  // west
      right: { dLat:  0, dLng:  1 },  // east
    },
    // Person at top edge, facing south (down on screen)
    top: {
      up:    { dLat: -1, dLng:  0 },  // south (away from them)
      down:  { dLat:  1, dLng:  0 },  // north (toward them)
      left:  { dLat:  0, dLng:  1 },  // east (their left)
      right: { dLat:  0, dLng: -1 },  // west (their right)
    },
    // Person at left edge, facing east (right on screen)
    left: {
      up:    { dLat:  0, dLng:  1 },  // east (away from them)
      down:  { dLat:  0, dLng: -1 },  // west (toward them)
      left:  { dLat:  1, dLng:  0 },  // north (their left)
      right: { dLat: -1, dLng:  0 },  // south (their right)
    },
    // Person at right edge, facing west (left on screen)
    right: {
      up:    { dLat:  0, dLng: -1 },  // west (away from them)
      down:  { dLat:  0, dLng:  1 },  // east (toward them)
      left:  { dLat: -1, dLng:  0 },  // south (their left)
      right: { dLat:  1, dLng:  0 },  // north (their right)
    },
  }
  return map[side][dir]
}

// ─── Component ───────────────────────────────────────────────────────────────

const ControlStrip: React.FC<ControlStripProps> = ({ side }) => {
  const pan = useMapViewStore((s) => s.pan)
  const panStep = useMapViewStore((s) => s.panStep)
  const zoomIn = useMapViewStore((s) => s.zoomIn)
  const zoomOut = useMapViewStore((s) => s.zoomOut)
  const setExploreLocation = useLocationStore((s) => s.setExploreLocation)

  // Track active hold timers so we can clean up
  const holdRef = useRef<{
    timeoutId: ReturnType<typeof setTimeout> | null
    intervalId: ReturnType<typeof setInterval> | null
    startTime: number
  }>({ timeoutId: null, intervalId: null, startTime: 0 })

  // Clean up on unmount
  useEffect(() => {
    return () => stopHold()
  }, [])

  const stopHold = useCallback(() => {
    const h = holdRef.current
    if (h.timeoutId !== null) { clearTimeout(h.timeoutId); h.timeoutId = null }
    if (h.intervalId !== null) { clearInterval(h.intervalId); h.intervalId = null }
    h.startTime = 0
  }, [])

  const doPan = useCallback((dir: Dir, accel: number) => {
    const step = panStep()
    const { dLat, dLng } = getDelta(side, dir)
    pan(dLat * step * accel, dLng * step * accel)
  }, [side, pan, panStep])

  const startPanHold = useCallback((dir: Dir) => {
    stopHold()
    // Fire immediately at 1× speed
    doPan(dir, 1)
    holdRef.current.startTime = Date.now()

    // After initial delay, start repeating with acceleration
    holdRef.current.timeoutId = setTimeout(() => {
      holdRef.current.intervalId = setInterval(() => {
        const elapsed = Date.now() - holdRef.current.startTime
        const accel = 1 + (MAX_ACCEL - 1) * Math.min(elapsed / ACCEL_RAMP_MS, 1)
        doPan(dir, accel)
      }, REPEAT_INTERVAL_MS)
    }, INITIAL_DELAY_MS)
  }, [doPan, stopHold])

  const doZoom = useCallback((zoomFn: () => void) => {
    stopHold()
    zoomFn()
    holdRef.current.startTime = Date.now()
    holdRef.current.timeoutId = setTimeout(() => {
      holdRef.current.intervalId = setInterval(() => {
        zoomFn()
      }, 250) // Slower repeat for zoom — 4 levels/sec
    }, INITIAL_DELAY_MS)
  }, [stopHold])

  const handleSelect = useCallback(() => {
    const { centerLat, centerLng } = useMapViewStore.getState()
    log.info('SELECT pressed', { side, lat: centerLat.toFixed(4), lng: centerLng.toFixed(4) })
    setExploreLocation(centerLat, centerLng)
  }, [side, setExploreLocation])

  // Rotation so controls face outward to the person at that edge
  const rotation: Record<Side, string> = {
    bottom: '0deg',
    top:    '180deg',
    left:   '90deg',
    right:  '-90deg',
  }

  // Shared pointer-down/up handlers for hold behavior
  const panProps = (dir: Dir) => ({
    onPointerDown: () => startPanHold(dir),
    onPointerUp: stopHold,
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
  })

  const zoomProps = (fn: () => void) => ({
    onPointerDown: () => doZoom(fn),
    onPointerUp: stopHold,
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
  })

  return (
    <div
      className={`${styles.controlStrip} ${styles[`strip_${side}`]}`}
      style={{ '--strip-rotation': rotation[side] } as React.CSSProperties}
    >
      <div className={styles.stripInner}>
        {/* Directional diamond */}
        <div className={styles.dpad}>
          <button
            className={`${styles.dpadBtn} ${styles.dpadUp}`}
            {...panProps('up')}
            aria-label={`Pan up (${side} side)`}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M16 6L26 22H6L16 6Z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`${styles.dpadBtn} ${styles.dpadLeft}`}
            {...panProps('left')}
            aria-label={`Pan left (${side} side)`}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M6 16L22 6V26L6 16Z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`${styles.dpadBtn} ${styles.dpadRight}`}
            {...panProps('right')}
            aria-label={`Pan right (${side} side)`}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M26 16L10 6V26L26 16Z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`${styles.dpadBtn} ${styles.dpadDown}`}
            {...panProps('down')}
            aria-label={`Pan down (${side} side)`}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M16 26L6 10H26L16 26Z" fill="currentColor" />
            </svg>
          </button>
        </div>

        {/* Zoom controls */}
        <div className={styles.zoomBtns}>
          <button
            className={styles.stripBtn}
            {...zoomProps(zoomIn)}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className={styles.stripBtn}
            {...zoomProps(zoomOut)}
            aria-label="Zoom out"
          >
            −
          </button>
        </div>

        {/* Select button */}
        <button
          className={`${styles.stripBtn} ${styles.selectBtn}`}
          onClick={handleSelect}
          aria-label="Select current location"
        >
          SELECT
        </button>
      </div>
    </div>
  )
}

export default ControlStrip
