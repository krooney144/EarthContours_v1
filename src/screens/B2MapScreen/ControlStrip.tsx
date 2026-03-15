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

import React, { useCallback } from 'react'
import { useMapViewStore } from '../../store'
import { useLocationStore } from '../../store'
import { createLogger } from '../../core/logger'
import styles from './B2MapScreen.module.css'

const log = createLogger('B2:CONTROL-STRIP')

type Side = 'top' | 'bottom' | 'left' | 'right'

interface ControlStripProps {
  side: Side
}

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

  const handlePan = useCallback((dir: Dir) => {
    const step = panStep()
    const { dLat, dLng } = getDelta(side, dir)
    pan(dLat * step, dLng * step)
    log.debug('Pan', { side, dir, step: step.toFixed(4) })
  }, [side, pan, panStep])

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
            onClick={() => handlePan('up')}
            aria-label={`Pan up (${side} side)`}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M16 6L26 22H6L16 6Z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`${styles.dpadBtn} ${styles.dpadLeft}`}
            onClick={() => handlePan('left')}
            aria-label={`Pan left (${side} side)`}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M6 16L22 6V26L6 16Z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`${styles.dpadBtn} ${styles.dpadRight}`}
            onClick={() => handlePan('right')}
            aria-label={`Pan right (${side} side)`}
          >
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <path d="M26 16L10 6V26L26 16Z" fill="currentColor" />
            </svg>
          </button>
          <button
            className={`${styles.dpadBtn} ${styles.dpadDown}`}
            onClick={() => handlePan('down')}
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
            onClick={zoomIn}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className={styles.stripBtn}
            onClick={zoomOut}
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
