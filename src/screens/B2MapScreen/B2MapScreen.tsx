/**
 * B2 Map Screen — Fullscreen top-down table projection surface
 *
 * Fixed 1920×1920 layout for ceiling-mounted projector on a square table.
 * Visitors stand around all 4 sides and interact via touch control strips.
 *
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │          TOP STRIP (326px)       │
 *   ├──────┬──────────────────┬────────┤
 *   │ LEFT │   MapScreen      │ RIGHT  │
 *   │ STRIP│   (1268×1268)    │ STRIP  │
 *   │      │    + crosshair   │        │
 *   ├──────┴──────────────────┴────────┤
 *   │        BOTTOM STRIP (326px)      │
 *   └──────────────────────────────────┘
 */

import React from 'react'
import { createLogger } from '../../core/logger'
import MapScreen from '../MapScreen/MapScreen'
import ControlStrip from './ControlStrip'
import styles from './B2MapScreen.module.css'

const log = createLogger('SCREEN:B2-MAP')

const B2MapScreen: React.FC = () => {
  log.info('B2MapScreen mounted')

  return (
    <div className={styles.screen}>
      {/* Top control strip */}
      <div className={styles.topStrip}>
        <ControlStrip side="top" />
      </div>

      {/* Middle row: left strip + map + right strip */}
      <div className={styles.middleRow}>
        <div className={styles.leftStrip}>
          <ControlStrip side="left" />
        </div>

        <div className={styles.mapContainer}>
          <MapScreen exhibitMode={true} />
          {/* Crosshair overlay — target indicator at center */}
          <div className={styles.crosshair} aria-hidden="true">
            <div className={styles.crosshairH} />
            <div className={styles.crosshairV} />
            <div className={styles.crosshairDot} />
          </div>
        </div>

        <div className={styles.rightStrip}>
          <ControlStrip side="right" />
        </div>
      </div>

      {/* Bottom control strip */}
      <div className={styles.bottomStrip}>
        <ControlStrip side="bottom" />
      </div>
    </div>
  )
}

export default B2MapScreen
