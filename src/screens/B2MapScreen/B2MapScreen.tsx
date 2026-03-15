/**
 * B2 Map Screen — Fullscreen top-down map projection surface
 *
 * Will render the MapScreen (flat DEM) in center of a 1920×1920 square
 * with touch control zones on all 4 sides for table projection.
 * Currently a placeholder to confirm routing works.
 */

import React from 'react'
import { Link } from 'react-router-dom'
import { createLogger } from '../../core/logger'
import styles from './B2MapScreen.module.css'

const log = createLogger('SCREEN:B2-MAP')

const B2MapScreen: React.FC = () => {
  log.info('B2MapScreen mounted')

  return (
    <div className={styles.screen}>
      <div className={styles.title}>B2 Map</div>
      <div className={styles.subtitle}>Top-Down Table Projection — 1920×1920</div>
      <div className={styles.route}>/b2-map</div>
      <Link to="/" className={styles.backLink}>← Back to App</Link>
    </div>
  )
}

export default B2MapScreen
